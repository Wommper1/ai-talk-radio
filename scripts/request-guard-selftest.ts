/**
 * Offline self-test for the station's request guard (server/lib/request-guard.ts).
 * No models, no network beyond a throwaway server on 127.0.0.1. Run with: npm run guard-selftest
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { checkRequest, hostNameOf, isLocalHost, isLocalOrigin, requestGuard } from "../server/lib/request-guard.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures++;
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/* ── Pure rules ─────────────────────────────────────────────── */

check("host names are read without their port", hostNameOf("localhost:3000") === "localhost" && hostNameOf("[::1]:3000") === "[::1]" && hostNameOf("127.0.0.1") === "127.0.0.1");
for (const host of ["localhost", "localhost:3000", "LOCALHOST:3001", "127.0.0.1:3000", "[::1]:3000"]) {
  check(`Host ${host} is this PC`, isLocalHost(host));
}
for (const host of ["rebound.example", "rebound.example:3000", "192.168.1.20:3000", "0.0.0.0:3000", "localhost.evil.example", "127.0.0.1.evil.example:3000", "", undefined]) {
  check(`Host ${host ?? "(none)"} is refused`, !isLocalHost(host as string | undefined));
}
check("a page from localhost is a local origin", isLocalOrigin("http://localhost:8060") && isLocalOrigin("http://127.0.0.1:3000"));
check("another site, null and junk are not local origins", !isLocalOrigin("https://evil.example") && !isLocalOrigin("null") && !isLocalOrigin("http://localhost.evil.example") && !isLocalOrigin("not a url") && !isLocalOrigin(undefined));

const own = { host: "localhost:3000" };
check("a read from this PC is allowed", checkRequest({ method: "GET", path: "/api/config", ...own }).ok);
check("a read under a foreign Host is refused (DNS rebinding)", !checkRequest({ method: "GET", path: "/api/config", host: "rebound.example" }).ok);
check("a write from the station's own page is allowed", checkRequest({ method: "POST", path: "/api/config/reset", ...own, origin: "http://localhost:3000", secFetchSite: "same-origin" }).ok);
check("a write from a tool with no browser headers is allowed", checkRequest({ method: "POST", path: "/api/generate", ...own }).ok);
check("a write labelled cross-site is refused", !checkRequest({ method: "POST", path: "/api/config/reset", ...own, secFetchSite: "cross-site" }).ok);
check("a write labelled same-site (another port) is refused", !checkRequest({ method: "POST", path: "/api/config/reset", ...own, secFetchSite: "same-site" }).ok);
check("a write from another origin is refused", !checkRequest({ method: "POST", path: "/api/memory/clear", ...own, origin: "https://evil.example" }).ok);
check("a write from another local port is refused", !checkRequest({ method: "POST", path: "/api/memory/clear", ...own, origin: "http://localhost:5173" }).ok);
check("a write from origin null is refused", !checkRequest({ method: "POST", path: "/api/memory/clear", ...own, origin: "null" }).ok);
check("a delete from another origin is refused", !checkRequest({ method: "DELETE", path: "/api/music/files/x.mp3", ...own, origin: "https://evil.example" }).ok);
check("the world API may be written from another local origin (it has its own key)", checkRequest({ method: "POST", path: "/api/world/v1/commands", ...own, origin: "http://localhost:8060", secFetchSite: "same-site" }).ok);
check("the world API is still refused under a foreign Host", !checkRequest({ method: "POST", path: "/api/world/v1/commands", host: "rebound.example", origin: "http://rebound.example" }).ok);
check("a prefix look-alike is not the world API", !checkRequest({ method: "POST", path: "/api/world/v1x/commands", ...own, origin: "https://evil.example" }).ok);

/* ── Through a real HTTP server ─────────────────────────────── */

function send(port: number, method: string, urlPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

const app = express();
app.use(requestGuard);
const ran: string[] = [];
app.get("/api/ping", (_req, res) => res.json({ ok: true }));
app.post("/api/config/reset", (_req, res) => {
  ran.push("reset");
  res.json({ ok: true });
});
app.post("/api/world/v1/commands", (_req, res) => res.json({ ok: true }));

const server = await new Promise<http.Server>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
try {
  const port = (server.address() as { port: number }).port;
  const local = `127.0.0.1:${port}`;

  check("HTTP: a normal read works", (await send(port, "GET", "/api/ping", { host: local })) === 200);
  check("HTTP: a rebound host name is refused", (await send(port, "GET", "/api/ping", { host: "rebound.example" })) === 403);
  check("HTTP: a tool's write works", (await send(port, "POST", "/api/config/reset", { host: local })) === 200 && ran.length === 1);
  const cross = await send(port, "POST", "/api/config/reset", { host: local, origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  check("HTTP: a cross-site write is refused and does not run", cross === 403 && ran.length === 1, `status ${cross}, handler ran ${ran.length}x`);
  check("HTTP: the station's own page can still write", (await send(port, "POST", "/api/config/reset", { host: local, origin: `http://${local}`, "sec-fetch-site": "same-origin" })) === 200 && ran.length === 2);
  check("HTTP: the world API accepts another local origin", (await send(port, "POST", "/api/world/v1/commands", { host: local, origin: "http://localhost:8060", "sec-fetch-site": "same-site" })) === 200);
} finally {
  server.close();
}

/* ── The guard is actually wired into the station ───────────── */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server.ts"), "utf8");
const guardAt = source.indexOf("app.use(requestGuard)");
const jsonAt = source.indexOf("app.use(express.json(");
check("server.ts installs the guard before any body is parsed or route is added", guardAt !== -1 && jsonAt !== -1 && guardAt < jsonAt);
check("server.ts no longer answers every origin with a wildcard", !/Access-Control-Allow-Origin",\s*"\*"/.test(source));
check("server.ts still listens on 127.0.0.1 only", /\.listen\(port,\s*"127\.0\.0\.1"/.test(source));

console.log(`\n─── ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`} ───\n`);
process.exit(failures === 0 ? 0 : 1);
