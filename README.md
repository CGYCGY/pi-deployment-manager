# pi-deployment-manager

A standalone, **heavily-gated single-purpose** deployment service built on [pi](../pi-references).
A project agent **summons** it over pi's native RPC mode and **converses** with it in plain
language — *"deploy /abs/path/to/app at subdomain `myapp`"* / *"redeploy after update"* — and the
manager's own LLM drives the work, asks back when it is blocked, and returns a structured result.
The calling project agent carries **zero** deployment knowledge or secrets.

Driven agent-to-agent, mirroring how the sibling `pi-e2e-tester` is summoned over RPC. See
[`DESIGN.md`](./docs/DESIGN.md) for the locked design and [`architecture.html`](./docs/architecture.html) for
the visual overview.

## Why gated

The manager LLM has **no raw `bash`/`read`/`write`/`edit`/`glob`** — it is launched with
`--no-builtin-tools`, so the only tools that *exist* are the ten deployment verbs the extension
registers (and on session start `setActiveTools` re-pins the active set to exactly those ten,
belt-and-braces). Their code enforces a path sandbox (it may only write a project's `deploy/`
directory, `.gitignore`, and `.env.production`) and three fail-closed guards. The wrong action is
*unrepresentable*, not merely discouraged. One purpose, one agent, one deploy at a time.

Talking to Coolify and Cloudflare is **native HTTP in the verb code** — no shelling out, no external
skill scripts. The only bundled script is `assets/deploy.sh` (docker build → GHCR push → Coolify
webhook), copied into each project's `deploy/` as its own deploy command. The LLM reaches none of it:
a skill is "a prompt telling an LLM to run bash", exactly the capability the gate removes. The manager
is fully standalone — clone, `npm install`, run; nothing outside the repo.

## The ten verbs

`detect` · `scaffold` · `convex` · `provision` · `env` · `dns` · `deploy` · `redeploy` · `status` ·
`logs`. `read ≠ write`: `detect`/`status`/`logs` never mutate infra.

`detect` is the entry verb: the manager's LLM extracts `project_dir` (absolute), `subdomain`, and an
optional `env_file` from the caller's request and passes them to `detect`, which **binds the deploy
context** every later verb reads (the context persists across turns until the deploy concludes).

- **Initial deploy:** `detect → scaffold → [convex] → provision → env → dns → deploy`
- **Update deploy:** `detect → [convex if backend changed] → redeploy`

Idempotency (initial vs update) is decided **live against Coolify** — `deploy/.env.deploy` is only a
hint. The result is built **in code from a per-deploy ledger** the verbs write and emitted to the
caller on a `notify` channel — never parsed from LLM prose; a deploy is `ok` **only** when the
deploy-health guard confirms the app is serving.

## Profiles & addons

Auto-detected from the project (one primary profile + optional backend addons). Add a *framework*
target = drop one profile file.

| primary profile | detect | runtime |
|---|---|---|
| `static-html` | bare `index.html` | **generated** nginx |
| `react-spa` | `vite`/`react-scripts` + `react` | **generated** bun build → nginx |
| `astro-static` | `astro.config`, no SSR adapter | **generated** bun → nginx |
| `nextjs-node` (default) | `next` dep | **generated** standalone, `bun server.js` |
| `nextjs-static` | `next.config` `output:'export'` | **generated** bun build → nginx |
| `dockerfile` (fallback) | ships its own `Dockerfile` | **the project's own**, used verbatim — any stack |

The framework profiles **generate** a Dockerfile. The generic **`dockerfile`** profile instead honors
a project's **own** Dockerfile (`./Dockerfile`, else `./deploy/Dockerfile`) and reads what it declares
— `EXPOSE` → port, `VOLUME` → a persistent volume, `HEALTHCHECK` URL → the health probe — so a plain
Bun/Go/Python/Rust/… backend deploys with zero manager-side language knowledge. It's detected last, so
a framework repo carrying a Dockerfile still gets its build profile.

Addons: `convex-cloud` (deploy Convex Cloud backend-first, inject its prod URL as a build-time env)
and `sqlite-volume` (mount a persistent Coolify volume for the db file). A `dockerfile`-profile app
gets its volume straight from the Dockerfile's `VOLUME` line — no addon needed.

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

A project agent never deploys by hand — it uses the **`deploy-via-manager` skill**, whose driver
(a `bun` tool) summons the manager and relays the result. The driver, not this repo, owns the RPC
plumbing — the same split as `pi-e2e-tester`, whose driver lives in the consuming project's skill,
not the tester repo. The driver locates this checkout from the `PI_DEPLOYMENT_MANAGER_DIR` env var
or a skill-local config — never a hardcoded path.

The driver spawns the manager with **`pi --mode rpc`** (stdin/stdout JSONL — no HTTP server, no TCP
port, no token, no portfile) and sends a natural-language prompt:

> Deploy `/abs/path/to/my-app` at subdomain `myapp`; runtime secrets in `deploy/.env.runtime`.

The manager's LLM reads it, calls `detect` to bind the deploy, and runs the verbs. The driver's
subcommands: `up` (boot a manager, wait for its `PIDEPLOY_READY`), `send` / `deploy` (send a prompt
and capture the result), `down`, `clean`.

**Back-and-forth.** If the manager is blocked or something is ambiguous — no Dockerfile for a plain
backend, a subdomain collision, a missing `env_file`, unclear intent — it **asks the caller in plain
language and ends its turn**. The caller answers with a follow-up prompt (via `send`) and the manager
continues with full context: the deploy context persists across turns until the deploy concludes.

**Result.** A deploy **concludes** only when a ship verb (`deploy` / `redeploy`) health-checks the
app (or the build fails) — the only terminal points. The structured `DeployResult` is built **in code
from the verb ledger** and emitted on a `notify` channel as `PIDEPLOY_RESULT <json>`, which the driver
captures (the agent's plain text is only a summary or a question, never the result). On boot the
manager emits `PIDEPLOY_READY` so the driver can confirm it actually booted.

**Runtime env / secrets.** Name a **gitignored** dotenv file (`KEY=VALUE`) via `env_file` — a path
relative to `project_dir`. The manager reads it **itself, in-sandbox**, and bulk-sets the vars on
Coolify — so only the *path* travels (in the prompt), never the secret values, and nothing is committed.
Coolify is the live store; the file is an optional declarative seed (omit it on plain redeploys that
don't change env). `PUBLIC_BASE_URL` is **auto-derived** (`https://<subdomain>.<zone>`) and injected —
don't set it yourself.

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
