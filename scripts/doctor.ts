/**
 * Check that everything the app needs is actually working on this machine,
 * and say plainly what to do about anything that is not.
 *
 * Run with: npm run doctor
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, configPath, voiceFor, resolvePiperPaths } from "../server/config.ts";
import { probe as probeLlm, generate, looksLikeToolCall } from "../server/providers/llm.ts";
import { probeTts } from "../server/providers/tts.ts";

const config = loadConfig();
let problems = 0;

function ok(label: string, detail = "") {
  console.log(`  \x1b[32mok\x1b[0m    ${label}${detail ? `  ${detail}` : ""}`);
}

function warn(label: string, fix: string) {
  console.log(`  \x1b[33mwarn\x1b[0m  ${label}`);
  console.log(`        → ${fix}`);
}

function bad(label: string, fix: string) {
  problems++;
  console.log(`  \x1b[31mfail\x1b[0m  ${label}`);
  console.log(`        → ${fix}`);
}

console.log("\n╭─ Local Talk Radio · system check\n");

/* ── Environment ─────────────────────────────────────────────── */

console.log("Environment");
const major = Number(process.versions.node.split(".")[0]);
if (major >= 20) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} is too old`, "Install Node 20 or newer from nodejs.org.");

ok(`${os.platform()} ${os.release()}`, `${Math.round(os.totalmem() / 1024 ** 3)} GB RAM, ${os.cpus().length} cores`);
ok("config", configPath);

/* ── Language model ──────────────────────────────────────────── */

console.log("\nLanguage model");
console.log(`  provider: ${config.llm.provider} @ ${config.llm.baseUrl}`);

const llm = await probeLlm(config.llm);

if (!llm.ok) {
  bad(llm.error ?? "Could not reach the model server", llm.hint ?? "Check that the server is running.");
} else {
  ok(`server reachable`, `${llm.models.length} model(s)`);

  if (!config.llm.model) {
    bad("No model selected", "Open Settings in the app and pick a model, or set llm.model in config.json.");
  } else if (!llm.models.some((m) => m.id === config.llm.model)) {
    warn(
      `Selected model "${config.llm.model}" is not in the server's list`,
      "It may still work if the server loads on demand, but check Settings.",
    );
  } else {
    ok(`model "${config.llm.model}"`);
  }

  // A real round-trip catches problems a model list never will.
  if (config.llm.model) {
    process.stdout.write("  ...  testing generation");
    const started = Date.now();
    try {
      const reply = await generate(config.llm, {
        messages: [
          {
            role: "system",
            content:
              "You have NO tools and NO functions. Your reply is spoken aloud on the radio. " +
              "You are a radio host. Reply with one short spoken sentence and nothing else.",
          },
          { role: "user", content: "Say hello to the listeners." },
        ],
        maxTokens: 60,
        temperature: 0.7,
      });
      const seconds = (Date.now() - started) / 1000;
      process.stdout.write("\r");
      ok("generation", `${seconds.toFixed(1)}s — "${reply.slice(0, 60).replace(/\s+/g, " ")}"`);

      if (looksLikeToolCall(reply)) {
        warn(
          "This model answers with function calls rather than plain speech",
          "Shows will still work — the pipeline detects this and retries each turn — but every " +
            "affected turn costs an extra request. Llama 3.x models do this most; Qwen, Gemma and " +
            "Mistral instruct models generally do not.",
        );
      }

      if (seconds > 20) {
        warn(
          "Generation is slow",
          "A show makes one call per turn, so a 12-turn show would take several minutes. " +
            "Try a smaller model or raise the GPU offload in your server.",
        );
      }
    } catch (err) {
      process.stdout.write("\r");
      const e = err as Error & { hint?: string };
      bad(`Generation failed: ${e.message}`, e.hint ?? "Check that a model is loaded on the server.");
    }
  }
}

/* ── Speech ──────────────────────────────────────────────────── */

console.log("\nSpeech");
console.log(`  engine: ${config.tts.engine}`);

if (config.tts.engine === "piper") {
  const { exeDir, voicesDir } = resolvePiperPaths(config.tts);
  const exe = path.join(exeDir, process.platform === "win32" ? "piper.exe" : "piper");

  if (fs.existsSync(exe)) {
    ok("piper", exe);
  } else {
    bad(`piper not found at ${exe}`, "Run: npm run setup-piper");
  }

  const hasVoices =
    fs.existsSync(voicesDir) && fs.readdirSync(voicesDir).some((f) => f.endsWith(".onnx"));
  if (!hasVoices) {
    bad(`no .onnx voices in ${voicesDir}`, "Run: npm run setup-piper");
  }
} else if (config.tts.engine === "edge") {
  warn(
    "Edge TTS sends each line to Microsoft's servers",
    "It needs an internet connection and the edge-tts CLI. Switch to Piper to stay fully offline.",
  );
}

if (config.tts.engine === "none") {
  warn("Speech is turned off", "Shows will be transcript-only. Pick an engine in Settings to get audio.");
} else {
  const tts = await probeTts(config.tts);
  if (!tts.ok) {
    bad(tts.error ?? "Speech engine not available", tts.hint ?? "Pick a different engine in Settings.");
  } else {
    ok(`${tts.voices.length} voice(s) available`);

    for (const host of config.hosts) {
      const voice = voiceFor(host, config.tts.engine);
      if (!voice) {
        warn(`${host.name} has no voice set`, "Pick one in Settings, or the engine default will be used.");
      } else if (!tts.voices.some((v) => v.id === voice)) {
        bad(`${host.name}'s voice "${voice}" is not available`, "Choose an installed voice in Settings.");
      } else {
        ok(`${host.name}`, `${voice} (${host.tone})`);
      }
    }

    const voiceA = voiceFor(config.hosts[0], config.tts.engine);
    if (voiceA && voiceA === voiceFor(config.hosts[1], config.tts.engine)) {
      warn("Both hosts use the same voice", "Give them different voices so listeners can tell them apart.");
    }
  }
}

/* ── Show setup ──────────────────────────────────────────────── */

console.log("\nShow");
ok(`"${config.show.station}"`, `${config.show.style}, ${config.show.turns} turns, ${config.show.mood} music`);

const sameModel = (config.hosts[0].model || config.llm.model) === (config.hosts[1].model || config.llm.model);
if (sameModel) {
  console.log("        (tip: giving each host a different model makes them sound like different people)");
}

/* ── Verdict ─────────────────────────────────────────────────── */

console.log(
  problems === 0
    ? "\n╰─ Ready. Run `npm run dev` and open http://localhost:3000\n"
    : `\n╰─ ${problems} problem(s) to fix before generating a show.\n`,
);

process.exit(problems === 0 ? 0 : 1);
