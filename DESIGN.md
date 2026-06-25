# pi-deployment-manager — Locked Design

> Standalone agentic **deployment service**, built on pi. Any of the user's projects
> hands off a deploy task via RPC; the manager owns all deployment knowledge, creds,
> and infra state and does the work, returning a structured result. Sibling to
> `pi-4b-tester/` and `pi-e2e-tester/`; reuses their hub transport.
>
> Status: **design locked, pre-implementation** (2026-06-25 design discussion).

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
  │  POST /deploy {project_dir,                 │  detect → scaffold → [convex] →
  │   subdomain, intent}  ── token, requestId ─▶│  provision → env → dns → ship →
  │                                             │  health-check
  │  ◀───────── structured result ─────────────│  (Coolify + Cloudflare = source of truth)
```

### 2.1 Lifecycle — spawn-on-demand, NOT a daemon

Deploys are infrequent (initial once; redeploy on update). Running a permanent localhost daemon is
infra to babysit on the user's single box. Instead the client **spawns** the manager per session
(reusing the testers' `launch-spoke.sh` pattern), POSTs the task, gets the result. Because the
source of truth is the Coolify/Cloudflare APIs, spawn-on-demand is correct — there is no warm state
to lose. *(Decision; revisit only if a use case needs an always-on endpoint.)*

### 2.2 Transport — reuse the shared localhost-HTTP RPC

Reuse pi-4b/pi-e2e transport verbatim: **localhost HTTP POST, bearer-token auth, `requestId`
correlation**. Endpoint: `POST /deploy`. Rationale over `pi -p` headless one-shot: consistency with
the existing stack (shared transport code), correlated structured results, and room to stream
multi-step progress back to the caller. *(This is the one transport sub-choice; `pi -p` is the
simpler fallback if HTTP proves overkill.)*

---

## 3. Doors

Mirrors the testers' two-door split. **Primary, build first:**

- **`deploy({project_dir, subdomain, intent})`** — the messenger/NL door. The manager's own LLM
  interprets `intent` ("initial deploy", "redeploy after update", "set env X and redeploy") and
  drives the verbs. This is exactly the user's framing: *"ask the llm to do initial or after-update
  deployment."*

**Deferred** (like the testers deferred `run_test`):

- **Deterministic structured door** — a typed deploy spec (no LLM interpretation) for CI/scripted
  use. Add once the NL door is field-proven.

### 3.1 Payload (caller → manager)

| Field         | Required | Notes                                                                 |
|---------------|----------|-----------------------------------------------------------------------|
| `project_dir` | yes      | **Absolute** path to the caller's repo. Manager operates in place — no clone. |
| `subdomain`   | yes      | Caller-specified hostname label (locked decision). Manager validates against collisions. |
| `intent`      | yes      | NL instruction.                                                       |
| `env`         | no       | Extra env KEY=VALUE pairs to set on the app.                          |

### 3.2 Result (manager → caller) — clean, parseable

A deploy must end with a single structured result (the testers' `VERDICT:` parse is the #1 runtime
risk; same care here):

```json
{ "status": "ok|failed", "phase": "...", "url": "https://<subdomain>.<domain>",
  "app_uuid": "...", "deployment_id": "...", "health": "healthy|unhealthy",
  "logs_tail": "...(only on failure)" }
