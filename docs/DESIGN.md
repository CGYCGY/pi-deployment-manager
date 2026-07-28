# pi-deployment-manager — Locked Design

> Standalone agentic **deployment service**, built on pi. A project agent **summons** the manager
> over pi's native RPC mode and **converses** with it in natural language; the manager owns all
> deployment knowledge, creds, and infra state, does the work, and returns a structured result.
> Sibling to `pi-4b-tester/` and `pi-e2e-tester/`; driven the same agent-to-agent way `pi-e2e-tester`
> is summoned over RPC.
>
> Status: **BUILT** (2026-06-25) — its own git repo on `main`. Implementation deviations from the
> original design are folded into the sections below: idempotency is decided **live against Coolify**
> (not a `.env.deploy` file signal), all generated Dockerfiles use **bun** (the stack standard), the
> manager is now summoned over **pi's native RPC mode** (stdin/stdout JSONL — no HTTP server, no
> port, no token; the earlier custom localhost-HTTP server was removed), the client **driver lives in
> the `deploy-via-manager` skill** (not this repo), and first-deploy files are **staged, not
> committed** (the caller owns the commit).

---

## 1. Problem & goal

**Today (inline):** the deploy skill bundle (`astro-setup` → `coolify-setup` → `coolify` +
`cloudflare`) is dropped into each project, and *that project's agent* runs the skills to do a
first-time deploy or a post-update redeploy. Deployment mechanics, Coolify/Cloudflare/GHCR creds,
and shared-infra state all sit in the project agent's context.

**Goal:** extract all of that into a standalone **`pi-deployment-manager`**. Every project just
hands off — "deploy this" / "redeploy after update" — over RPC, and it's done. The project agent
carries zero deployment knowledge or secrets.

This is the **realization of the pi-4b-tester roadmap line**: *"expose the hub via `-p`/RPC so other
agents can author plans, have the hub run them, and report back — a trusted automated service."*
Here the trusted service is deployment, and the clients are the user's own project agents.

---

## 2. Topology — service, not device-driver

The two existing testers are **hub + persistent-device-spoke**: the spoke holds a live external
target (phone/browser) open across many actions. The deployment manager is **different in shape**:

- It is the **service** (the "hub-as-RPC" end); the **caller is any project's agent** (the client).
- A deploy is a **task that runs to completion and returns** — there is no long-lived external
  device to keep open. So the manager does **not** need an internal device-spoke.
- **State of record lives in Coolify + Cloudflare**, not in the manager. The manager queries those
  APIs live for current state (which apps/subdomains exist). It owns *no* persistent infra state of
  its own beyond config + creds → cold start loses nothing.

```
project agent (client)                       pi-deployment-manager (service)
  │  NL prompt: "deploy <dir> at <subdomain>"   │  detect (binds ctx) → scaffold → [convex] →
  │  ── pi --mode rpc · stdin/stdout JSONL ────▶│  provision → env → dns → ship → health-check
  │  ◀── question (blocked/ambiguous) ──────────│  (asks the caller; turn ends; context persists)
  │  ── follow-up prompt (answer) ─────────────▶│  continues …
  │  ◀── PIDEPLOY_RESULT <json> on notify ──────│  (Coolify + Cloudflare = source of truth)
```

### 2.1 Lifecycle — spawn-on-demand, NOT a daemon

