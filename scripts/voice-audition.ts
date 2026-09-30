import fs from "node:fs";
import path from "node:path";
import { loadConfig, type HostConfig } from "../server/config.ts";
import { durationOf } from "../server/audio/wav.ts";
import { renderTurnClip } from "../server/pipeline/produce.ts";

const config = loadConfig();
const outDir = path.join(process.cwd(), "output", "voice-audition");
fs.mkdirSync(outDir, { recursive: true });

const auditions: Array<{ host: HostConfig; voice: string; label: string; text: string }> = [
  {
    host: config.hosts[0],
    voice: "en-US-AndrewNeural",
    label: "marco-andrew",
    text: "All right, Dee, stay with me here. If a restaurant bans phones at the table, is that good hospitality—or are they charging us to be told how to behave?",
  },
  {
    host: config.hosts[0],
    voice: "en-US-BrianNeural",
    label: "marco-brian",
    text: "All right, Dee, stay with me here. If a restaurant bans phones at the table, is that good hospitality—or are they charging us to be told how to behave?",
  },
  {
    host: config.hosts[1],
    voice: "en-US-EmmaNeural",
    label: "dee-emma",
    text: "Marco, you already know the answer. The sign is not for the quiet couple checking a babysitter—it is for the man filming his soup like it signed a release form.",
  },
  {
    host: config.hosts[1],
    voice: "en-US-AvaNeural",
    label: "dee-ava",
    text: "Marco, you already know the answer. The sign is not for the quiet couple checking a babysitter—it is for the man filming his soup like it signed a release form.",
  },
];

console.log("Matched studio voice auditions\n");
for (const audition of auditions) {
  const host: HostConfig = {
    ...audition.host,
    voices: { ...audition.host.voices, edge: audition.voice },
  };
  const target = path.join(outDir, `${audition.label}.wav`);
  const started = Date.now();
  const audio = await renderTurnClip({ ...config, tts: { ...config.tts, engine: "edge" } }, host, audition.text, target);
  console.log(
    `${audition.label.padEnd(14)} ${audition.voice.padEnd(25)} ` +
    `${durationOf(audio).toFixed(2)}s audio in ${((Date.now() - started) / 1000).toFixed(2)}s`,
  );
  console.log(`  ${target}`);
}

console.log("\nAUDITIONS READY");
