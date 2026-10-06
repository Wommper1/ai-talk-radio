/**
 * Offline test of the station-automation module's playout queue, fallback, backup/restore and settings.
 * No network, models, or API keys. Run with: npm run automation-selftest
 *
 * The automation and show-store modules fix their folders (shows/, data/, backups/ ...) from process.cwd() when they
 * are first imported. So this script changes into a throwaway temporary folder BEFORE importing them (dynamic
 * imports), and refuses to run if their folders do not resolve inside it. It can never touch the real library.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredShow } from "../server/pipeline/store.ts";

const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "talk-radio-automation-")));
const origin = process.cwd();
process.chdir(sandbox);

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures++;
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

const inside = (target: string) =>
  path.resolve(target).toLowerCase().startsWith(sandbox.toLowerCase() + path.sep);

try {
  // Imported only now, so every module-level path was computed from the sandbox.
  const automation = await import("../server/station/automation.ts");
  const store = await import("../server/pipeline/store.ts");

  if (!inside(automation.BACKUPS_DIR) || !inside(store.SHOWS_DIR)) {
    throw new Error(`Refusing to run: module folders are not inside the sandbox (${automation.BACKUPS_DIR}, ${store.SHOWS_DIR}).`);
  }
  console.log(`\nSandbox: ${sandbox}\n`);

  // ---- fixtures -------------------------------------------------------------------------------------------------

  function makeShow(id: string, createdAt: string, opts: { audio: boolean; ready?: boolean }): void {
    const show: StoredShow = {
      id, title: `Show ${id}`, summary: "", topic: "test", station: "Test FM", style: "interview", mood: "none",
      createdAt, duration: 600, hasAudio: opts.audio, hosts: [], outline: [], sources: [], transcript: [], models: [],
      audioAnalysis: opts.ready === undefined ? undefined : {
        targetLufs: -16, integratedLufs: -16, truePeakDbtp: -1, samplePeakDbfs: -3, gainAppliedDb: 0, streamingReady: opts.ready,
      },
    };
    store.saveShow(show);
    if (opts.audio) fs.writeFileSync(path.join(store.showDir(id), "show.wav"), "RIFFfake");
  }

  const A = "2026-03-01-show-a-aaaaaa";
  const B = "2026-02-01-show-b-bbbbbb";
  const C = "2026-01-01-show-c-cccccc";
  const D = "2026-04-01-show-d-dddddd";
  makeShow(A, "2026-03-01T10:00:00Z", { audio: true, ready: true });
  makeShow(B, "2026-02-01T10:00:00Z", { audio: true, ready: true });
  makeShow(C, "2026-01-01T10:00:00Z", { audio: true, ready: false }); // finished, but not streaming-ready
  makeShow(D, "2026-04-01T10:00:00Z", { audio: false, ready: true }); // no audio at all

  const statePath = path.join(sandbox, "data", "station-automation.json");
  const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    settings: { retryMinutes: number; playout: { enabled: boolean; autoFallback: boolean; queue: string[]; current?: { showId: string; fallback: boolean }; history: Array<{ showId: string; fallback: boolean }> } };
    events: Array<{ severity: string; component: string; message: string }>;
  };
  const events = () => automation.automationStatus().events.map((e) => e.message);

  console.log("─── playout: off by default ───\n");
  check("playout is switched off by default", automation.automationStatus().settings.playout.enabled === false);
  check("nothing plays while playout is off", automation.nextPlayoutItem() === null);

  console.log("\n─── playout queue ───\n");
  automation.updateAutomationSettings({ playout: { enabled: true, autoFallback: true, queue: [], history: [] } });
  check("a show without audio cannot enter playout", (() => { try { automation.enqueueShow(D); return false; } catch { return true; } })());
  check("an unknown show cannot enter playout", (() => { try { automation.enqueueShow("2026-01-01-nothing-000000"); return false; } catch { return true; } })());

  automation.enqueueShow(A);
  automation.enqueueShow(A);
  check("queueing the same show twice keeps one entry", automation.automationStatus().queue.length === 1);

  const first = automation.nextPlayoutItem();
  check("the queued show plays first and is not marked fallback", first?.id === A && first.fallback === false);
  check("the queue is consumed when a show starts", automation.automationStatus().queue.length === 0);
  check("asking again returns the same current show", automation.nextPlayoutItem()?.id === A);
  check("the current show is saved to disk", readState().settings.playout.current?.showId === A);
  check("a show that is playing cannot be queued again", (() => { automation.enqueueShow(A); return automation.automationStatus().queue.length === 0; })());

  automation.completePlayoutItem();
  check("finishing records the play in history", readState().settings.playout.history.at(-1)?.showId === A);
  check("finishing clears the current show", readState().settings.playout.current === undefined);

  console.log("\n─── playout fallback ───\n");
  const playoutNow = () => automation.automationStatus().settings.playout;
  automation.updateAutomationSettings({ playout: { ...playoutNow(), autoFallback: false } });
  check("with fallback off and nothing queued, playout returns nothing", automation.nextPlayoutItem() === null);
  check("that gap is recorded as a warning", readState().events.some((e) => e.severity === "warning" && e.message.includes("no streaming-ready fallback")));

  automation.updateAutomationSettings({ playout: { ...playoutNow(), autoFallback: true } });
  const fallback = automation.nextPlayoutItem();
  check("with fallback on, a streaming-ready show fills the gap", fallback?.fallback === true);
  check("fallback prefers a show that has not just played", fallback?.id === B, `got ${fallback?.id}`);
  check("fallback never picks a show that is not streaming-ready or has no audio", fallback?.id !== C && fallback?.id !== D);
  check("fallback start is recorded", events().some((m) => m.startsWith("Fallback started")));
  automation.completePlayoutItem();

  const again = automation.nextPlayoutItem();
  check("once every candidate has played recently, the newest is chosen", again?.id === A, `got ${again?.id}`);
  automation.completePlayoutItem();
  check("fallback candidates are counted for the operator", automation.automationStatus().fallbackCount === 2);
  check("fallback list excludes unready and silent shows", automation.fallbackPlayoutItems().every((i) => i.id === A || i.id === B));

  console.log("\n─── queue hygiene ───\n");
  makeShow("2026-05-01-show-x-xxxxxx", "2026-05-01T10:00:00Z", { audio: true, ready: true });
  automation.enqueueShow("2026-05-01-show-x-xxxxxx");
  automation.enqueueShow(B);
  store.deleteShow("2026-05-01-show-x-xxxxxx");
  const skipped = automation.nextPlayoutItem();
  check("a queued show whose files vanished is skipped", skipped?.id === B && skipped.fallback === false);
  automation.completePlayoutItem();

  automation.enqueueShow(A);
  automation.enqueueShow(B);
  automation.removeQueuedShow(A);
  check("a queued show can be removed", automation.automationStatus().queue.map((i) => i.id).join() === B);
  automation.clearPlayoutQueue();
  check("the queue can be cleared", automation.automationStatus().queue.length === 0);

  console.log("\n─── history and event limits ───\n");
  for (let i = 0; i < 105; i++) {
    automation.enqueueShow(A);
    automation.nextPlayoutItem();
    automation.completePlayoutItem();
  }
  const bounded = readState();
  check("play history is capped at 100", bounded.settings.playout.history.length === 100);
  check("the event log is capped at 250", bounded.events.length === 250);

  console.log("\n─── schedule slots and settings ───\n");
  check("a slot without a topic is refused", (() => { try { automation.upsertScheduleSlot({ id: "no-topic", time: "09:00" }); return false; } catch { return true; } })());
  const slot = automation.upsertScheduleSlot({ id: "evening", name: "Evening", topic: "Local news", time: "20:00", days: [1, 2, 3] });
  check("a slot with a topic is saved", automation.automationStatus().settings.slots.some((s) => s.id === "evening"));
  check("saving a slot is logged", events().some((m) => m.includes("Added Evening")));
  check("the saved slot keeps its schedule", slot.time === "20:00" && slot.days.join() === "1,2,3");
  check("removing a slot works once", automation.removeScheduleSlot("evening") === true && automation.removeScheduleSlot("evening") === false);
  check("an unsafe slot id cannot be removed", automation.removeScheduleSlot("../etc") === false);
  check("retry minutes are clamped", automation.updateAutomationSettings({ retryMinutes: 9999 }).settings.retryMinutes === 120);
  check("a zero retry value falls back to the default", automation.updateAutomationSettings({ retryMinutes: 0 }).settings.retryMinutes === 10);

  console.log("\n─── backups ───\n");
  fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({ marker: "v1" }));
  for (const [rel, text] of [
    ["memory/index.json", "{}"], ["commercials/spot1.wav", "wav"], ["ads/ad.json", "{}"], ["openers/o1.wav", "wav"],
    ["music/track.wav", "wav"], ["data/world_api_token.txt", "fake-token-for-test"], ["data/station-automation.lock", "{\"pid\":1}"],
  ] as const) {
    fs.mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true });
    fs.writeFileSync(path.join(sandbox, rel), text);
  }

  automation.updateAutomationSettings({ retryMinutes: 15 });
  const state1 = automation.createStationBackup("state");
  const snapshot1 = path.join(automation.BACKUPS_DIR, state1.id, "snapshot");
  check("a state backup is created and listed", automation.listStationBackups().some((b) => b.id === state1.id && b.kind === "state"));
  check("a state backup holds config, data, memory, commercials, ads and openers",
    ["config.json", "data/station-automation.json", "memory/index.json", "commercials/spot1.wav", "ads/ad.json", "openers/o1.wav"]
      .every((rel) => fs.existsSync(path.join(snapshot1, rel))));
  check("a state backup leaves out shows and music", !fs.existsSync(path.join(snapshot1, "shows")) && !fs.existsSync(path.join(snapshot1, "music")));
  check("the single-owner lock file is never backed up", !fs.existsSync(path.join(snapshot1, "data", "station-automation.lock")));
  check("backups never nest inside themselves", !fs.existsSync(path.join(snapshot1, "backups")));
  const countFiles = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);
  check("the manifest's file count matches the snapshot", state1.fileCount === countFiles(snapshot1), `${state1.fileCount} vs ${countFiles(snapshot1)}`);

  const full = automation.createStationBackup("full");
  const snapshotFull = path.join(automation.BACKUPS_DIR, full.id, "snapshot");
  check("a full backup adds shows and music", fs.existsSync(path.join(snapshotFull, "shows", A, "show.json")) && fs.existsSync(path.join(snapshotFull, "music", "track.wav")));
  check("a full backup is larger than a state backup", full.bytes > state1.bytes && full.fileCount > state1.fileCount);

  fs.mkdirSync(path.join(automation.BACKUPS_DIR, "not a valid id"), { recursive: true });
  fs.mkdirSync(path.join(automation.BACKUPS_DIR, "backup-broken"), { recursive: true });
  fs.writeFileSync(path.join(automation.BACKUPS_DIR, "backup-broken", "manifest.json"), "{ not json");
  check("folders with unsafe names or damaged manifests are ignored when listing",
    automation.listStationBackups().every((b) => b.id !== "not a valid id" && b.id !== "backup-broken"));

  console.log("\n─── restore ───\n");
  fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({ marker: "v2" }));
  fs.writeFileSync(path.join(sandbox, "memory", "newer.json"), "created after the backup");
  automation.updateAutomationSettings({ retryMinutes: 30 });

  const before = automation.listStationBackups().length;
  automation.restoreStationBackup(state1.id);
  check("restore brings back the saved file contents", JSON.parse(fs.readFileSync(path.join(sandbox, "config.json"), "utf8")).marker === "v1");
  check("restore reloads the saved settings into memory", automation.automationStatus().settings.retryMinutes === 15);
  check("restore takes a safety backup first", automation.listStationBackups().length === before + 1 && automation.listStationBackups().some((b) => b.kind === "safety"));
  const safety = automation.listStationBackups().find((b) => b.kind === "safety")!;
  check("the safety backup captured the state from just before the restore",
    JSON.parse(fs.readFileSync(path.join(automation.BACKUPS_DIR, safety.id, "snapshot", "config.json"), "utf8")).marker === "v2");
  check("restore is logged as a recovery", readState().events.some((e) => e.severity === "recovered" && e.message.includes(state1.id)));
  check("restore overlays the snapshot and keeps files created later (it does not delete)", fs.existsSync(path.join(sandbox, "memory", "newer.json")));

  check("an unsafe backup id is refused", (() => { try { automation.restoreStationBackup("../x"); return false; } catch (e) { return String((e as Error).message).includes("Invalid"); } })());
  check("an unknown backup id is refused", (() => { try { automation.restoreStationBackup("backup-does-not-exist"); return false; } catch (e) { return String((e as Error).message).includes("not found"); } })());

  // A tampered manifest must not be able to write outside the station folder.
  const tamperedId = "backup-tampered-state";
  const tamperedRoot = path.join(automation.BACKUPS_DIR, tamperedId);
  fs.mkdirSync(path.join(tamperedRoot, "snapshot"), { recursive: true });
  fs.writeFileSync(path.join(tamperedRoot, "escape.txt"), "should never be copied out");
  fs.writeFileSync(path.join(tamperedRoot, "manifest.json"), JSON.stringify({
    id: tamperedId, createdAt: new Date().toISOString(), kind: "state", bytes: 1, fileCount: 1, appVersion: 1, items: ["../escape.txt"],
  }));
  const escapeTarget = path.join(path.dirname(sandbox), "escape.txt");
  automation.restoreStationBackup(tamperedId);
  check("a tampered manifest cannot write outside the station folder", !fs.existsSync(escapeTarget));
  if (fs.existsSync(escapeTarget)) fs.rmSync(escapeTarget, { force: true });

  console.log("\n─── not covered here ───\n");
  console.log("  The scheduler's live production run, the five-minute health monitor and the single-owner lock need a running");
  console.log("  station server and a loaded model; they stay on the certification list in docs/STATION_READINESS.md.");
} catch (error) {
  failures++;
  console.log(`[ FAIL ] unexpected error — ${(error as Error).message}`);
} finally {
  process.chdir(origin);
  // Only ever delete the folder this run created.
  if (sandbox.toLowerCase().startsWith(fs.realpathSync.native(os.tmpdir()).toLowerCase() + path.sep) &&
      path.basename(sandbox).startsWith("talk-radio-automation-")) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\n─── all checks passed ───\n" : `\n─── ${failures} check(s) FAILED ───\n`);
process.exit(failures === 0 ? 0 : 1);
