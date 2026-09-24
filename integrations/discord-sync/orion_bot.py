"""
orion_bot.py  --  King Orion's Realm  --  Discord Party Bot
=============================================================
Run with:  python orion_bot.py

COMMANDS:
  !join          -- join the party
  !leave         -- leave the party
  !status        -- show party HP, roster, journal
  !profile       -- show YOUR personal profile as Orion knows you
  !newgame       -- (admin) start a fresh adventure
  !revive @name  -- (admin) revive a fallen member
  !reviveall     -- (admin) revive everyone
  !ai [on/off]   -- (admin) pause/resume AI responses
  !help          -- list all commands

  Anything else typed in the game channel by a party member = game action.
"""

import discord
from discord.ext import commands, tasks
from datetime import datetime, timedelta
from pathlib import Path
import asyncio
import copy
import json
import sys
import time

import discord_config as cfg
import party_manager as pm
import bot_ai_handler as ai
import player_profiles as pp
import combat_engine
import input_sanitizer as sanitizer
import codex_bridge
import world_db
import world_rules

# ===========================================================================
# BOT SETUP
# ===========================================================================

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix=cfg.COMMAND_PREFIX, intents=intents, help_command=None)

# Runtime state -- all loaded from disk on startup
_state        = {}
_roster       = {}
_chars        = {}
_profiles     = {}
_chat_history = []   # <-- NOW persisted to disk every turn
_ai_enabled   = True
_turn_counter = 0    # tracks when to run profile extraction
_runtime_loaded = False
_queued_turns = 0
_queue_guard = asyncio.Lock()
MAX_QUEUED_TURNS = 4

# Real bug found 2026-08-26 (security review): discord_config.py defines
# ACTION_COOLDOWN_SECONDS with a comment saying it prevents spam, but this
# bot never actually checked it - the single-player game_engine.py has its
# own working check_rate_limit(), but orion_bot.py never imports or calls
# it. Every message fired a real AI inference call + a disk write with no
# rate limit at all. Fixed with a small self-contained check here (mirrors
# game_engine.py's pattern) rather than importing game_engine, which is
# coupled to the single-player SQLite/vector-memory system this bot
# doesn't use.
_last_action_at = {}   # {user_id: monotonic timestamp}

# Real bug found 2026-09-02 (Alex live-played into it): ACTION_COOLDOWN_SECONDS
# is 5s, but a real turn (AI narration, now up to a 700-token/90s budget for
# "thinking" models - see bot_ai_handler.py) can take 15-90s. Nothing stopped
# a second action - from the same player after their cooldown cleared, or from
# any other party member - from starting a second concurrent turn while the
# first was still in flight. Each turn mutates the same global _state/_roster/
# _chat_history with no lock, so two in-flight turns could interleave and the
# one that finished last would silently clobber the other's HP/XP/journal
# changes; on the mechanical side, combat_engine.resolve_combat_turn() runs
# synchronously before the AI call, so several stacked turns could land several
# unintended enemy hits before the player ever saw the first reply. This lock
# makes turn processing single-flight: only one turn is ever mid-resolution at
# a time, and a second attempt is rejected with a friendly message rather than
# racing.
_turn_lock = asyncio.Lock()

# ===========================================================================
# HEALTH HEARTBEAT -- a small status file the Orion Command Center reads so
# Alex can see whether the bot is actually online, watching the right
# channel, and replying, without opening this console window or Discord
# itself. Added 2026-09-02 alongside the Command Center calibration pass -
# every other signal that night (config, AI reachability, turn latency,
# missing permissions) only ever surfaced here in stdout or, worse, only
# after a live Discord turn failed.
_HERE = Path(__file__).resolve().parent
_STATUS_PATH = _HERE / "bot_status.json"
_bot_status: dict = {}


def _save_bot_status(**updates) -> None:
    """Merges updates into the in-memory status and writes it whole - never
    raises, since a status-file write failure must never take down a real
    game turn or the bot's own startup."""
    _bot_status.update(updates)
    _bot_status["last_write_at"] = datetime.now().isoformat()
    try:
        pm._atomic_json_write(str(_STATUS_PATH), _bot_status)
    except OSError as ex:
        print(f"[Orion Bot] Could not write bot_status.json: {ex}")


# ===========================================================================
# STARTUP  -- load everything from disk so nothing is lost on restart
# ===========================================================================

