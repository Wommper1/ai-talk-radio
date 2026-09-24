/**
 * Text-to-speech provider layer.
 *
 * Three engines, all local-first and free:
 *   sapi  — Windows System.Speech, always present on Windows, zero install.
 *   piper — neural TTS, much better quality, needs piper.exe + a .onnx voice.
 *   edge  — Microsoft Edge online voices, best quality, needs the edge-tts CLI.
 *
 * Every engine returns a WAV file on disk, which the audio pipeline decodes.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { resolvePiperPaths, type TtsConfig, type TtsEngine } from "../config.ts";
import { decodeMp3 } from "../audio/mp3.ts";
import { encodeWav } from "../audio/wav.ts";

export interface Voice {
  id: string;
  label: string;
  /** Extra detail shown under the name in the UI. */
  detail?: string;
}

export interface SynthesisRequest {
  text: string;
  voice: string;
  /** -10..10, engine-dependent scaling. */
  rate: number;
  outPath: string;
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  opts: { timeoutSeconds: number; stdin?: string; signal?: AbortSignal; cwd?: string } = { timeoutSeconds: 120 },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
        settled = true;
        reject(new TtsError(`${command} timed out after ${opts.timeoutSeconds}s`));
      }
    }, opts.timeoutSeconds * 1000);

    const onAbort = () => {
      child.kill();
    };
    opts.signal?.addEventListener("abort", onAbort);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
  });
}

function powershell(script: string, timeoutSeconds: number, signal?: AbortSignal): Promise<RunResult> {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutSeconds, signal });
}

/* ── Windows SAPI ────────────────────────────────────────────────── */

/**
 * SAPI is driven through a short PowerShell script. Text is passed via a temp
 * file rather than the command line so quotes and newlines in dialogue cannot
 * break the script or be interpreted as PowerShell.
 */