```

---

## 4. Project access — both modes, operate in place

The manager works **directly in the caller's `project_dir`** (the caller already has the repo
checked out; just pass the path). No clone.

- **Initial deploy** needs repo write: scaffold `deploy/Dockerfile`, commit/push, create the GitHub
  repo if absent, provision Coolify, allocate DNS, first ship.
- **Update deploy** is **API-only**: the deploy is image-based — `deploy/deploy.sh` builds the image,
  pushes to **GHCR**, and triggers the Coolify webhook. Redeploy just re-runs that path.

**Idempotency signal (reused from coolify-setup):** `COOLIFY_WEBHOOK_URL` present in
`deploy/.env.deploy` ⇒ project already set up ⇒ redeploy path. Absent ⇒ initial path.

---

## 5. Execution layer — gated custom-tool surface, skills are the wrapped engine

**The manager is a heavily-gated, single-purpose agent.** Its LLM has **no raw Bash / Edit / Read /
Glob** and cannot roam the filesystem. It sees **only** the semantic verbs of §7 — custom tools
implemented in code (the pi-e2e-tester spoke philosophy: a closed, semantic surface, not raw device
access). One purpose, one agent, one deploy at a time.

**Skills are not invoked by the LLM** — a skill is a *prompt that tells an LLM to run bash*, which is
exactly the capability being removed. Instead the skill scripts become the **engine the tool code
calls internally**:

```
manager LLM ──can only call──▶ [ detect | scaffold | provision | dns | deploy | … ]   ← the gate
                                      │  (tool implementation, in code)
                                      └── runs coolify/tools/*.sh, cloudflare/tools/*.sh,
                                          deploy/deploy.sh, npx convex deploy, gh …
```

So the four skills (`astro-setup`, `coolify-setup`, `coolify`, `cloudflare`) are still the reused
implementation — `coolify-setup` (first-time: scaffold `deploy/`, create app w/ port auto-inferred
from Dockerfile `EXPOSE`, limits, optional DNS, first deploy; image-based build→GHCR→webhook),
`coolify` (ongoing redeploy/logs/env/status), `cloudflare` (DNS/zones), per-framework Dockerfile
templates — but they're driven by the **tool's code**, never by the model. The model has no path to
the underlying bash.

### 5.0 Sandbox (the gate) — enforced in tool code, not trusted to the LLM

| capability | scope |
|------------|-------|
| **read**   | the target `project_dir`, **read-only** — `detect` must inspect `package.json` / `next.config` / `astro.config` / `convex/` / `index.html` to pick the profile. |
| **write**  | a fixed **allowlist**: `<project_dir>/deploy/*`, plus the two project-root writes coolify-setup makes (`.gitignore` entries, `.env.production`), and `git add/commit` of those. **Nothing else.** |
| **network**| Coolify · Cloudflare · GHCR · Convex Cloud · GitHub (`gh`) APIs only. |
| **denied** | general Bash, Edit, Read, Glob, Write outside the allowlist. |

This allowlist **is** the "only touch `deploy/`, never other files" guarantee — a path check in the
tool implementation, not a rule the LLM is asked to honor.

### 5.1 Centralized creds (a key win of offloading)

Today each project's `deploy/.env.deploy` must hold the Coolify + Cloudflare tokens. With the
manager, **creds live in ONE place — the manager's config** — never copied per project. At deploy
time the manager **populates the project's gitignored `deploy/.env.deploy` from its central config**
(or injects via env), then invokes the skills. Projects stop carrying secrets. *(Locked.)*

---

## 6. DeployProfile registry — the DeviceProfile analog

The framework/backend spread maps to a small pluggable registry (mirrors pi-e2e-tester's
`spoke/profiles/` `DeviceProfile`). A project = **one frontend profile + optional backend addon(s)**,
**auto-detected** from `project_dir`. Adding a target = drop one profile file.

`DeployProfile`: `{ id, detect(dir), dockerfile(dir), port, resourceHint, needsVolume, buildHints }`.

### Frontend profiles

| id              | detect                                   | output / runtime           | Dockerfile           |
|-----------------|------------------------------------------|----------------------------|----------------------|
| `static-html`   | bare `index.html`, no build              | static                     | nginx                |
| `react-spa`     | vite/CRA, client-only                    | static SPA                 | build → nginx        |
| `astro-static`  | `astro.config`, no SSR adapter           | static                     | bun → nginx (exists) |
| `nextjs-node`   | `next` dep, server/App-Router features   | **node standalone** (default) | node runtime      |
| `nextjs-static` | `next.config` `output: 'export'`         | static                     | build → nginx        |

Next.js mode is auto-detected from `next.config` (`output: 'export'` → static, else node-standalone).

### Backend addons (compose with any frontend)

| id              | trigger                          | behavior                                                                          |
|-----------------|----------------------------------|----------------------------------------------------------------------------------|
| `convex-cloud`  | `convex/` dir + `convex` dep     | **Backend-first**: `npx convex deploy` (Convex Cloud, `CONVEX_DEPLOY_KEY`) → capture prod URL → inject as **build-time** env into the frontend before its image build. |
| `sqlite-volume` | node/bun server with a `.db`/sqlite dep | Mount a **persistent Coolify volume** for the db file (survives redeploys). Note backup as a follow-up. |

**Convex = Convex Cloud** (locked) — managed, not self-hosted. The manager never deploys Convex onto
the Coolify box; it only runs `convex deploy` and wires the resulting URL into the frontend env.

---

## 7. Verb surface — the manager's ONLY tools (semantic, not skill-passthrough)

These ten verbs are the **complete** tool surface exposed to the manager LLM. There is no raw
Bash/Edit/Read alongside them (§5.0).

| verb       | r/w  | does                                                                              |
|------------|------|----------------------------------------------------------------------------------|
| `detect`   | read | inspect `project_dir` → select frontend profile + backend addons                 |
| `scaffold` | write| generate `deploy/Dockerfile` (+ nginx conf, `/healthz`, `HEALTHCHECK`) from profile |
| `convex`   | write| `convex deploy` → capture prod URL (runs before frontend build)                  |
| `provision`| write| create Coolify app, image=`ghcr.io/<org>/<repo>`, set resource limits (initial)  |
| `env`      | write| set app env vars (incl. injected Convex URL)                                     |
| `dns`      | write| create/update the Cloudflare record for the **caller-specified** subdomain; set Coolify domain |
| `deploy`   | write| build → push GHCR → trigger Coolify (runs `deploy/deploy.sh`)                     |
| `redeploy` | write| API-only redeploy trigger (update path)                                          |
| `status`   | read | Coolify deployment status                                                         |
| `logs`     | read | tail Coolify app logs                                                             |

`read ≠ write` (the testers' durable lesson): `status`/`logs`/`detect` are read-only and never
mutate infra.

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
   `/healthz` endpoint; auto-**fail** the result if unhealthy (the skills already add `HEALTHCHECK`
   + `/healthz`). This is the deployment analog of the crash-guard — catches a deploy that "succeeds"
   but serves a broken app.

---

## 9. Flows

**Initial deploy** — `intent:"initial deploy"`, no `COOLIFY_WEBHOOK_URL`:
`detect → scaffold Dockerfile → [convex deploy → capture URL] → populate deploy/.env.deploy from
central creds → provision Coolify app + limits → env (+ inject Convex URL) → [subdomain-collision
guard] → dns + set Coolify domain → create GitHub repo if absent → deploy (build→GHCR→webhook) →
[health guard] → return {url,…}`.

**Update deploy** — `intent:"redeploy after update"`, `COOLIFY_WEBHOOK_URL` present:
`detect (already set up) → [convex deploy if backend changed → re-inject URL] → redeploy (deploy.sh)
→ [health guard] → return`.

---

## 10. Context-reset model

The manager session is long-lived across a client session but **each deploy is an independent
task** → per-deploy context isolation. Mirror the testers: **`compact()`** between deploys with
strong "brand-new unrelated deploy, discard prior" instructions (the any-context reset primitive;
`newSession` is gated to command contexts). A deploy is never reset mid-flow (would orphan an
in-flight ship).

---

## 11. Config (`config.json`, single source of truth)

Manager-owned config; no hardcoded paths/creds:

- `rpc.{port, token}` — localhost RPC door (port auto-fallback to next-free like the testers).
- `coolify.{base_url, api_token, server_uuid, dest_uuid}` — central Coolify creds.
- `cloudflare.{api_token, zone_id, zone_name}` — central Cloudflare creds + the one domain.
- `registry.{github_org, ghcr}` — GHCR/GitHub org for image push.
- `convex.deploy_key` — Convex Cloud deploy key.

Per-**project** deploy state stays in each project's **gitignored `deploy/.env.deploy`** (owned by
`coolify-setup`: `COOLIFY_APP_UUID`, `COOLIFY_WEBHOOK_URL`, `DOMAIN`, `SUBDOMAIN`, …) — the manager
populates the cred fields from central config at deploy time, never commits them.

A `config.json.example` (placeholder template + inline notes) ships; live `config.json` is
gitignored — same convention as pi-e2e-tester.

---

## 12. Open items to settle during build

- **Per-framework setup skills beyond Astro** — `nextjs-node`, `react-spa`, `static-html`,
  `nextjs-static` each need a Dockerfile template. Either new sibling skills (like `astro-setup`) or
  inline templates in the profile registry. Lean: inline in profiles, promote to skills if reused.
- **Build host** — image build needs Docker + GHCR auth on whatever box runs the manager. Confirm
  the manager always runs where Docker is available (the user's single dev box for now).
- **SQLite volume backups** — persistent volume gives durability across redeploys, not backups;
  decide a backup story later.
- **Streaming progress** — whether the RPC streams phase updates to the caller or only returns the
  final result.
</content>
</invoke>
