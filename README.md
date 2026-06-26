# pi-deployment-manager

A standalone, **heavily-gated single-purpose** deployment service built on [pi](../pi-references).
Any of your projects hands off a deploy over local RPC — *"deploy this"* / *"redeploy after
update"* — and the manager does the work and returns a structured result. The calling project
agent carries **zero** deployment knowledge or secrets.

Sibling to `pi-4b-tester` / `pi-e2e-tester`; reuses their localhost-HTTP transport. See
[`DESIGN.md`](./docs/DESIGN.md) for the locked design and [`architecture.html`](./docs/architecture.html) for
the visual overview.

## Why gated

The manager LLM has **no raw `bash`/`read`/`write`/`edit`/`glob`** — it is launched with
`--no-builtin-tools`, so the only tools that *exist* are the ten deployment verbs the extension
registers. Their code enforces a path sandbox (it may only write a project's `deploy/` directory,
`.gitignore`, and `.env.production`) and three fail-closed guards. The wrong action is
*unrepresentable*, not merely discouraged. One purpose, one agent, one deploy at a time.

Talking to Coolify and Cloudflare is **native HTTP in the verb code** — no shelling out, no external
skill scripts. The only bundled script is `assets/deploy.sh` (docker build → GHCR push → Coolify
webhook), copied into each project's `deploy/` as its own deploy command. The LLM reaches none of it:
a skill is "a prompt telling an LLM to run bash", exactly the capability the gate removes. The manager
is fully standalone — clone, `npm install`, run; nothing outside the repo.

## The ten verbs

`detect` · `scaffold` · `convex` · `provision` · `env` · `dns` · `deploy` · `redeploy` · `status` ·
`logs`. `read ≠ write`: `detect`/`status`/`logs` never mutate infra.

- **Initial deploy:** `detect → scaffold → [convex] → provision → env → dns → deploy`
- **Update deploy:** `detect → [convex if backend changed] → redeploy`

Idempotency (initial vs update) is decided **live against Coolify** — `deploy/.env.deploy` is only a
hint. The client result is built **in code from a per-deploy ledger** the verbs write, never parsed
from LLM prose; a deploy is `ok` **only** when the deploy-health guard confirms the app is serving.

## Profiles & addons

Auto-detected from the project (one frontend profile + optional backend addons). Add a target = drop
one profile file.

| frontend profile | detect | runtime |
|---|---|---|
| `static-html` | bare `index.html` | nginx |
| `react-spa` | `vite`/`react-scripts` + `react` | bun build → nginx |
| `astro-static` | `astro.config`, no SSR adapter | bun → nginx |
| `nextjs-node` (default) | `next` dep | standalone, run with `bun server.js` |
| `nextjs-static` | `next.config` `output:'export'` | bun build → nginx |

Addons: `convex-cloud` (deploy Convex Cloud backend-first, inject its prod URL as a build-time env)
and `sqlite-volume` (mount a persistent Coolify volume for the db file).

## Guards (fail-closed, in code)

1. **subdomain-collision** — refuse if the caller's subdomain already maps to a *different* Coolify app.
2. **wrong-target** — every mutating call must target the app bound to *this* `project_dir`.
3. **deploy-health** — after a ship, wait for Coolify to settle then probe the URL; unhealthy ⇒ fail + capture logs.

## Setup

Prerequisites on the host that runs the manager:

- [`pi`](../pi-references), `bun`
- `docker`, logged in to GHCR: `docker login ghcr.io` (the image build host)
- `curl` — used by the bundled `deploy.sh` to trigger the Coolify webhook
- `gh`, authenticated (`gh auth login`) — for the GHCR image repo
- `npx` (for `convex deploy`, only if you deploy Convex projects)

Then:

```sh
npm install
cp config.json.example config.json   # fill in your Coolify/Cloudflare/GHCR/Convex creds (gitignored)
npm run typecheck
```

`config.json` is the **single source of truth** for all creds — the manager injects them into each
project's gitignored `deploy/.env.deploy` at deploy time and never commits them.

## Handing off a deploy

From any project, a project agent runs:

```sh
/path/to/pi-deployment-manager/pi-deploy.sh <project_dir> <subdomain> "<intent>"
# e.g.
pi-deploy.sh /abs/path/to/my-app myapp "initial deploy"
pi-deploy.sh /abs/path/to/my-app myapp "redeploy after update"
```

`pi-deploy.sh` spawns the manager if it isn't already running (spawn-on-demand, not a daemon), waits
for it to publish its endpoint (`<stateDir>/endpoint.json`), POSTs the deploy, and prints the JSON
result. The POST **blocks until the deploy completes** (synchronous RPC) — the caller needs no
server of its own. For programmatic use, import `deploy()` from [`manager/client.ts`](./manager/client.ts).

> The manager runs as an interactive `pi` session. If your environment can't run `pi` headless
> (no TTY), launch it once in a window with `./launch-manager.sh`; `pi-deploy.sh` reuses a live endpoint.

The result:

```json
{ "status": "ok|failed", "phase": "...", "url": "https://<subdomain>.<domain>",
  "app_uuid": "...", "health": "healthy|unhealthy", "logs_tail": "...(on failure)" }
```

## Status

Built and verified: whole-project typecheck clean; runtime smoke tests cover profile detection,
Dockerfile generation, addon detection, the sandbox gate, and tool registration. A real end-to-end
deploy requires live Coolify/Cloudflare/GHCR/Convex credentials + Docker and is the operator's
acceptance step.