Deploys are infrequent (initial once; redeploy on update). Running a permanent daemon is infra to
babysit on the user's single box. Instead the **skill driver spawns** the manager as a `pi --mode
rpc` subprocess it owns: `up` boots one and keeps it alive across calls (a fix→redeploy loop reuses
it), or a one-shot `deploy` cold-starts and tears it down on the result. Because the source of truth
is the Coolify/Cloudflare APIs, spawn-on-demand is correct — there is no warm state to lose. *(Decision;
revisit only if a use case needs an always-on endpoint.)*

### 2.2 Transport — pi's native RPC mode

The manager is summoned over **`pi --mode rpc`**: the driver writes prompts to the subprocess's
stdin and reads its event stream (assistant turns + `notify` events) off stdout, as JSONL. There is
**no HTTP server, no network port, no auth token, no portfile** — the driver owns the process pipes.
The structured result rides a `notify` event (`PIDEPLOY_RESULT <json>`) the driver greps for; a
`PIDEPLOY_READY` notify on `session_start` lets the driver confirm the session actually booted (an
interactive `pi` launch silently died on stdin EOF — the failure this replaces).

---

## 3. The interface — natural-language conversation, no typed wire

There is no bespoke wire union: the caller's request is a **prompt**, and the manager's own LLM
interprets it ("initial deploy", "redeploy after update", "set env X and redeploy") and drives the
verbs. This is exactly the user's framing: *"ask the llm to do initial or after-update deployment."*
The entry verb **`detect` takes the deploy's coordinates as params** — the LLM extracts them from the
prompt, and `detect` binds them as the context every later verb reads (§7).

**Conversational, not one-shot.** When the manager is blocked or the request is ambiguous — no
Dockerfile for a plain backend, a subdomain collision, a missing/empty `env_file`, unclear intent —
it asks the caller in plain language and **ends its turn**. The caller replies with a follow-up
prompt and the manager continues with full context; the deploy context persists across turns until
the deploy concludes (§10).

**Deferred** (like the testers deferred `run_test`): a **deterministic structured door** — a typed
deploy spec the driver builds, no LLM interpretation — for CI/scripted use. Add once the NL flow is
field-proven.

### 3.1 What the prompt conveys → `detect`'s params

The LLM extracts these from the caller's request and passes them to `detect`, which binds the deploy:

| Field         | Required | Notes                                                                 |
|---------------|----------|-----------------------------------------------------------------------|
| `project_dir` | yes      | **Absolute** path to the caller's repo. Manager operates in place — no clone. |
| `subdomain`   | yes      | Caller-specified hostname label (locked decision). Manager validates against collisions. |
| `env_file`    | no       | Path **relative to `project_dir`** of a gitignored runtime dotenv file. The manager reads it **in-sandbox** and bulk-sets the vars on Coolify — only the *path* rides the prompt, never the secret values. |

`intent` is not a param — it is the prose of the prompt body the LLM reads (and idempotency is decided
live against Coolify regardless, §4). Inline extra env vars are an `env`-verb param (§7), not part of
the handoff.

### 3.2 Result (manager → caller) — clean, code-derived

A deploy ends with a single structured result, built **in code** from the verb ledger (never parsed
from the LLM's prose — the testers' `VERDICT:` parse was the #1 runtime risk; this sidesteps it
entirely) and emitted on a `notify` event as `PIDEPLOY_RESULT <json>` that the driver captures:

```json
{ "status": "ok|failed", "phase": "...", "url": "https://<subdomain>.<domain>",
  "app_uuid": "...", "deployment_id": "...", "health": "healthy|unhealthy",
  "logs_tail": "...(only on failure)" }
```

---

## 4. Project access — both modes, operate in place

The manager works **directly in the caller's `project_dir`** (the caller already has the repo
checked out; just pass the path). No clone.

- **Initial deploy** needs repo write: scaffold `deploy/Dockerfile`, **stage** the deploy/ files
  (`git add`; the caller owns the commit), create the GitHub repo if absent, provision Coolify,
  allocate DNS, first ship.
- **Update deploy** is **API-only**: the deploy is image-based — `deploy/deploy.sh` builds the image,
  pushes to **GHCR**, and triggers the Coolify webhook. Redeploy just re-runs that path.

**Idempotency (decided live against Coolify):** `detect` reads `COOLIFY_APP_UUID` from
`deploy/.env.deploy` as a hint, then confirms the app exists via the Coolify API — confirmed ⇒
redeploy path, else initial. Coolify is authoritative; the file is only a hint.

---

## 5. Execution layer — gated custom-tool surface, native engine in code

**The manager is a heavily-gated, single-purpose agent.** Its LLM has **no raw Bash / Edit / Read /
Glob** and cannot roam the filesystem. It sees **only** the semantic verbs of §7 — custom tools
implemented in code (the pi-e2e-tester spoke philosophy: a closed, semantic surface, not raw device
access). One purpose, one agent, one deploy at a time.

**The engine is the verbs' own code, not skill scripts.** A skill is a *prompt that tells an LLM to
run bash* — exactly the capability being removed — so the manager carries none. Talking to Coolify
and Cloudflare is **native HTTP** (`fetch`) inside the tool code; the only subprocess left is the one
real local build step:

```
manager LLM ──can only call──▶ [ detect | scaffold | provision | dns | deploy | … ]   ← the gate
                                      │  (tool implementation, in code)
                                      ├── native fetch → Coolify API, Cloudflare API
                                      └── subprocess → deploy/deploy.sh (docker build → GHCR
                                          push → Coolify webhook), npx convex deploy, gh, git
