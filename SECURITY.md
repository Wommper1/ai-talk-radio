# Security

## How the station is meant to run

Local Talk Radio is a desktop tool for the person sitting at the computer. By
design:

- The server listens on `127.0.0.1` only. It is not reachable from your
  network.
- There is **no login**. Anything that can reach the server can change
  settings, delete shows, clear memory and run the language model.
- It refuses requests whose `Host` header is not a local name (to block DNS
  rebinding), and refuses state-changing requests that a browser marks as
  coming from another site. See `server/lib/request-guard.ts`.
- The optional world API under `/api/world/v1` takes a bearer token from
  `WORLD_API_TOKEN` or `data/world_api_token.txt`. Both are git-ignored.

**Do not expose the station to a network or the internet.** That includes
port-forwarding, binding it to `0.0.0.0`, tunnelling services, and public
reverse proxies. None of that is supported, and doing it gives strangers
control of the app and your machine's model server.

## Secrets

Keep keys out of the repository. Put them in `.env` (copy `.env.example`) or
enter them on the Settings screen, which saves them to `config.json`. Both
files are git-ignored. Every variable in `.env.example` is optional; the
standard local setup needs no keys at all.

## Reporting a vulnerability

Please report security problems privately rather than in a public issue. Use
**Report a vulnerability** on this repository's **Security** tab on GitHub.
Include the version or commit, your operating system, and steps to reproduce.

Issues that are in scope include:

- a web page you visit being able to read from or write to the station
- a path in a request escaping the station's own folders
- a crafted show, sponsor or document making the station run code or write
  outside its folders
- the request guard being bypassed

Running the station on a public network on purpose is out of scope, because it
is unsupported.
