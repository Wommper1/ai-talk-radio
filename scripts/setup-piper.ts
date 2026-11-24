/**
 * Download the Piper speech engine and a couple of voices into tools/piper.
 *
 * The tools folder is deliberately not in version control, so this exists to
 * put it back on a fresh clone, or to add more voices later.
 *
 *   npm run setup-piper
 *   npm run setup-piper -- en_US-lessac-medium      add one more voice
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const PIPER_RELEASE = "2023.11.14-2";
const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

const DEFAULT_VOICES = ["en_US-ryan-high", "en_US-amy-medium"];

const toolsDir = path.join(process.cwd(), "tools");
const piperDir = path.join(toolsDir, "piper");
const voicesDir = path.join(piperDir, "voices");

function platformAsset(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "amd64";
  switch (process.platform) {
    case "win32":
      return "piper_windows_amd64.zip";
    case "darwin":
      return `piper_macos_${process.arch === "arm64" ? "aarch64" : "x64"}.tar.gz`;
    default:
      return `piper_linux_x86_64.tar.gz`.replace("x86_64", arch === "aarch64" ? "aarch64" : "x86_64");
  }
}

/** Map a voice name like en_US-ryan-high to its path under the voices repo. */
function voiceUrlPath(name: string): string {
  const [locale, speaker, quality] = name.split("-");
  const language = locale.split("_")[0];
  return `${language}/${locale}/${speaker}/${quality}/${name}`;
}

async function download(url: string, dest: string, label: string): Promise<void> {
  process.stdout.write(`  ${label} ... `);

  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    // Node's fetch says only "fetch failed"; the useful part (DNS, refused, TLS) is in `cause`.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (err as Error).message;
    throw new Error(`could not download ${url} (${detail}). Check your internet connection or proxy, then run this again.`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(dest));

  const mb = fs.statSync(dest).size / 1e6;
  console.log(`${mb.toFixed(1)} MB`);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
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

async function main() {
  const extraVoices = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const voices = extraVoices.length > 0 ? extraVoices : DEFAULT_VOICES;

  console.log("\nSetting up Piper\n");

  const binary = process.platform === "win32" ? "piper.exe" : "piper";

  if (fs.existsSync(path.join(piperDir, binary))) {
    console.log(`  engine already present at ${piperDir}`);
  } else {
    const asset = platformAsset();
    const archive = path.join(os.tmpdir(), asset);

    await download(
      `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/${asset}`,
      archive,
      `engine (${asset})`,
    );

    fs.mkdirSync(toolsDir, { recursive: true });
    await extract(archive, toolsDir);
    fs.rmSync(archive, { force: true });

    if (!fs.existsSync(path.join(piperDir, binary))) {
      throw new Error(`Extraction did not produce ${path.join(piperDir, binary)}`);
    }
    if (process.platform !== "win32") {
      fs.chmodSync(path.join(piperDir, binary), 0o755);
    }
    console.log(`  extracted to ${piperDir}`);
  }

  for (const voice of voices) {
    const target = path.join(voicesDir, `${voice}.onnx`);
    if (fs.existsSync(target)) {
      console.log(`  voice ${voice} already present`);
      continue;
    }
    const urlPath = voiceUrlPath(voice);
    await download(`${VOICE_BASE}/${urlPath}.onnx`, target, `voice ${voice}`);
    await download(`${VOICE_BASE}/${urlPath}.onnx.json`, `${target}.json`, `      ${voice} metadata`);
  }

  const installed = fs.existsSync(voicesDir)
    ? fs.readdirSync(voicesDir).filter((f) => f.endsWith(".onnx"))
    : [];

  console.log(`\nReady. ${installed.length} voice(s) in ${voicesDir}`);
  console.log("Browse more at huggingface.co/rhasspy/piper-voices\n");
}

main().catch((err) => {
  console.error(`\nSetup failed: ${(err as Error).message}\n`);
  process.exit(1);
});
