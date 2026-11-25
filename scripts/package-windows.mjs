/**
 * Build the portable Windows download: one folder (and zip) that runs with a
 * double-click, with Node.js inside it. No Node install, no npm, no terminal.
 *
 *   npm run build && npm run package:windows
 *
 * What goes in:
 *   server.mjs                  the whole server, bundled into one file
 *   dist/                       the prebuilt web app
 *   node/node.exe               the Node.js runtime this script runs under
 *   launcher/launch.ps1         the normal launcher, which detects the portable layout
 *   Start Local Talk Radio.cmd  the thing people double-click
 *   Set up Edge voices.cmd      optional: the more natural online voices
 *   THIRD-PARTY-NOTICES.txt     licenses of everything bundled
 *
 * Meant to run on Windows (CI does it on every release). Elsewhere it still
 * builds the folder, with that platform's node, so the bundle can be tested.
 *
 * Options:  --out <dir>   where to put it (default: release/)
 *           --no-zip      leave the folder, skip the zip
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = process.cwd();
const args = process.argv.slice(2);
const outRoot = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : "release");
const makeZip = !args.includes("--no-zip");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const isWindows = process.platform === "win32";
const name = `LocalTalkRadio-${pkg.version}-${isWindows ? "windows" : process.platform}-${process.arch}`;
const out = path.join(outRoot, name);

const step = (text) => console.log(`  ${text}`);
const copy = (from, to = from) => {
  const src = path.join(root, from);
  const dest = path.join(out, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
};

console.log(`\nPackaging ${name}\n`);

if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  console.error("  dist/ is missing. Run `npm run build` first.\n");
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/* ── 1. The server, as one file ───────────────────────────────── */