@bot.event
async def on_ready():
    global _state, _roster, _chars, _profiles, _chat_history
    global _runtime_loaded, _turn_counter
    if not _runtime_loaded:
        legacy_state = pm.load_state()
        legacy_roster = pm.load_roster()
        pm.migrate_shared_progress(legacy_roster, legacy_state)
        _state, _roster = world_db.load_discord_runtime(legacy_state, legacy_roster)
        world_db.seed_realm()
        _chars = pm.load_characters()
        _profiles = pp.load_profiles()
        _chat_history = pp.load_history()
        _turn_counter = int(_state.get("turns_since_profile_update", 0))
        pm.save_state(_state)
        pm.save_roster(_roster)
        _runtime_loaded = True

    print(f"[Orion Bot] Online as {bot.user}")
    print(f"[Orion Bot] Watching channel: {cfg.GAME_CHANNEL_ID}")
    print(f"[Orion Bot] Party members loaded: {len(_roster)}")
    print(f"[Orion Bot] Player profiles loaded: {len(_profiles)}")
    print(f"[Orion Bot] Chat history restored: {len(_chat_history)} messages")

    ai_ok, model_name = ai.ping_server()
    print(f"[Orion Bot] AI server: {'OK -- ' + model_name if ai_ok else 'NOT REACHABLE -- ' + model_name}")

    channel = bot.get_channel(cfg.GAME_CHANNEL_ID)
    channel_name, guild_name = None, None
    manage_roles_ok = False
    if channel is not None:
        channel_name = channel.name
        guild_name = channel.guild.name
        if channel.guild.me is not None:
            manage_roles_ok = channel.permissions_for(channel.guild.me).manage_roles

    # Real gap found 2026-09-02 (Alex live-played into it, mid-combat, at
    # 18/30 HP): _apply_death_consequences() already catches discord.Forbidden
    # if DEATH_MODE=="role" and the bot lacks Manage Roles - it just prints to
    # this console and moves on, so an admin not watching stdout would never
    # know the "Fallen Adventurer" role silently didn't get applied until
    # after a real party wipe. Checking once at startup, and saying so loudly
    # in the game channel itself, surfaces this before it matters instead of
    # after.
    if cfg.DEATH_MODE == "role" and channel is not None and not manage_roles_ok:
        warning = (
            f"[Orion Bot] WARNING: DEATH_MODE is 'role' but this bot lacks "
            f"Manage Roles in #{channel.name} - a party wipe will NOT apply "
            f"the '{cfg.FALLEN_ROLE_NAME}' role. Grant it in Server Settings "
            f"-> Roles, or change DEATH_MODE in discord_config.py."
        )
        print(warning)
        try:
            await channel.send(
                f"*(Orion notices a gap in his power: he lacks the **Manage Roles** "
                f"permission, so he cannot mark the fallen with the "
                f"`{cfg.FALLEN_ROLE_NAME}` role on a party wipe. "
                f"An admin should grant it in Server Settings.)*"
            )
        except discord.Forbidden:
            pass

    _save_bot_status(
        online=True,
        bot_user=str(bot.user),
        started_at=datetime.now().isoformat(),
        watching_channel_ok=channel is not None,
        channel_name=channel_name,
        guild_name=guild_name,
        manage_roles_ok=manage_roles_ok,
        death_mode=cfg.DEATH_MODE,
        ai_reachable=ai_ok,
        ai_model=model_name,
        ai_enabled=_ai_enabled,
        party_size=len(_roster),
        last_turn_at=None,
        last_turn_ok=None,
        last_turn_latency_s=None,
        last_error=None,
    )

    if not _heartbeat_loop.is_running():
        _heartbeat_loop.start()


@tasks.loop(seconds=20)
async def _heartbeat_loop():
    """Keeps bot_status.json fresh between turns so the Command Center can
    tell "process alive and still connected" from "went quiet a while ago"
    even on a session nobody is actively playing right now."""
    ai_ok, model_name = ai.ping_server()
    _save_bot_status(
        last_heartbeat_at=datetime.now().isoformat(),
        ai_reachable=ai_ok,
        ai_model=model_name,
        ai_enabled=_ai_enabled,
        party_size=len(_roster),
    )


# ===========================================================================
# HELPERS
# ===========================================================================

def _is_game_channel(ctx_or_msg):
    return ctx_or_msg.channel.id == cfg.GAME_CHANNEL_ID


def _check_cooldown(user_id):
    """Real rate limit, not just a config value that does nothing. Returns
    (ok: bool, seconds_remaining: float)."""
    uid = str(user_id)
    now = time.monotonic()
    last = _last_action_at.get(uid, 0)
    elapsed = now - last
    if elapsed < cfg.ACTION_COOLDOWN_SECONDS:
        return False, round(cfg.ACTION_COOLDOWN_SECONDS - elapsed, 1)
    _last_action_at[uid] = now
    return True, 0.0


def _is_admin(user_id):
    return int(user_id) in cfg.ADMIN_USER_IDS


def _make_status_embed():
    members_text, hp_bar, combat_text = pm.get_status_embed_fields(_roster, _state)
    party_hp, party_max = pm.party_hp(_roster)
    color = discord.Color.red() if _state.get("in_combat") else discord.Color.gold()
    e = discord.Embed(title="⚔  King Orion's Realm — Party Status", color=color)
    e.add_field(
        name="🏰 Party Vitality",
        value=f"`[{hp_bar}]` {party_hp}/{party_max}{combat_text}",
        inline=False
    )
    e.add_field(name="📜 Campaign",
                value=(f"Turn {_state.get('total_turns', 0)}  |  "
                       f"{_state.get('location', 'The Wildlands')}"), inline=True)
    e.add_field(name="📖 Journal",
                value=_state.get("world_journal", "Unknown."), inline=False)
    e.add_field(name="🧑‍🤝‍🧑 Party Roster", value=members_text, inline=False)
    e.add_field(name="👁 Discovered Contacts",
                value=str(_state.get("contacts", "None yet."))[:1024], inline=False)
    e.set_footer(text="Type any action in this channel to play. !help for commands.")
    return e


