/**
 * Who may talk to the station's local API.
 *
 * The station listens on 127.0.0.1 only and has no login: it is a tool for the person at this PC. A loopback
 * bind does not by itself stop a web browser, though. Two things can still reach it from a page the user happens
 * to visit:
 *
 *  - DNS rebinding: the page points its own host name at 127.0.0.1, after which the browser treats the station as
 *    the page's own server and lets the page read and write everything. The Host header then names something other
 *    than this PC, so we refuse any request whose Host is not a local name.
 *  - Cross-site writes: a page can fire a POST at http://127.0.0.1:3000 without any permission (no body and no JSON
 *    means no pre-flight), and the station would run it - reset the configuration, clear memory, fill the music folder.
 *    Browsers label such requests (Sec-Fetch-Site, Origin), so a state-changing request from another origin is refused.
 *
 * Programs that are not browsers (the self-tests, the world bridge, the Godot client, curl) send neither header and are
 * unaffected. The world API under /api/world/v1 is the one place another origin may write, and it needs its own key.
 */

const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const WORLD_API_PREFIX = "/api/world/v1/";

export type GuardInput = {
  method: string;
  path: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
};

export type GuardVerdict = { ok: true } | { ok: false; status: 403; reason: string };

/** "localhost:3000" -> "localhost", "[::1]:3000" -> "[::1]". */
export function hostNameOf(hostHeader: string | undefined): string {
  const host = String(hostHeader ?? "").trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

export function isLocalHost(hostHeader: string | undefined): boolean {
  return LOCAL_NAMES.has(hostNameOf(hostHeader));
}

/** An Origin value that belongs to a page served from this PC (any port). */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_NAMES.has(hostNameOf(url.host));
  } catch {
    return false;
  }
}

export function checkRequest(input: GuardInput): GuardVerdict {
  if (!isLocalHost(input.host)) {
    return { ok: false, status: 403, reason: "The station only answers on this PC (localhost)." };
  }

  const method = input.method.toUpperCase();
  if (READ_ONLY_METHODS.has(method) || input.path.startsWith(WORLD_API_PREFIX)) return { ok: true };

  const site = input.secFetchSite?.toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return { ok: false, status: 403, reason: "A web page from another site may not change the station." };
  }

  if (input.origin !== undefined) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(input.origin).host.toLowerCase() === String(input.host ?? "").trim().toLowerCase();
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return { ok: false, status: 403, reason: "A web page from another site may not change the station." };
    }
  }

  return { ok: true };
}

/** Express middleware form of {@link checkRequest}. Typed loosely so this file needs no Express import. */
export function requestGuard(
  req: { method: string; path: string; headers: Record<string, string | string[] | undefined> },
  res: { status(code: number): { json(body: unknown): unknown } },
  next: () => void,
): void {
  const one = (name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const verdict = checkRequest({
    method: req.method,
    path: req.path,
    host: one("host"),
    origin: one("origin"),
    secFetchSite: one("sec-fetch-site"),
  });
  if (verdict.ok) return next();
  res.status(verdict.status).json({ error: verdict.reason });
}
