---
name: deploy-via-manager
description: Deploys a project by conversing with the gated pi-deployment-manager over pi RPC — sends a natural-language deploy request, answers any questions it asks, and relays the structured result; never deploys manually. Use when asked to "deploy", "ship", "publish", "redeploy", "push this live", "update the deployed site", or otherwise put the project's app/site online.
argument-hint: <project_dir> <subdomain> [initial|redeploy]
allowed-tools: Bash, Read, Glob
user-invocable: true
---

# Deploy via Manager

## Purpose

Hand a deployment to the gated pi-deployment-manager by conversing with it over pi RPC: send a natural-language deploy request, answer any questions it asks, and relay its structured result. Pure dispatch — this skill carries no deployment logic, profiles, or creds.

## Variables

USER_INPUT: $ARGUMENTS
DRIVER: `${CLAUDE_SKILL_DIR}/tools/session.ts` (run with `bun`)
MANAGER_LOCATION: the driver resolves the manager checkout from the `PI_DEPLOYMENT_MANAGER_DIR` env var, else `${CLAUDE_SKILL_DIR}/config.json` (`{"managerDir": "..."}`). No path is assumed — if neither is set the driver errors. Fix by setting the env var or copying `config.json.example` to `config.json`.

## Instructions

### Client-side gate (overrides any instinct to "just deploy it")
- NEVER deploy manually. Do not run docker, push images, or call the Coolify/Cloudflare APIs — the only deploy actions are the tools below. The manager owns all deploy logic, creds, and infra.
- NEVER read, print, or pass secret VALUES. Pass the PATH to a gitignored runtime env file; the manager reads it itself, in-sandbox.
- NEVER set or pass `PUBLIC_BASE_URL` — the manager derives the final URL from the subdomain + zone and injects it.
- NEVER write Dockerfiles, deploy configs, or `.env.deploy` by hand — the manager scaffolds them.
- `intent` is only a hint; the manager decides initial-vs-update live against Coolify. When unsure, say "redeploy after update" — it is always safe.

### Preparing the project (confirm, don't build it yourself)
- A plain backend (Bun/Go/Python/Rust/…) needs a working Dockerfile at the repo root or `deploy/Dockerfile` — the manager uses it verbatim and reads the port from `EXPOSE`, a volume from `VOLUME`, the probe from `HEALTHCHECK`. Frontend apps (React/Astro/Next/static) need none. If a backend ships none, add one (or say so) before deploying.
- Runtime secrets go in a gitignored dotenv file (e.g. `deploy/.env.runtime`, `KEY=VALUE` per line). Name its path in the request; never commit it, never paste secret values into the request or this chat.

### Conversing with the manager
- A tool prints exactly one JSON line: `kind` is `result` (deploy concluded), `reply` (the manager is ASKING you something), `error` (driver/transport problem), or `ok` (lifecycle). Branch on the LAST line's `kind` — see Cookbook.
- On `reply`, the manager needs input (no Dockerfile, subdomain collision, missing env file, unclear intent). Decide from what you know or ask the user, then answer with the `send` tool. Loop until you get a `result`, then run `down`.

## Tools

### deploy
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" deploy "<request>"`
- **Args:** `request (str, required)` — a natural-language deploy request naming the absolute project_dir, the subdomain, the intent, and (if any) the runtime env-file path
- **Does:** Summons the manager (spawning it over pi RPC if not already up), sends the request, prints one JSON line; auto-ends the session on a final `result`.
- **Triggers:** "deploy", "ship", "publish", "redeploy", "push this live", "update the deployed site"

### send
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" send "<message>"`
- **Args:** `message (str, required)` — your answer to the manager's question, or a follow-up / next-deploy request
- **Does:** Sends one more prompt to the LIVE manager session and prints its next JSON line. Use after a `deploy`/`send` that returned `kind:"reply"`.
- **Triggers:** "answer the manager", "continue the deploy"

### down
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" down`
- **Args:** none
- **Does:** Ends the manager session and frees its state. Idempotent — always safe to call at the end.
- **Triggers:** "finished deploying", "close the session"

### clean
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" clean`
- **Args:** none
- **Does:** Kills a stale/leftover manager process and clears session state.
- **Triggers:** "manager stuck", "clean up the manager", "stale session"

## Workflow

1. Resolve from USER_INPUT: the absolute project_dir, the subdomain, the intent (map "first time / initial" → initial deploy, else → redeploy after update), and any runtime env-file path. Check the Preparing-the-project items. If MANAGER_LOCATION is unset, tell the user to set it and stop.
2. Run the `deploy` tool with a request like: `deploy /abs/proj at subdomain myapp, initial deploy; runtime env deploy/.env.runtime`. The call is synchronous and may take minutes — do not poll, time out, or re-run it.
3. Parse the LAST JSON line and branch (see Cookbook): loop the `send` tool for any `reply` until you get `kind:"result"`, then run the `down` tool.
4. Report per the Report section.

## Cookbook

### Manager asks a question
- **IF:** a tool prints `kind:"reply"`
- **THEN:** read its `text`; answer from what you know or ask the user, then run the `send` tool with the answer. Repeat until `kind:"result"`.
- **EXAMPLES:** "no Dockerfile found — is this a backend?", "subdomain taken, pick another", "which runtime env file?"

### Deploy concluded
- **IF:** a tool prints `kind:"result"`
- **THEN:** run the `down` tool (idempotent — a one-shot `deploy` already tore down), then report per Report.
- **EXAMPLES:** "result health:healthy", "result status:failed"

### Manager won't start / stuck
- **IF:** a tool prints `kind:"error"` with reason `spawn_failed` / `ready_timeout` / `manager_down` / `timeout`
- **THEN:** run the `clean` tool, surface the `detail` (point at `<stateDir>/logs/manager.log`), and retry once.
- **EXAMPLES:** "manager did not start", "no result within N min"

## Report

Relay the manager's result faithfully — the `result` object carries `status` (ok|failed), `phase`, `url`, `app_uuid`, `health` (healthy|unhealthy), `logs_tail` (failure only), and `error`. A deploy succeeded ONLY when the line is `kind:"result"` AND `status==ok` AND `health==healthy`. On anything else, report it as failed and surface `phase`, `error`, and `logs_tail`.