def _make_profile_embed(user_id, display_name):
    uid = str(user_id)
    prof = _profiles.get(uid)
    if not prof:
        e = discord.Embed(
            title=f"📜 {display_name}'s Profile",
            description="Orion has not yet formed a memory of your deeds. Play more turns!",
            color=discord.Color.dark_gold()
        )
        return e

    e = discord.Embed(
        title=f"📜 {display_name}'s Profile",
        description="*What Orion remembers about you...*",
        color=discord.Color.gold()
    )
    if uid in _roster:
        stats = pm.player_state(_roster, uid)
        e.add_field(
            name="Character",
            value=(f"{stats.get('character_name', display_name)} | "
                   f"{stats.get('player_class', 'warrior')} level {stats.get('level', 1)} | "
                   f"HP {stats.get('current_hp', 0)}/{stats.get('max_hp', 30)} | "
                   f"XP {stats.get('xp', 0)} | Gold {stats.get('gold', 0)}"),
            inline=False,
        )
        e.add_field(
            name="Pack and Reputation",
            value=(f"{', '.join(stats.get('inventory', [])) or '(empty)'}\n"
                   f"Hero {stats.get('reputation_hero', 0)} | "
                   f"Crime {stats.get('reputation_crime', 0)}"),
            inline=False,
        )
    if prof.get("play_style"):
        e.add_field(name="⚔ Play Style", value=prof["play_style"], inline=False)

    moments = prof.get("notable_moments", [])
    if moments:
        e.add_field(name="🌟 Notable Moments",
                    value="\n".join(f"• {m}" for m in moments[-5:]), inline=False)

    npc_rels = prof.get("npc_relationships", [])
    if npc_rels:
        e.add_field(name="🤝 NPC Relationships",
                    value="\n".join(f"• {r}" for r in npc_rels[-4:]), inline=False)

    p_notes = prof.get("personality_notes", [])
    if p_notes:
        e.add_field(name="🎭 Personality",
                    value="\n".join(f"• {n}" for n in p_notes[-3:]), inline=False)

    roster_entry = _roster.get(uid, {})
    e.add_field(
        name="📊 Stats",
        value=(
            f"Kills: **{roster_entry.get('kills', 0)}**  |  "
            f"Deaths: **{roster_entry.get('deaths', 0)}**  |  "
            f"Turns: **{roster_entry.get('turns_taken', 0)}**"
        ),
        inline=False
    )
    return e


async def _apply_death_consequences(guild, fallen_user_ids):
    # Kick-on-death removed 2026-09-02 at Alex's request - Orion no longer has
    # any way to remove a real member from the server, full stop. DEATH_MODE
    # defaults to "none" in discord_config.py so nothing punitive happens to
    # a real Discord member out of the box; "role"/"timeout" remain here as
    # opt-in choices for anyone who deliberately wants one and grants the
    # matching permission, not something this bot reaches for on its own.
    if cfg.DEATH_MODE == "none":
        return
    for uid in fallen_user_ids:
        try:
            member = guild.get_member(int(uid))
            if not member:
                continue
            if cfg.DEATH_MODE == "role":
                role = discord.utils.get(guild.roles, name=cfg.FALLEN_ROLE_NAME)
                if role:
                    await member.add_roles(role, reason="Fallen in King Orion's Realm")
            elif cfg.DEATH_MODE == "timeout":
                until = discord.utils.utcnow() + timedelta(minutes=cfg.DEATH_TIMEOUT_MINUTES)
                await member.timeout(until, reason="Fallen in King Orion's Realm")
        except discord.Forbidden:
            print(f"[Orion Bot] Missing perms for death consequence on {uid}")
        except Exception as ex:
            print(f"[Orion Bot] Death consequence error: {ex}")


async def _revive_consequences(guild, user_id):
    try:
        member = guild.get_member(int(user_id))
        if not member:
            return
        role = discord.utils.get(guild.roles, name=cfg.FALLEN_ROLE_NAME)
        if role and role in member.roles:
            await member.remove_roles(role, reason="Revived")
        try:
            await member.timeout(None, reason="Revived")
        except Exception:
            pass
    except Exception as ex:
        print(f"[Orion Bot] Revive consequence error: {ex}")


# ===========================================================================
# COMMANDS
# ===========================================================================

@bot.command(name="debug")
async def cmd_debug(ctx):
    """
    Admin-only. Shows exactly what the AI last sent/received so you can
    diagnose why responses look wrong. Critical for tuning local models.
    """
    if not _is_game_channel(ctx):
        return
    if not _is_admin(ctx.author.id):
        await ctx.send("*Only an admin can peer behind Orion's curtain.*")
        return

    e = discord.Embed(title="🔧 Orion Debug Panel", color=discord.Color.blurple())

    # State snapshot
    e.add_field(
        name="World State",
        value=(
            f"Party HP: {pm.party_hp(_roster)[0]}/{pm.party_hp(_roster)[1]}\n"
            f"Campaign turn: {_state.get('total_turns', 0)}\n"
            f"Memory cadence: {_state.get('turns_since_memory_update', 0)}\n"
            f"In combat: {_state.get('in_combat', False)}\n"
            f"Journal: {_state.get('world_journal', '?')[:120]}"
        ),
        inline=False
    )

    # History snapshot
    hist_len = len(_chat_history)
    last_two = _chat_history[-4:] if hist_len >= 4 else _chat_history
    history_preview = "\n".join(
        f"**{h['role'].upper()}:** {h['content'][:80]}..."
        for h in last_two
    ) or "(empty)"
    e.add_field(
        name=f"Chat History ({hist_len} messages stored)",
        value=history_preview,
        inline=False
    )

    # Roster
    roster_text = "\n".join(
        f"{m['name']}: {m.get('turns_taken',0)} turns, fallen={m.get('is_fallen',False)}"
        for m in _roster.values()
    ) or "(empty)"
    e.add_field(name=f"Party Roster ({len(_roster)} members)", value=roster_text, inline=False)

    # AI server
    ok, model_name = ai.ping_server()
    e.add_field(
        name="AI Server",
        value=f"{'✅ Online' if ok else '❌ Offline'}: {model_name}",
        inline=False
    )

    # Token estimate
    approx_tokens = sum(len(h['content'].split()) * 1.3 for h in _chat_history[-16:])
    e.set_footer(text=f"Approx history tokens in last 8 pairs: ~{int(approx_tokens)}")

    await ctx.send(embed=e)