```

The Coolify/Cloudflare REST calls the original `coolify`/`cloudflare` skills made with `curl` + `jq`
are ported into `manager/coolify.ts` and `manager/cloudflare.ts` as native `fetch`. The one script
that *cannot* become a fetch — `deploy.sh` (it runs `docker build`/`push`) — ships as a bundled asset
(`assets/deploy.sh`), copied into each project's `deploy/` as its own deploy command. Per-framework
Dockerfile templates live in `manager/profiles/`. The model has no path to any of it, and the manager
depends on **no external `skills_dir`** — clone, `npm install`, run.

### 5.0 Sandbox (the gate) — enforced in tool code, not trusted to the LLM

| capability | scope |
|------------|-------|
| **read**   | the target `project_dir`, **read-only** — `detect` must inspect `package.json` / `next.config` / `astro.config` / `convex/` / `index.html` to pick the profile. |
| **write**  | a fixed **allowlist**: `<project_dir>/deploy/*`, plus two project-root writes (`.gitignore` entries, `.env.production`), and `git add/commit` of those. **Nothing else.** |
| **network**| Coolify · Cloudflare · GHCR · Convex Cloud · GitHub (`gh`) APIs only. |
| **denied** | general Bash, Edit, Read, Glob, Write outside the allowlist. |

This allowlist **is** the "only touch `deploy/`, never other files" guarantee — a path check in the
tool implementation, not a rule the LLM is asked to honor.

### 5.1 Centralized creds (a key win of offloading)

Today each project's `deploy/.env.deploy` must hold the Coolify + Cloudflare tokens. With the
manager, **creds live in ONE place — the manager's config** — never copied per project. At deploy
time the manager **populates the project's gitignored `deploy/.env.deploy` from its central config**
for the bundled `deploy.sh` to source; its own Coolify/Cloudflare API calls read creds straight from
config. Projects stop carrying secrets. *(Locked.)*

---

## 6. DeployProfile registry — the DeviceProfile analog

The framework/backend spread maps to a small pluggable registry (mirrors pi-e2e-tester's
`spoke/profiles/` `DeviceProfile`). A project = **one primary profile + optional backend addon(s)**,
**auto-detected** from `project_dir`. Adding a *framework* target = drop one profile file.

`DeployProfile`: `{ id, detect(dir), dockerfile(dir), port, healthPath, inspect?(dir), resourceHint, needsVolume, buildHints }`.
`inspect(dir)` resolves **per-project** facts the profile reads from the repo (port/volume/health) —
the framework profiles omit it (static fields); the generic `dockerfile` profile implements it.

### Primary profiles

| id              | detect                                   | output / runtime           | Dockerfile           |
|-----------------|------------------------------------------|----------------------------|----------------------|
| `static-html`   | bare `index.html`, no build              | static                     | **generated** nginx  |
| `react-spa`     | vite/CRA, client-only                    | static SPA                 | **generated** bun → nginx |
| `astro-static`  | `astro.config`, no SSR adapter           | static                     | **generated** bun → nginx |
| `nextjs-node`   | `next` dep, server/App-Router features   | **standalone, run w/ bun** (default) | **generated** bun runtime |
| `nextjs-static` | `next.config` `output: 'export'`         | static                     | **generated** bun → nginx |
| `dockerfile`    | ships its own `Dockerfile` (fallback)    | **anything** (Bun/Go/Python/Rust/… server) | **the project's own**, used verbatim |

The framework profiles **generate** a Dockerfile (their value: a build pipeline the project doesn't
ship); every generated one builds with `oven/bun` (`bun install --frozen-lockfile`). The generic
**`dockerfile`** profile inverts this — it **honors the project's own Dockerfile** (`./Dockerfile`,
else `./deploy/Dockerfile`) and reads what it declares: `EXPOSE` → the app port, `VOLUME` → a
persistent volume, the `HEALTHCHECK` URL path → the health probe. So a plain backend in any language
deploys with zero manager-side language knowledge. It is detected **last** (fallback), so a framework
repo that happens to carry a Dockerfile still gets its build profile. Per-language *generator* profiles
(`go-server`, `python-server`, for repos that ship no Dockerfile) are a future layer on this floor.

### Backend addons (compose with any frontend)

| id              | trigger                          | behavior                                                                          |
|-----------------|----------------------------------|----------------------------------------------------------------------------------|
| `convex-cloud`  | `convex/` dir + `convex` dep     | **Backend-first**: `npx convex deploy` (Convex Cloud, `CONVEX_DEPLOY_KEY`) → capture prod URL → inject as **build-time** env into the frontend before its image build. |
| `sqlite-volume` | node/bun server with a `.db`/sqlite dep | Mount a **persistent Coolify volume** for the db file (survives redeploys). Note backup as a follow-up. |

A persistent volume can also come straight from the **`dockerfile` profile**: a `VOLUME ["/data"]`
line in the project's own Dockerfile is read by `inspect()` into the same `PERSISTENT_STORAGES` spec
(`<subdomain>-data:/data`) the sqlite addon emits. So a BYOD app declares its volume in the one place
it already does — no separate config, no addon needed.

**Known gap — one volume only.** `ProfileInspection.volumeSpec` is a single string, so a Dockerfile
declaring several paths (`VOLUME ["/root/.codex", "/root/.pi"]`) contributes at most one mount and the
remainder must be created by hand. Nothing surfaces the shortfall: the app builds, deploys, and reports
healthy, and the loss shows up only one redeploy later as whatever lived on the unmounted path — which
reads as data corruption or an upstream bug rather than a missing mount. This cost pi-image-gateway
three weeks of a re-login on every deploy. Fixing it means `volumeSpec: string[]` through `inspect()`
and provision; `createApp` already loops over a comma-separated `persistentStorages`, so the API side
is ready. A storage-management verb would also let the manager repair an existing app — today it can
only report the gap and ask the caller to fix it in Coolify.

**Convex = Convex Cloud** (locked) — managed, not self-hosted. The manager never deploys Convex onto
the Coolify box; it only runs `convex deploy` and wires the resulting URL into the frontend env.

---

## 7. Verb surface — the manager's ONLY tools (semantic, not skill-passthrough)

These ten verbs are the **complete** tool surface exposed to the manager LLM. There is no raw
Bash/Edit/Read alongside them (§5.0).

| verb       | r/w  | does                                                                              |
|------------|------|----------------------------------------------------------------------------------|
| `detect`   | read | **takes params `project_dir` / `subdomain` / `env_file`** (the LLM extracts them from the prompt) → **binds the deploy context**, then inspects `project_dir` → selects profile (+ resolves its per-project port/volume/health) + backend addons |
| `scaffold` | write| write `deploy/Dockerfile` from the profile — **generated** (framework) or the project's **own** (`dockerfile` profile) — plus `deploy.sh`, `.env.deploy` |
| `convex`   | write| `convex deploy` → capture prod URL (runs before frontend build)                  |
| `provision`| write| create Coolify app, image=`ghcr.io/<org>/<repo>`, set resource limits (initial)  |
| `env`      | write| set app env vars: auto `PUBLIC_BASE_URL` + caller's `env_file` runtime secrets (read in-sandbox) + injected Convex URL |
| `dns`      | write| create/update the Cloudflare record for the **caller-specified** subdomain; set Coolify domain |
| `deploy`   | write| build → push GHCR → trigger Coolify (runs `deploy/deploy.sh`)                     |
| `redeploy` | write| API-only redeploy trigger (update path)                                          |
| `status`   | read | Coolify deployment status                                                         |
| `logs`     | read | tail Coolify app logs                                                             |

`read ≠ write` (the testers' durable lesson): `status`/`logs`/`detect` are read-only and never
mutate infra. Only `detect` takes the deploy's coordinates; every later verb reads its target from
the **bound context** `detect` set (so they need no `project_dir`/`subdomain` of their own) — `env`
optionally takes inline `vars`, `logs` an optional `lines` count. The verbs **mutate a ledger** the
extension reads to build the result; they never return prose to parse.

---

## 8. Guards — fail-closed, in code, not LLM judgment

The single-server / single-domain reality makes **collisions the top silent failure mode**. Guards
are deterministic code (like the testers' identity/crash guards), fail closed:

1. **Subdomain-collision guard** — before `dns`/`provision`, query Cloudflare + Coolify; if the
   caller-specified subdomain already maps to a **different** project, **refuse**. (Caller specifies
   the subdomain, so a clash is caller error and must be caught, not silently clobbered.)
2. **Wrong-target guard** — every mutating Coolify/DNS call must target the app/record bound to
   *this* `project_dir`+subdomain (tracked via `deploy/.env.deploy`'s `COOLIFY_APP_UUID`/`DOMAIN`).
   Never modify another project's app on the shared server.
3. **Deploy-health guard** — after `deploy`/`redeploy`, poll Coolify deployment status + the
   `/healthz` endpoint; auto-**fail** the result if unhealthy (the profile Dockerfiles already add `HEALTHCHECK`
   + `/healthz`). This is the deployment analog of the crash-guard — catches a deploy that "succeeds"
   but serves a broken app.

---

## 9. Flows

**Initial deploy** — prompt says "initial deploy", Coolify has no app for this project (live check):
`detect (binds context) → scaffold Dockerfile → [convex deploy → capture URL] → populate
deploy/.env.deploy from central creds → provision Coolify app + limits → env (+ inject Convex URL) →
[subdomain-collision guard] → dns + set Coolify domain → create GitHub repo if absent → deploy
(build→GHCR→webhook) → [health guard] → conclude → emit result {url,…} on notify`.

**Update deploy** — prompt says "redeploy after update", Coolify already has the app (live check):
`detect (already set up) → [convex deploy if backend changed → re-inject URL] → redeploy (deploy.sh)
→ [health guard] → conclude → emit result`.

The ship verbs (`deploy`/`redeploy`) are the only terminal points: a deploy **concludes** when one
of them health-checks the app or the build fails — there is no other way to end a deploy.

---

## 10. Context-reset model

The manager session is long-lived across a client session but **each deploy is an independent
task** → per-deploy context isolation. Within a deploy the context **persists across turns** so the
caller can answer a blocking question and the manager resumes mid-flow (§3); the bound `currentDeploy`
is held until the deploy concludes. Then, mirroring the testers, the `agent_end` hook **`compact()`s**
with strong "brand-new unrelated deploy, discard prior" instructions (the any-context reset primitive;
`newSession` is gated to command contexts) so the next, unrelated deploy in the same session starts
clean. A deploy is never reset mid-flow (would orphan an in-flight ship) — `compact()` fires only
*after* a ship concluded it.

---

## 11. Config (`config.json`, single source of truth)

Manager-owned config; no hardcoded paths/creds (no transport keys — RPC is over stdio, so there is
no port or token to configure):

- `stateDir` — where the manager writes its logs (`<stateDir>/logs/manager.log`).
- `coolify.{base_url, api_token, server_uuid, dest_uuid}` — central Coolify creds.
- `cloudflare.{api_token, zone_id, zone_name}` — central Cloudflare creds + the one domain.
- `registry.{github_org, ghcr}` — GHCR/GitHub org for image push.
- `convex.deploy_key` — Convex Cloud deploy key.
- `model` / `thinking` — optional manager session model + reasoning tier (matches the pi-e2e-tester hub).

The **client driver** (in the `deploy-via-manager` skill, not this repo) resolves *this* checkout's
location from the `PI_DEPLOYMENT_MANAGER_DIR` env var or a skill-local config — never a hardcoded
path — and spawns it as `pi --mode rpc`.

Per-**project** deploy state stays in each project's **gitignored `deploy/.env.deploy`** (written by
the manager: `COOLIFY_APP_UUID`, `COOLIFY_WEBHOOK_URL`, `DOMAIN`, `SUBDOMAIN`, …) — consumed only by
the bundled `deploy.sh`; the manager populates the cred fields from central config at deploy time and
never commits them.

A `config.json.example` (placeholder template + inline notes) ships; live `config.json` is
gitignored — same convention as pi-e2e-tester.

---

## 12. Open items to settle during build

- **Per-framework Dockerfiles** — RESOLVED: inline **bun-based** templates in each profile
  (`react-spa`, `nextjs-node`, `nextjs-static`, `static-html`; `astro-static` reuses the astro-setup
  asset). Validated against the user's real `deploy/Dockerfile` files.
- **Convex build-time inject** — written to the project's `.env.production` (read by the bun build).
  A project whose `.dockerignore` excludes `.env*` would miss it — revisit a Docker `--build-arg`
  path if that bites.
- **Go (and other non-JS) servers** — RESOLVED for any project that ships its own Dockerfile: the
  generic **`dockerfile`** profile honors it (reads `EXPOSE`/`VOLUME`/`HEALTHCHECK`), so Bun/Go/Python/
  Rust/… all deploy language-blind. Per-language *generator* profiles (for repos with no Dockerfile)
  remain a future add.
- **Runtime secrets** — RESOLVED: a gitignored `deploy/.env.runtime` (or any `env_file` path named in
  the prompt), read **in-sandbox** by the `env` verb and bulk-set on Coolify. Only the path rides the
  prompt, never the values. Coolify is the live store; the file is an optional declarative seed (omit
  on plain redeploys). `PUBLIC_BASE_URL` is **auto-derived** from subdomain + zone, so the caller can't
  get the final URL wrong.
- **Build host** — image build needs Docker + GHCR auth on whatever box runs the manager. Confirm
  the manager always runs where Docker is available (the user's single dev box for now).
- **SQLite volume backups** — persistent volume gives durability across redeploys, not backups;
  decide a backup story later.
- **Surfacing progress** — the driver already sees the full RPC event stream (assistant turns +
  `notify`s); whether to relay per-phase progress to the caller beyond the final `PIDEPLOY_RESULT`
  notify is a driver-side choice, deferred.
</content>
</invoke>
