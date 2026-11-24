/**
 * Download the Piper speech engine and voices into tools/piper.
 *
 * Shared by `npm run setup-piper` and the first-run setup screen, so a new
 * listener can get offline voices without opening a terminal.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const PIPER_RELEASE = "2023.11.14-2";
const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

/**
 * Every Piper voice the default configuration names: the first host and the
 * announcer, the second host, and the caller line. Downloading anything else
 * leaves a fresh station with a host who cannot speak.
 */
export const DEFAULT_PIPER_VOICES = ["en_US-ryan-high", "en_US-lessac-high", "en_US-hfc_female-medium"];

export const piperToolsDir = () => path.join(process.cwd(), "tools");
export const piperDir = () => path.join(piperToolsDir(), "piper");
export const piperVoicesDir = () => path.join(piperDir(), "voices");
const piperBinary = () => (process.platform === "win32" ? "piper.exe" : "piper");

export type PiperProgress = (line: string) => void;

function platformAsset(): string {
  switch (process.platform) {
    case "win32":
      return "piper_windows_amd64.zip";
    case "darwin":
      return `piper_macos_${process.arch === "arm64" ? "aarch64" : "x64"}.tar.gz`;
    default:
      return `piper_linux_${process.arch === "arm64" ? "aarch64" : "x86_64"}.tar.gz`;
  }
}

/** Map a voice name like en_US-ryan-high to its path under the voices repo. */
function voiceUrlPath(name: string): string {
  const [locale, speaker, quality] = name.split("-");
  const language = locale.split("_")[0];
  return `${language}/${locale}/${speaker}/${quality}/${name}`;
}

/** A voice name is a locale, a speaker and a quality; anything else is refused before it reaches a URL or path. */
export function isPiperVoiceName(name: string): boolean {
  return /^[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/.test(name);
}

async function download(url: string, dest: string, label: string, progress: PiperProgress): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    // Node's fetch says only "fetch failed"; the useful part (DNS, refused, TLS) is in `cause`.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (err as Error).message;
    throw new Error(`could not download ${url} (${detail}). Check your internet connection or proxy, then try again.`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  const total = Number(res.headers.get("content-length") ?? 0);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Write to a temporary name so an interrupted download is never mistaken for a finished voice.
  const partial = `${dest}.part`;
  let received = 0;
  let lastReport = 0;
  const counted = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  counted.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (total > 0 && now - lastReport > 1000) {
      lastReport = now;
      progress(`${label} … ${Math.round((received / total) * 100)}%`);
    }
  });
  await pipeline(counted, fs.createWriteStream(partial));
  fs.renameSync(partial, dest);

  progress(`${label} … ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB`);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

async function extract(archive: string, into: string): Promise<void> {
  if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archive}' -DestinationPath '${into}' -Force`,
      ]);
    } else {
      await run("unzip", ["-o", archive, "-d", into]);
    }
  } else {
    await run("tar", ["-xzf", archive, "-C", into]);
  }
}

/** The .onnx voices already in tools/piper/voices. */
export function installedPiperVoices(): string[] {
  const dir = piperVoicesDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".onnx")).sort() : [];
}

/** Install the engine if it is missing, then any voices not yet present. Returns the voices installed afterwards. */
export async function installPiper(
  voices: string[] = DEFAULT_PIPER_VOICES,
  progress: PiperProgress = () => {},
): Promise<string[]> {
  for (const voice of voices) {
    if (!isPiperVoiceName(voice)) throw new Error(`"${voice}" is not a Piper voice name, e.g. en_US-ryan-high.`);
  }

  const binary = path.join(piperDir(), piperBinary());

  if (fs.existsSync(binary)) {
    progress(`Speech engine already installed`);
  } else {
    const asset = platformAsset();
    const archive = path.join(os.tmpdir(), asset);

    await download(
      `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/${asset}`,
      archive,
      "Speech engine",
      progress,
    );

    fs.mkdirSync(piperToolsDir(), { recursive: true });
    progress("Unpacking the speech engine");
    await extract(archive, piperToolsDir());
    fs.rmSync(archive, { force: true });

    if (!fs.existsSync(binary)) {
      throw new Error(`Unpacking did not produce ${binary}`);
    }
    if (process.platform !== "win32") {
      fs.chmodSync(binary, 0o755);
    }
  }

  for (const voice of voices) {
    const target = path.join(piperVoicesDir(), `${voice}.onnx`);
    if (fs.existsSync(target) && fs.existsSync(`${target}.json`)) {
      progress(`Voice ${voice} already installed`);
      continue;
    }
    const urlPath = voiceUrlPath(voice);
    // Metadata first: it is tiny, and a voice without it cannot be used.
    await download(`${VOICE_BASE}/${urlPath}.onnx.json`, `${target}.json`, `Voice ${voice} settings`, progress);
    await download(`${VOICE_BASE}/${urlPath}.onnx`, target, `Voice ${voice}`, progress);
  }

  return installedPiperVoices();
}