@bot.command(name="settokens")
async def cmd_settokens(ctx, tokens: int = 0):
    """Admin: !settokens 700  -- lower if your model has a small context
    window, raise it if Orion keeps going silent mid-turn (a "thinking"
    model can burn most of its budget on hidden reasoning before it ever
    starts the visible reply - see DEFAULT_MAX_TOKENS in bot_ai_handler.py)."""
    if not _is_game_channel(ctx):
        return
    if not _is_admin(ctx.author.id):
        await ctx.send("*Only an admin can adjust Orion's verbosity.*")
        return
    if tokens < 50 or tokens > 1500:
        await ctx.send("Token limit must be between 50 and 1500. Try `!settokens 700`.")
        return
    ai.DEFAULT_MAX_TOKENS = tokens
    await ctx.send(f"*Orion's max response length set to {tokens} tokens.*")


@bot.command(name="ping")
async def cmd_ping(ctx):
    """Works in any channel -- use this to confirm the bot is alive and reading messages."""
    await ctx.send(
        f"⚔ Orion hears you, {ctx.author.display_name}.\n"
        f"Game channel: <#{cfg.GAME_CHANNEL_ID}>\n"
        f"This channel ID: `{ctx.channel.id}`\n"
        f"Match: {'✅ YES -- you are in the game channel' if ctx.channel.id == cfg.GAME_CHANNEL_ID else '❌ NO -- go to the game channel to play'}"
    )


@bot.command(name="join")
async def cmd_join(ctx):
    if not _is_game_channel(ctx):
        return
    uid = ctx.author.id
    # Real bug found 2026-08-26 (security review): MAX_PARTY_SIZE was
    # defined in discord_config.py ("prevents server griefing via mass
    # !join") but never actually checked here - anyone could join without
    # limit.
    async with _turn_lock:
        if pm.is_member(_roster, uid):
            await ctx.send(f"*{ctx.author.display_name} is already in the party.*")
            return
        if len(_roster) >= cfg.MAX_PARTY_SIZE:
            await ctx.send(
                f"*The realm is full ({cfg.MAX_PARTY_SIZE} adventurers already stand within it). "
                f"An admin must raise the limit or someone must `!leave` first.*"
            )
            return
    async with _turn_lock:
        if pm.is_member(_roster, uid):
            await ctx.send(f"*{ctx.author.display_name} is already in the party.*")
            return
        pm.add_member(_roster, uid, ctx.author.display_name)
        pm.save_roster(_roster)
        pp.ensure_player(_profiles, uid, ctx.author.display_name)
        pp.save_profiles(_profiles)
        world_db.save_discord_runtime(_state, _roster)
        world_db.save_discord_runtime(_state, _roster)
    e = discord.Embed(
        title="⚔ A new adventurer joins!",
        description=(
            f"**{ctx.author.display_name}** has joined King Orion's Realm.\n\n"
            f"*The realm shifts to accommodate another soul.*\n\n"
            f"Party size: **{len(_roster)}**  |  Type any action to play."
        ),
        color=discord.Color.gold()
    )
    await ctx.send(embed=e)


@bot.command(name="leave")
async def cmd_leave(ctx):
    if not _is_game_channel(ctx):
        return
    uid = ctx.author.id
    async with _turn_lock:
        if not pm.is_member(_roster, uid):
            await ctx.send(f"*{ctx.author.display_name} is not in the party.*")
            return
    async with _turn_lock:
        pm.remove_member(_roster, uid)
        pm.save_roster(_roster)
        world_db.save_discord_runtime(_state, _roster)
        world_db.save_discord_runtime(_state, _roster)
    await ctx.send(
        f"*{ctx.author.display_name} steps away from the party. "
        f"The realm watches their departure in silence.*"
    )


@bot.command(name="status")
async def cmd_status(ctx):
    if not _is_game_channel(ctx):
        return
    await ctx.send(embed=_make_status_embed())


@bot.command(name="profile")
async def cmd_profile(ctx, member: discord.Member = None):
    """Show what Orion remembers about you (or another member)."""
    if not _is_game_channel(ctx):
        return
    target = member or ctx.author
    await ctx.send(embed=_make_profile_embed(target.id, target.display_name))


@bot.command(name="help")
async def cmd_help(ctx):
    if not _is_game_channel(ctx):
        return
    e = discord.Embed(title="⚔ King Orion's Realm — Commands",
                      color=discord.Color.dark_gold())
    e.add_field(name="!join",            value="Join the party",                    inline=False)
    e.add_field(name="!leave",           value="Leave the party",                   inline=False)
    e.add_field(name="!status",          value="Party HP, roster, journal",         inline=False)
    e.add_field(name="!profile [@user]", value="What Orion remembers about you",    inline=False)
    e.add_field(name="!who <name>",      value="Everything ever recorded about someone", inline=False)
    e.add_field(name="!where <place>",   value="Everything ever recorded about a place", inline=False)
    e.add_field(name="!codex [search]",  value="The whole character and location sheet", inline=False)
    e.add_field(name="!help",            value="This message",                      inline=False)
    e.add_field(name="── Admin ──",      value="─────────────────────",             inline=False)
    e.add_field(name="!newgame",         value="Start a brand new adventure",       inline=False)
    e.add_field(name="!revive @user",    value="Revive a fallen party member",      inline=False)
    e.add_field(name="!reviveall",       value="Revive the entire party",           inline=False)
    e.add_field(name="!ai on/off",       value="Pause or resume AI responses",      inline=False)
    e.add_field(name="!debug",           value="Show AI state, history, diagnosis", inline=False)
    e.add_field(name="!settokens [n]",   value="Set AI max response length",        inline=False)
    e.set_footer(text="Type any non-command message in this channel to play.")
    await ctx.send(embed=e)