step("Bundling the server");
const result = await build({
  entryPoints: [path.join(root, "server.ts")],
  outfile: path.join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "none", // collected into THIRD-PARTY-NOTICES.txt instead
  metafile: true,
  // Vite only runs when dist/ is missing, which never happens here; keep it (and its native parts) out.
  // LAME (the MP3 encoder) is LGPL: it ships as its own replaceable module beside server.mjs, not inside it.
  external: ["vite", "@vitejs/plugin-react", "@tailwindcss/vite", "lightningcss", "fsevents", "@breezystack/lamejs"],
  // Bundled CommonJS packages (express) still call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __ltrCreateRequire } from 'node:module'; const require = __ltrCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});

/* ── 2. The app and the files it reads ───────────────────────── */

step("Copying the web app and support files");
copy("dist");
copy("launcher/launch.ps1");
copy("scripts/setup-edge-tts.ps1");
copy("scripts/world_command_bridge.py");
copy("LICENSE", "LICENSE.txt");
copy("README.md");
copy("docs/GUIDE.md", "docs/GUIDE.md");
copy("docs/guides", "docs/guides");
copy("docs/REALM.md", "docs/REALM.md");
copy("docs/WORLD_API_V1.md", "docs/WORLD_API_V1.md");
copy(".env.example");
// Unbundled LGPL module (see `external` above), with its license and source as published.
copy("node_modules/@breezystack/lamejs");

/* ── 3. Node.js itself ─────────────────────────────────────────── */

step(`Adding Node.js ${process.version}`);
const nodeDir = path.join(out, "node");
fs.mkdirSync(nodeDir, { recursive: true });
fs.copyFileSync(process.execPath, path.join(nodeDir, isWindows ? "node.exe" : "node"));

// Node's own license must travel with it. Installers put it beside the binary
// (Windows) or one folder up (Unix); fetch it as a last resort.
const nodeLicense = [path.join(path.dirname(process.execPath), "LICENSE"), path.join(path.dirname(process.execPath), "..", "LICENSE")].find(
  (p) => fs.existsSync(p),
);
if (nodeLicense) {
  fs.copyFileSync(nodeLicense, path.join(nodeDir, "LICENSE.txt"));
} else {
  const res = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!res.ok) throw new Error(`Could not find or download the Node.js license (HTTP ${res.status}).`);
  fs.writeFileSync(path.join(nodeDir, "LICENSE.txt"), await res.text());
}

/* ── 4. What people double-click ──────────────────────────────── */

step("Writing the launchers");
const crlf = (text) => text.replace(/\r?\n/g, "\r\n");

fs.writeFileSync(
  path.join(out, "Start Local Talk Radio.cmd"),
  crlf(`@echo off
rem Starts the station and opens it in Chrome or Edge. Close the window to stop it.
title Local Talk Radio
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\\launch.ps1"
if errorlevel 1 pause
`),
);

fs.writeFileSync(
  path.join(out, "Set up Edge voices.cmd"),
  crlf(`@echo off
rem Optional: installs the more natural Edge voices. Needs Python from python.org.
title Local Talk Radio - Edge voices
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\setup-edge-tts.ps1"
echo.
pause
`),
);

fs.writeFileSync(
  path.join(out, "READ ME FIRST.txt"),
  crlf(`Local Talk Radio ${pkg.version}
${"=".repeat(`Local Talk Radio ${pkg.version}`.length)}

Two AI hosts talk to each other and the station turns it into a radio show.

1. Install LM Studio from https://lmstudio.ai, download a model (for example
   "Qwen2.5 7B Instruct"), then on its Developer tab load the model and press
   Start Server.

2. Double-click "Start Local Talk Radio". Your browser opens on a setup screen
   that finds LM Studio, picks the model and downloads offline voices.

3. Press "Go to the studio", type a topic, and press "Start the show".

Keep this folder somewhere you can write to, such as Documents. Your shows,
settings and voices are saved inside it. Close the black window to stop the
station.

If Windows says it protected your PC, choose "More info" and then "Run anyway".
This download is not code-signed.

Optional: "Set up Edge voices" installs Microsoft's more natural online voices.
It needs Python from https://www.python.org.

Step-by-step help: docs/guides/GETTING_STARTED.md
How to do things:  docs/guides/HOW_TO.md
If something goes wrong: docs/guides/TROUBLESHOOTING.md
Full guide: docs/GUIDE.md
Source code and help: https://github.com/Wommper1/ai-talk-radio
`),
);

/* ── 5. Licenses of everything bundled ────────────────────────── */

step("Collecting third-party licenses");
const packages = new Map(); // dir -> {name, version, license}

// Every package whose code ended up in server.mjs...
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.set(path.resolve(root, match[1]), null);
}
// ...and every production dependency of the web app in dist/.
const prodTree = JSON.parse(
  execFileSync(isWindows ? "npm.cmd" : "npm", ["ls", "--omit=dev", "--all", "--json", "--long"], {
    cwd: root,
    encoding: "utf8",
    shell: isWindows,
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const walk = (node) => {
  for (const dep of Object.values(node.dependencies ?? {})) {
    if (dep.path && !dep.extraneous) packages.set(dep.path, null);
    walk(dep);
  }
};
walk(prodTree);

const licenseFile = (dir) =>
  fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(f));

const notices = [];
for (const dir of [...packages.keys()].sort()) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  // Native helper packages for other platforms are installed but never shipped.
  if (meta.os && !meta.os.includes(process.platform)) continue;
  const file = licenseFile(dir);
  const text = file ? fs.readFileSync(path.join(dir, file), "utf8").trim() : `License: ${meta.license ?? "see package"}`;
  notices.push(`${meta.name}@${meta.version} (${meta.license ?? "unknown"})\n${"-".repeat(60)}\n${text}\n`);
}

fs.writeFileSync(
  path.join(out, "THIRD-PARTY-NOTICES.txt"),
  crlf(
    `Local Talk Radio bundles the following open-source software.\n` +
      `Node.js is included under its own license in node/LICENSE.txt.\n` +
      `Piper, its voices and edge-tts are downloaded later, on request, and are not part of this package.\n` +
      `The MP3 encoder (@breezystack/lamejs, LGPL-3.0) is not bundled into server.mjs: it is the separate, replaceable module in node_modules/@breezystack/lamejs.\n\n` +
      notices.join("\n"),
  ),
);
step(`${notices.length} packages listed`);

/* ── 6. Zip ────────────────────────────────────────────────────── */

const size = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
    const p = path.join(dir, e.name);
    return sum + (e.isDirectory() ? size(p) : fs.statSync(p).size);
  }, 0);
step(`Folder: ${out} (${(size(out) / 1e6).toFixed(1)} MB)`);

if (makeZip) {
  const zip = `${out}.zip`;
  fs.rmSync(zip, { force: true });
  if (isWindows) {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${out}' -DestinationPath '${zip}' -CompressionLevel Optimal`], {
      stdio: "inherit",
    });
  } else {
    execFileSync("zip", ["-qr9", zip, name], { cwd: outRoot, stdio: "inherit" });
  }
  step(`Zip: ${zip} (${(fs.statSync(zip).size / 1e6).toFixed(1)} MB)`);
}

console.log("\nDone.\n");