async function sapiSynthesize(req: SynthesisRequest, config: TtsConfig, signal?: AbortSignal): Promise<void> {
  const textFile = path.join(os.tmpdir(), `tts-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(textFile, req.text, "utf8");

  // Rate is clamped to SAPI's -10..10 range by the config layer already.
  const voiceLine = req.voice ? `try { $s.SelectVoice([string](Get-Content -LiteralPath $vf -Raw)) } catch {}` : "";
  const voiceFile = path.join(os.tmpdir(), `voice-${crypto.randomUUID()}.txt`);
  if (req.voice) fs.writeFileSync(voiceFile, req.voice, "utf8");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    `$tf = ${JSON.stringify(textFile)}`,
    `$vf = ${JSON.stringify(voiceFile)}`,
    `$out = ${JSON.stringify(req.outPath)}`,
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    voiceLine,
    `$s.Rate = ${Math.round(req.rate)}`,
    "$s.SetOutputToWaveFile($out)",
    "$text = [System.IO.File]::ReadAllText($tf)",
    "$s.Speak($text)",
    "$s.Dispose()",
  ].join("; ");

  try {
    const result = await powershell(script, config.timeoutSeconds, signal);
    if (result.code !== 0) {
      throw new TtsError(
        `Windows speech synthesis failed: ${result.stderr.trim().slice(0, 300) || `exit code ${result.code}`}`,
        "Try a different voice in Settings, or switch the TTS engine to Piper.",
      );
    }
    if (!fs.existsSync(req.outPath) || fs.statSync(req.outPath).size < 128) {
      throw new TtsError("Windows speech synthesis produced an empty file.", "The selected voice may not be installed.");
    }
  } finally {
    fs.rmSync(textFile, { force: true });
    fs.rmSync(voiceFile, { force: true });
  }
}

async function sapiVoices(config: TtsConfig): Promise<Voice[]> {
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $i = $_.VoiceInfo; " +
      "[PSCustomObject]@{ id = $i.Name; gender = [string]$i.Gender; age = [string]$i.Age; culture = $i.Culture.Name } } " +
      "| ConvertTo-Json -Compress",
  ].join("; ");

  const result = await powershell(script, Math.min(60, config.timeoutSeconds));
  if (result.code !== 0) return [];

  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((v: { id?: string }) => v?.id)
      .map((v: { id: string; gender?: string; culture?: string }) => ({
        id: v.id,
        label: v.id.replace(/^Microsoft\s+/, "").replace(/\s+Desktop$/, ""),
        detail: [v.gender, v.culture].filter(Boolean).join(" · "),
      }));
  } catch {
    return [];
  }
}

/* ── Piper ───────────────────────────────────────────────────────── */

/** Locate piper.exe, preferring the copy bundled under tools/piper. */
function piperExecutable(config: TtsConfig): { exe: string; cwd: string | undefined } {
  const { exeDir } = resolvePiperPaths(config);
  const binary = process.platform === "win32" ? "piper.exe" : "piper";

  // The configured path may be the folder or the executable itself.
  if (fs.existsSync(exeDir)) {
    if (fs.statSync(exeDir).isDirectory()) {
      const exe = path.join(exeDir, binary);
      // Run from the binary's folder so it finds espeak-ng-data beside itself.
      if (fs.existsSync(exe)) return { exe, cwd: exeDir };
    } else {
      return { exe: exeDir, cwd: path.dirname(exeDir) };
    }
  }

  return { exe: binary, cwd: undefined }; // fall back to PATH
}

async function piperSynthesize(req: SynthesisRequest, config: TtsConfig, signal?: AbortSignal): Promise<void> {
  if (!req.voice) {
    throw new TtsError("No Piper voice selected.", "Pick a voice in Settings.");
  }

  const { voicesDir } = resolvePiperPaths(config);
  const modelPath = path.isAbsolute(req.voice) ? req.voice : path.join(voicesDir, req.voice);

  if (!fs.existsSync(modelPath)) {
    throw new TtsError(
      `Piper voice not found: ${path.basename(modelPath)}`,
      `Expected it in ${voicesDir}. Download voices from huggingface.co/rhasspy/piper-voices.`,
    );
  }

  // Piper maps length_scale inversely to speed; rate -10..10 becomes roughly 1.4..0.65.
  const lengthScale = Math.max(0.55, Math.min(1.6, 1 - req.rate * 0.035));
  const args = ["--model", modelPath, "--output_file", req.outPath, "--length_scale", lengthScale.toFixed(3)];

  const { exe, cwd } = piperExecutable(config);

  let result: RunResult;
  try {
    result = await run(exe, args, { timeoutSeconds: config.timeoutSeconds, stdin: req.text, signal, cwd });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TtsError(
        "The piper executable was not found.",
        "Expected it at tools/piper/piper.exe. Set the Piper folder in Settings, or download it from github.com/rhasspy/piper/releases.",
      );
    }
    throw err;
  }

  if (result.code !== 0 || !fs.existsSync(req.outPath)) {
    throw new TtsError(`Piper failed: ${result.stderr.trim().slice(0, 300) || `exit code ${result.code}`}`);
  }
}

/** Read the sidecar .onnx.json a Piper voice ships with, for a nicer label. */
function piperVoiceDetail(jsonPath: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as {
      language?: { name_english?: string; code?: string };
      audio?: { sample_rate?: number };
      dataset?: string;
    };
    const language = meta.language?.name_english ?? meta.language?.code ?? "";
    const rate = meta.audio?.sample_rate ? `${Math.round(meta.audio.sample_rate / 1000)} kHz` : "";
    return [language, rate].filter(Boolean).join(" · ");
  } catch {
    return "Piper neural voice";
  }
}

function piperVoices(config: TtsConfig): Voice[] {
  const { voicesDir } = resolvePiperPaths(config);
  if (!fs.existsSync(voicesDir)) return [];

  try {
    return fs
      .readdirSync(voicesDir)
      .filter((f) => f.endsWith(".onnx"))
      .sort()
      .map((f) => {
        const stem = f.replace(/\.onnx$/, "");
        // Filenames look like en_US-ryan-high: locale, speaker, quality.
        const parts = stem.split("-");
        const speaker = parts[1] ?? stem;
        const quality = parts[2] ? ` (${parts[2]})` : "";
        const detail = piperVoiceDetail(path.join(voicesDir, `${f}.json`));

        return {
          id: f,
          label: `${speaker.charAt(0).toUpperCase()}${speaker.slice(1)}${quality}`,
          detail,
        };
      });
  } catch {
    return [];
  }
}

/* ── Edge TTS ────────────────────────────────────────────────────── */

/**
 * edge-tts always returns MP3, so decode it and re-emit WAV, keeping the rest
 * of the pipeline format-agnostic. Long text is passed via a file so quoting
 * and newlines cannot break the command line.
 */
async function edgeSynthesize(req: SynthesisRequest, config: TtsConfig, signal?: AbortSignal): Promise<void> {
  const voice = req.voice || "en-US-GuyNeural";
  const mp3Path = `${req.outPath}.mp3`;
  const textPath = `${req.outPath}.txt`;
  const ratePercent = Math.round(req.rate * 5); // -10..10 becomes -50%..+50%

  fs.writeFileSync(textPath, req.text, "utf8");

  const args = [
    "--voice",
    voice,
    "--rate",
    `${ratePercent >= 0 ? "+" : ""}${ratePercent}%`,
    "--write-media",
    mp3Path,
    "--file",
    textPath,
  ];

  try {
    let result: RunResult;
    try {
      result = await run("edge-tts", args, { timeoutSeconds: config.timeoutSeconds, signal });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TtsError(
          "edge-tts is not installed.",
          "Install it with: pip install edge-tts — or switch the engine to Piper, which needs no install.",
        );
      }
      throw err;
    }

    if (result.code !== 0 || !fs.existsSync(mp3Path)) {
      const stderr = result.stderr.trim();
      throw new TtsError(
        `edge-tts failed: ${stderr.slice(0, 300) || `exit code ${result.code}`}`,
        /network|resolve|connect|ssl|certificate/i.test(stderr)
          ? "Edge TTS is a cloud service and needs an internet connection. Switch to Piper to work offline."
          : undefined,
      );
    }

    const mp3 = fs.readFileSync(mp3Path);
    if (mp3.length < 128) {
      throw new TtsError("edge-tts returned an empty audio file.", "Check that the voice id is valid.");
    }

    const decoded = await decodeMp3(mp3);
    fs.writeFileSync(req.outPath, encodeWav(decoded));
  } finally {
    fs.rmSync(mp3Path, { force: true });
    fs.rmSync(textPath, { force: true });
  }
}

/**
 * edge-tts prints a fixed-width table:
 *   Name                Gender    ContentCategories    VoicePersonalities
 * Older releases used "Name: xx-YY-ZzzNeural" lines, so both are handled.
 */
async function edgeVoices(config: TtsConfig): Promise<Voice[]> {
  let result: RunResult;
  try {
    result = await run("edge-tts", ["--list-voices"], { timeoutSeconds: Math.min(90, config.timeoutSeconds) });
  } catch {
    return [];
  }
  if (result.code !== 0) return [];

  const voices: Voice[] = [];

  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^-{3,}/.test(line.trim())) continue; // separator row
    if (/^Name\s{2,}Gender/i.test(line.trim())) continue; // header row

    // Legacy format first.
    const legacy = line.trim().match(/^Name:\s*(\S+)/);
    if (legacy) {
      voices.push({ id: legacy[1], label: legacy[1], detail: "Edge online voice" });
      continue;
    }

    const columns = line.trim().split(/\s{2,}/);
    const id = columns[0];
    if (!id || !/^[a-z]{2,3}(-[A-Za-z]+)+Neural$/.test(id)) continue;

    const gender = columns[1] ?? "";
    const personality = columns[3] ?? "";
    // "en-US-JennyNeural" reads better as "Jenny — en-US".
    const locale = id.split("-").slice(0, 2).join("-");
    const speaker = id.replace(/^[a-z]{2,3}-[A-Za-z]+-/, "").replace(/(Multilingual)?Neural$/, "");

    voices.push({
      id,
      label: `${speaker} — ${locale}`,
      detail: [gender, personality].filter(Boolean).join(" · ").slice(0, 60),
    });
  }

  // English first: this is a talk-radio app, and 300+ entries need an order.
  return voices.sort((a, b) => {
    const aEn = a.id.startsWith("en-") ? 0 : 1;
    const bEn = b.id.startsWith("en-") ? 0 : 1;
    return aEn !== bEn ? aEn - bEn : a.id.localeCompare(b.id);
  });
}

/* ── Public surface ──────────────────────────────────────────────── */

export async function listVoices(config: TtsConfig): Promise<Voice[]> {
  switch (config.engine) {
    case "sapi":
      return process.platform === "win32" ? sapiVoices(config) : [];
    case "piper":
      return piperVoices(config);
    case "edge":
      return edgeVoices(config);
    default:
      return [];
  }
}

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * Fix the one thing every engine gets wrong on a made-up name.
 *
 * "Wommper1" comes out as a spelling, a stumble, or nothing at all depending
 * on the engine. A person reading it aloud says "Wommper one", so that is what
 * gets sent. Only a short digit run glued to the end of a word is touched —
 * real numbers ("2026", "20 percent") are left alone, because the engines
 * already handle those properly.
 */
export function speakable(text: string): string {
  return text.replace(
    /\b([A-Za-z]{2,})([0-9]{1,2})\b/g,
    (_all, word: string, digits: string) =>
      `${word} ${digits.split("").map((d) => DIGIT_WORDS[Number(d)]).join(" ")}`,
  );
}

export async function synthesize(req: SynthesisRequest, config: TtsConfig, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(path.dirname(req.outPath), { recursive: true });

  // Every engine comes through here, so the pronunciation fix only has to
  // exist in one place.
  req = { ...req, text: speakable(req.text) };

  switch (config.engine) {
    case "sapi":
      if (process.platform !== "win32") {
        throw new TtsError("The Windows speech engine is only available on Windows.", "Switch to Piper.");
      }
      return sapiSynthesize(req, config, signal);
    case "piper":
      return piperSynthesize(req, config, signal);
    case "edge":
      return edgeSynthesize(req, config, signal);
    default:
      throw new TtsError("TTS is disabled.", "Choose a speech engine in Settings to generate audio.");
  }
}

export async function probeTts(config: TtsConfig): Promise<{ ok: boolean; voices: Voice[]; error?: string; hint?: string }> {
  if (config.engine === "none") {
    return { ok: true, voices: [] };
  }

  try {
    const voices = await listVoices(config);
    if (voices.length === 0) {
      const hints: Record<TtsEngine, string> = {
        sapi: "No Windows voices reported. Add voices under Settings > Time & Language > Speech.",
        piper: "Set the Piper voices folder in Settings and put .onnx voice models in it.",
        edge: "Install the CLI with: pip install edge-tts",
        none: "",
      };
      return { ok: false, voices: [], error: "No voices found for this engine.", hint: hints[config.engine] };
    }
    return { ok: true, voices };
  } catch (err) {
    return {
      ok: false,
      voices: [],
      error: (err as Error).message,
      hint: (err as TtsError).hint,
    };
  }
}