@bot.command(name="newgame")
async def cmd_newgame(ctx):
    global _state, _chars, _chat_history, _profiles, _turn_counter
    if not _is_game_channel(ctx):
        return
    if not _is_admin(ctx.author.id):
        await ctx.send("*Only an admin may rewrite the annals of fate.*")
        return
    if _turn_lock.locked():
        await ctx.send("*Wait for the active turn to finish before opening a new age.*")
        return
    new_state = pm.reset_state(len(_roster))
    pm.reset_progress(_roster)
    campaign_id = world_db.start_new_campaign("A New Age", new_state, _roster)
    _state = new_state
    _turn_counter = 0
    _chars = pm.reset_characters()
    _chat_history = pp.reset_history()
    # NOTE: profiles are intentionally NOT reset on new game.
    # Orion keeps his memory of who each player IS even when the story resets.
    pm.save_roster(_roster)
    pm.save_state(_state)
    e = discord.Embed(
        title="📜 A New Age Begins",
        description=(
            "The previous campaign is archived. A new timeline opens.\n\n"
            "*The party stands at the edge of the Wildlands, "
            "drawn together by fate.*\n\n"
            "Type your first action to begin."
        ),
        color=discord.Color.gold()
    )
    await ctx.send(embed=e)


@bot.command(name="revive")
async def cmd_revive(ctx, member: discord.Member = None):
    global _state
    if not _is_game_channel(ctx):
        return
    if not _is_admin(ctx.author.id):
        await ctx.send("*Only an admin may bend the laws of life and death.*")
        return
    if not member:
        await ctx.send("Usage: `!revive @username`")
        return
    async with _turn_lock:
        pm.revive_member(_roster, member.id)
        pm.save_roster(_roster)
        world_db.save_discord_runtime(_state, _roster)
    await _revive_consequences(ctx.guild, member.id)
    e = discord.Embed(
        title="✨ Revived!",
        description=(
            f"**{member.display_name}** breathes again.\n"
            "*Fate has more planned for this one.*"
        ),
        color=discord.Color.green()
    )
    await ctx.send(embed=e)


@bot.command(name="reviveall")
async def cmd_reviveall(ctx):
    global _state
    if not _is_game_channel(ctx):
        return
    if not _is_admin(ctx.author.id):
        await ctx.send("*Only an admin may perform miracles of this scale.*")
        return
    async with _turn_lock:
        pm.revive_all(_roster)
        pm.save_roster(_roster)
        world_db.save_discord_runtime(_state, _roster)
    for uid in _roster:
        await _revive_consequences(ctx.guild, uid)
    e = discord.Embed(
        title="✨ The Party Rises",
        description="*Against all odds, every fallen soul opens their eyes.*",
        color=discord.Color.green()
    )
    await ctx.send(embed=e)


@bot.command(name="ai")
async def cmd_ai(ctx, toggle: str = ""):
    global _ai_enabled
    if not _is_game_channel(ctx):
        return
    if not _is_admin(ctx.author.id):
        await ctx.send("*Only an admin may silence Orion.*")
        return
    if toggle.lower() == "off":
        _ai_enabled = False
        await ctx.send("*Orion falls silent. The realm holds its breath.*")
    elif toggle.lower() == "on":
        _ai_enabled = True
        await ctx.send("*Orion stirs. His voice returns to the ether.*")
    else:
        status = "ON" if _ai_enabled else "OFF"
        await ctx.send(f"AI narration is **{status}**. Use `!ai on` or `!ai off`.")


@bot.command(name="who")
async def cmd_who(ctx, *, name: str = ""):
    """!who Griselda -- everything the realm has ever recorded about somebody."""
    if not _is_game_channel(ctx):
        return
    if not name.strip():
        await ctx.send("Ask about somebody: `!who Griselda`")
        return
    await ctx.send(f"```\n{codex_bridge.ask('who', name.strip())[:1900]}\n```")


@bot.command(name="where")
async def cmd_where(ctx, *, name: str = ""):
    """!where Brindlemark -- everything the realm has ever recorded about a place."""
    if not _is_game_channel(ctx):
        return
    if not name.strip():
        await ctx.send("Ask about a place: `!where Brindlemark`")
        return
    await ctx.send(f"```\n{codex_bridge.ask('where', name.strip())[:1900]}\n```")


@bot.command(name="codex")
async def cmd_codex(ctx, *, query: str = ""):
    """!codex -- the whole cheatsheet. !codex thorne -- search it."""
    if not _is_game_channel(ctx):
        return
    text = codex_bridge.ask("find", query.strip()) if query.strip() else codex_bridge.briefing(40)
    await ctx.send(f"```\n{(text or 'The codex is empty.')[:1900]}\n```")


def _sentence_chunks(text, limit):
    """
    Split a turn into pieces that fit, breaking only at the end of a sentence.

    Discord will happily cut a string mid-word at its own limits, which is what
    made every long turn look like the model had trailed off. Breaking on "."
    "!" or "?" means the seam always lands somewhere a reader expects one.
    """
    body = str(text or "").strip()
    if len(body) <= limit:
        return [body] if body else []

    chunks = []
    while len(body) > limit:
        window = body[:limit]
        cut = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
        if cut < limit // 3:
            # No sentence end anywhere sensible, so fall back to a word break
            # rather than slicing through the middle of a word.
            cut = window.rfind(" ")
        if cut <= 0:
            cut = limit - 1
        chunks.append(body[: cut + 1].strip())
        body = body[cut + 1 :].strip()

    if body:
        chunks.append(body)
    return chunks


# ===========================================================================
# MAIN GAME LOOP
# ===========================================================================

@bot.event
async def on_message(message):
    global _state, _roster, _chars, _profiles, _chat_history, _turn_counter, _queued_turns

    await bot.process_commands(message)

    if message.author.bot:
        return
    if not message.guild:
        return
    if message.channel.id != cfg.GAME_CHANNEL_ID:
        return
    if message.content.startswith(cfg.COMMAND_PREFIX):
        return

    uid = message.author.id
    display_name = message.author.display_name
    user_action  = message.content.strip()

    if not pm.is_member(_roster, uid):
        await message.channel.send(
            f"*{display_name} lingers at the edge of the story. "
            f"Type `!join` to enter the realm.*"
        )
        return

    if pm.is_fallen(_roster, uid):
        await message.channel.send(
            f"*{display_name} is fallen and cannot act. "
            f"An admin must use `!revive @{display_name}` to bring them back.*"
        )
        return

    if not user_action:
        return

    # ---- Rate limit ----
    ok, wait_s = _check_cooldown(uid)
    if not ok:
        await message.channel.send(
            f"*{display_name}, the realm needs a breath before it can respond again "
            f"({wait_s}s).*"
        )
        return

    # DEBUG LINE -- remove this after confirming the bot receives messages
    print(f"[Orion Bot] Message from {display_name} in #{message.channel.name}: {user_action[:60]}")

    # Ensure this player's profile exists even if we've never seen them
    pp.ensure_player(_profiles, uid, display_name)

    # ---- Input safety check ----
    safe, reason, cleaned_action = sanitizer.sanitize(uid, display_name, user_action)
    if not safe:
        await message.channel.send(sanitizer.get_block_message(reason))
        return
    user_action = cleaned_action

    combat_intent = combat_engine.classify_action(user_action)
    intent = world_rules.classify_world_action(user_action, combat_intent)
    accepted, previous = world_db.begin_discord_turn(
        message.id, uid, display_name, user_action, intent
    )
    if not accepted:
        status = previous.get("status", "recorded") if previous else "recorded"
        if status == "saved" and previous.get("response"):
            for chunk in _sentence_chunks(previous["response"], 1900):
                await message.channel.send(chunk)
            world_db.mark_discord_turn_sent(message.id)
            return
        await message.channel.send(
            f"*That Discord message is already {status}; it will not be resolved twice.*"
        )
        return

    async with _queue_guard:
        if _queued_turns >= MAX_QUEUED_TURNS:
            world_db.fail_discord_turn(message.id, "turn queue full")
            await message.channel.send("*The turn queue is full. Try again after Orion answers.*")
            return
        _queued_turns += 1
        queue_position = _queued_turns

    if _turn_lock.locked():
        await message.channel.send(
            f"*Your action is queued at position {queue_position}, {display_name}.*"
        )

    await _turn_lock.acquire()
    try:
        async with message.channel.typing():

            # Godot and Discord share the same authoritative runtime. Reload
            # after entering Discord's local queue so a game-client action that
            # landed while this message waited cannot be overwritten by stale
            # in-memory state.
            fresh_state, fresh_roster, turn_revision = world_db.load_discord_runtime(
                _state, _roster, include_revision=True
            )
            _state.clear(); _state.update(fresh_state)
            _roster.clear(); _roster.update(fresh_roster)
            if not pm.is_member(_roster, uid) or pm.is_fallen(_roster, uid):
                world_db.fail_discord_turn(message.id, "actor unavailable after world refresh")
                await message.channel.send(
                    f"*The realm changed while this turn waited. {display_name}, check your state and try again.*"
                )
                return

            # ---- Combat resolution (snapshotted - rolled back below if the
            # AI doesn't come back with real narration; see note there) ----
            state_snapshot  = copy.deepcopy(_state)
            roster_snapshot = copy.deepcopy(_roster)
            actor = pm.player_state(_roster, uid)
            hp_before = actor["current_hp"]
            intent, world_text, extra_events = world_rules.apply_world_action(
                display_name, user_action, actor, _state, combat_intent
            )
            if intent == "travel" and _state.get("location") != state_snapshot.get("location"):
                pm.set_party_location(_roster, _state["location"])
            combat_text, event = combat_engine.resolve_combat_turn(
                user_action, _state, actor_state=actor,
                actor_name=display_name, intent=combat_intent,
            )
            combat_text = "\n".join(part for part in (world_text, combat_text) if part).strip()
            mechanical_line = combat_engine.describe_event(event)
            pm.record_turn(_roster, uid)
            if event.get("enemy_defeated"):
                pm.record_kill(_roster, uid)

            # ---- AI narration ----
            turn_started = time.monotonic()
            if _ai_enabled:
                try:
                    party_names    = pm.format_party_names(_roster)
                    # The narrator used to be handed pm.format_characters(_chars),
                    # which reads discord_characters.json -- a file that has been
                    # "{}" the whole time. So every turn it was told "None
                    # recorded yet" and duly invented a fresh blacksmith. The
                    # codex is the store that actually has people in it, so it
                    # goes in too, and the game's own block still wins where it
                    # has something to say.
                    char_block     = pm.format_characters(_chars)
                    codex_block    = codex_bridge.briefing(14)
                    if codex_block:
                        char_block = f"{char_block}\n\n{codex_block}" if char_block else codex_block
                    profiles_block = pp.format_profiles_for_prompt(_profiles, _roster)
                    loop = asyncio.get_event_loop()
                    prompt_state = {**_state, **actor}
                    prompt_state["in_combat"] = _state.get("in_combat", False)
                    prompt_state["enemy"] = _state.get("enemy")
                    prompt_state["location"] = _state.get("location", actor.get("location"))
                    orion_text, ai_ok = await loop.run_in_executor(
                        None,
                        lambda: ai.get_response(
                            display_name, user_action, _chat_history,
                            prompt_state, combat_text, party_names,
                            char_block, profiles_block=profiles_block
                        )
                    )
                except Exception as ex:
                    print(f"[Orion Bot] AI error: {ex}")
                    orion_text, ai_ok = "*Orion's connection flickers and fails unexpectedly.*", False
            else:
                # Admin paused narration on purpose (!ai off) - this is
                # still a real, deliberate turn, not a failure.
                orion_text, ai_ok = "*Orion watches in silence - narration is paused by an admin.*", True
            turn_latency = round(time.monotonic() - turn_started, 1)

            # Real bug found 2026-09-02 (Alex live-played into it: "every
            # chat i take damage even if its an error text"): combat used to
            # resolve unconditionally before this point, so an unreachable or
            # misbehaving AI server meant a real, permanent enemy hit landed
            # on every failed attempt - the player was punished by
            # infrastructure, not their own play. On anything that isn't real
            # narration (ai_ok is False), roll the turn back to its
            # pre-combat snapshot and tell the player nothing happened,
            # rather than silently keeping the damage.
            if not ai_ok:
                _state.clear();  _state.update(state_snapshot)
                _roster.clear(); _roster.update(roster_snapshot)
                world_db.fail_discord_turn(message.id, orion_text)
                _save_bot_status(
                    last_turn_at=datetime.now().isoformat(),
                    last_turn_ok=False,
                    last_turn_latency_s=turn_latency,
                    last_error=orion_text,
                )
                await message.channel.send(
                    f"{orion_text}\n\n*Nothing was resolved this turn - "
                    f"{display_name}, try your action again once Orion can speak.*"
                )
                return

            # Narration can update recency only after it is known to be real.
            codex_bridge.note_mentions(orion_text)

            _save_bot_status(
                last_turn_at=datetime.now().isoformat(),
                last_turn_ok=True,
                last_turn_latency_s=turn_latency,
                last_error=None,
            )

            # ---- Persist chat history to disk EVERY turn ----
            _chat_history.append({"role": "user",      "content": f"{display_name}: {user_action}"})
            _chat_history.append({"role": "assistant", "content": orion_text})
            pp.save_history(_chat_history)   # <-- disk write every turn

            _state["total_turns"] = _state.get("total_turns", _state.get("turn_count", 0)) + 1
            _state["turn_count"] = _state["total_turns"]
            _state["turns_since_memory_update"] = _state.get("turns_since_memory_update", 0) + 1
            _turn_counter += 1
            _state["turns_since_profile_update"] = _turn_counter

            # ---- XP / Level up ----
            level_up_msg = ""
            xp_needed = actor["level"] * 50
            if actor["xp"] >= xp_needed:
                actor["level"] += 1
                actor["max_hp"] += 5
                actor["current_hp"] = min(actor["current_hp"] + 5, actor["max_hp"])
                actor["xp"] -= xp_needed
                event["level_up"] = actor["level"]
                level_up_msg = f"\n\n🎉 **LEVEL UP! {display_name} reaches Level {actor['level']}!**"

            if event.get("player_died"):
                pm.mark_fallen(_roster, uid)

            try:
                turn_revision = world_db.commit_discord_turn(
                    message.id, _state, _roster, orion_text, event,
                    uid, display_name, user_action, intent, extra_events,
                    expected_revision=turn_revision,
                )
            except world_db.RevisionConflictError:
                fresh_state, fresh_roster, turn_revision = world_db.load_discord_runtime(
                    _state, _roster, include_revision=True
                )
                _state.clear(); _state.update(fresh_state)
                _roster.clear(); _roster.update(fresh_roster)
                world_db.fail_discord_turn(message.id, "world changed during narration")
                await message.channel.send(
                    f"*The realm moved while Orion was speaking. Nothing from this Discord turn was saved; "
                    f"{display_name}, try the action again against the current state.*"
                )
                return
            pm.save_roster(_roster)
            pm.save_state(_state)

            # ---- Build response embed ----
            damage_taken = max(0, hp_before - actor["current_hp"])
            in_combat    = _state.get("in_combat", False)
            color = (discord.Color.red() if damage_taken > 0
                     else (discord.Color.dark_red() if in_combat
                           else discord.Color.gold()))

            e = discord.Embed(color=color)
            if mechanical_line:
                e.add_field(name="⚔ What happened",
                            value=f"`{mechanical_line}`", inline=False)
            # Real bug, reported repeatedly as "it still cuts off mid sentence
            # at the end": this is not the model and it is not _trim_to_sentence,
            # which already backs up to the last full stop. A Discord embed FIELD
            # caps at 1024 characters, and the narrator has a 700-token budget --
            # roughly 2800 characters. Everything past 1024 was chopped mid-word
            # and given an ellipsis before the player ever saw it.
            #
            # An embed DESCRIPTION holds 4096, which covers any turn the budget
            # can produce, and anything past even that is split on sentence ends
            # and sent after, so no turn is ever cut off again.
            spoken = _sentence_chunks(orion_text, 4096)
            e.description = spoken[0] if spoken else orion_text
            overflow = spoken[1:]

            ratio  = actor["current_hp"] / max(1, actor["max_hp"])
            filled = int(ratio * 20)
            hp_bar = "█" * filled + "░" * (20 - filled)
            footer = [
                f"{display_name} HP: [{hp_bar}] {actor['current_hp']}/{actor['max_hp']}",
                f"Lvl {actor['level']}",
                f"XP {actor['xp']}",
            ]
            if in_combat and _state.get("enemy"):
                en = _state["enemy"]
                footer.append(f"⚔ {en['name']} HP {max(0,en['hp'])}/{en['max_hp']}")
            e.set_footer(text="  |  ".join(footer))

            if level_up_msg:
                e.add_field(name="⭐ Level up", value=level_up_msg[:1024], inline=False)

            # Real bug found 2026-09-02 (Alex live-played into it): the memory
            # extraction and player-profile AI calls below used to run BEFORE
            # this send - each is its own separate LM Studio round trip with
            # its own AI_TIMEOUT/AI_MAX_RETRIES on top of the narration call
            # above, so a slow/flaky local model meant the player sat through
            # up to 3 sequential AI calls (worst case minutes) before ever
            # seeing a turn they'd already taken - while combat kept mechanically
            # resolving each retry. Neither block touches anything this embed
            # displays (they only feed !status's journal/contacts and !profile),
            # so it's safe to run them after the player already has their result.
            await message.channel.send(embed=e)
            for extra in overflow:
                await message.channel.send(extra)
            world_db.mark_discord_turn_sent(message.id)

            # ---- Memory + profile update every N turns ----
            if _state["turns_since_memory_update"] >= cfg.MEMORY_UPDATE_INTERVAL:
                try:
                    new_j, new_c = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: ai.update_memory(
                            _chat_history[-8:],
                            _state["world_journal"],
                            _state["contacts"]
                        )
                    )
                    _state["world_journal"] = new_j
                    _state["contacts"]      = new_c

                    raw_chars = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: ai.extract_character_updates(_chat_history[-8:])
                    )
                    _chars = pm.parse_character_update(_chars, raw_chars)
                    pm.save_characters(_chars)

                    # The same people, into the codex. pm.save_characters puts
                    # them in discord_characters.json, which nothing else in the
                    # realm opens -- not the GUI, not world.db, not the radio
                    # show. This is the line that makes a person met in Discord
                    # exist everywhere else too, and it dedupes, so a contacts
                    # blob the model rewrites can only ever add.
                    met_by = [m["name"] for m in _roster.values() if m.get("name")]
                    codex_bridge.sync_characters(_chars, met_by=met_by)
                    codex_bridge.sync_contacts(_state.get("contacts"), met_by=met_by)
                except Exception as ex:
                    print(f"[Orion Bot] Memory update error: {ex}")

                _chat_history = _chat_history[-pp.MAX_HISTORY_TURNS * 2:]
                _state["turns_since_memory_update"] = 0
                pm.save_state(_state)
                try:
                    turn_revision = world_db.save_discord_runtime(
                        _state, _roster, expected_revision=turn_revision
                    )
                except world_db.RevisionConflictError:
                    fresh_state, fresh_roster, turn_revision = world_db.load_discord_runtime(
                        _state, _roster, include_revision=True
                    )
                    _state.clear(); _state.update(fresh_state)
                    _roster.clear(); _roster.update(fresh_roster)

            # ---- Player profile extraction (runs less often to save AI calls) ----
            if _turn_counter >= pp.PROFILE_UPDATE_EVERY:
                _turn_counter = 0
                _state["turns_since_profile_update"] = 0
                try:
                    _profiles = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: pp.update_profiles_from_ai(
                            _profiles, _roster, _chat_history[-12:]
                        )
                    )
                    pp.save_profiles(_profiles)
                    try:
                        turn_revision = world_db.save_discord_runtime(
                            _state, _roster, expected_revision=turn_revision
                        )
                    except world_db.RevisionConflictError:
                        fresh_state, fresh_roster, turn_revision = world_db.load_discord_runtime(
                            _state, _roster, include_revision=True
                        )
                        _state.clear(); _state.update(fresh_state)
                        _roster.clear(); _roster.update(fresh_roster)
                except Exception as ex:
                    print(f"[Orion Bot] Profile update error: {ex}")

            # ---- Individual fall / party wipe ----
            if event.get("player_died"):
                all_fallen = bool(_roster) and all(m.get("is_fallen") for m in _roster.values())

                death_embed = discord.Embed(
                    title="💀  THE PARTY HAS FALLEN  💀" if all_fallen else f"💀  {display_name} HAS FALLEN",
                    description=(
                        ("*Every member of the party has been struck down.*\n\n" if all_fallen
                         else f"*{display_name} falls, but the surviving party may still act.*\n\n")
                        + "An admin may use `!revive @name` to return a fallen player."
                    ),
                    color=discord.Color.from_rgb(40, 0, 0)
                )
                death_embed.set_footer(text="The realm remembers those who dared to enter.")
                await message.channel.send(embed=death_embed)
                await _apply_death_consequences(message.guild, [uid])
    except Exception as ex:
        world_db.fail_discord_turn(message.id, ex)
        raise
    finally:
        _turn_lock.release()
        async with _queue_guard:
            _queued_turns = max(0, _queued_turns - 1)


# ===========================================================================
# RUN
# ===========================================================================

if __name__ == "__main__":
    # cfg.validate()/print_summary() existed since discord_config.py was
    # written but nothing ever called them - a bad/missing .env value only
    # ever surfaced as a silent no-op or a cryptic discord.py LoginFailure
    # deep in the stack. Printing the summary up front, and refusing to even
    # try connecting when the token or channel is missing, turns that into
    # an immediate, readable message the first time Orion is started.
    cfg.print_summary()
    config_errors = cfg.validate()
    if not cfg.BOT_TOKEN or cfg.GAME_CHANNEL_ID == 0:
        print("\n[Orion Bot] FATAL: cannot start -- " + "; ".join(config_errors))
        print("[Orion Bot] Set these in Orion Command Center's Settings tab, or directly in "
              "king_orions_realm/.env, then restart.")
        sys.exit(1)

    ok, model = ai.ping_server()
    if not ok:
        print(f"[WARNING] AI server not reachable: {model}")
        print("[WARNING] Bot starts anyway but narration won't work until LM Studio is running.")
    bot.run(cfg.BOT_TOKEN)
