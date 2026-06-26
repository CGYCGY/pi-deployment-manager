---
name: deploy-via-manager
description: Dispatches a deployment to the gated pi-deployment-manager service by running its pi-deploy.sh handoff script — never deploys manually. Use when the project agent is asked to "deploy", "ship", "publish", "redeploy", "push this live", "update the deployed site", or otherwise put the project's app/site online. Thin client only — the manager owns all deploy logic, creds, and infra; the caller passes a project dir, subdomain, and intent, then relays the JSON result.
argument-hint: <subdomain> [initial|redeploy] [--env-file <path>]
allowed-tools: Bash, Read, Glob
user-invocable: true
---

# Deploy via Manager

## Purpose

Hand a deployment off to the gated pi-deployment-manager service over local RPC. Pure dispatch: this skill never deploys anything itself and carries no deployment knowledge.

## Variables

USER_INPUT: $ARGUMENTS
MANAGER_DIR: absolute path to the pi-deployment-manager checkout — resolve at runtime if unknown (it sits beside the other pi-* projects; look for a `pi-deployment-manager/` dir containing `pi-deploy.sh`)

## Instructions

These are the client-side counterpart of the manager's gate. They override any instinct to "just deploy it."

- NEVER deploy manually. Do not run docker, `git push` to GHCR, or call the Coolify/Cloudflare APIs yourself — the only deploy action is the `deploy` tool below.
- NEVER read, print, or pass deployment secrets or credentials. The manager owns all creds; the caller passes none.
- NEVER write Dockerfiles, deploy configs, or `.env.deploy` by hand — the manager scaffolds those.
- Do not document or reason about deployment profiles, guards, env injection, or Coolify/Cloudflare specifics. That knowledge lives in the manager; reproducing it here recreates the coupling the architecture removes.
- `intent` is only a hint; the manager decides idempotency live. When unsure whether it is a first deploy, use `redeploy after update` — it is always safe.
- NEVER set or pass `PUBLIC_BASE_URL` — the manager derives the final URL from the subdomain + zone and injects it. Setting it yourself just risks getting it wrong.

## Preparing the project

The manager is language-agnostic but needs two things from the project. Confirm them, don't build deploy infra yourself:

- **A working Dockerfile** at the repo root (or `deploy/Dockerfile`) — any stack (Bun, Go, Python, …). The manager uses it verbatim and reads the port from `EXPOSE`, a persistent volume from `VOLUME`, and the health probe from `HEALTHCHECK`. Frontend apps (React/Astro/Next/static) need no Dockerfile — the manager generates one. If a plain backend ships none, add one (or say so) before deploying.
- **Runtime secrets in a gitignored dotenv file** (e.g. `deploy/.env.runtime`, `KEY=VALUE` per line). Pass its path with `--env-file`. The manager reads it itself and sets the vars on the host — so secrets stay out of argv, the wire, and git. Never commit it; never paste secrets into the intent or this chat.

## Tools

### deploy
- **Run:** `bash "$MANAGER_DIR/pi-deploy.sh" "<project_dir>" "<subdomain>" "<intent>" [--env-file <path>]`
- **Args:**
  - `project_dir (absolute path, required)` — the project being deployed
  - `subdomain (str, required)` — the app is served at `https://<subdomain>.<zone>`
  - `intent (str, required)` — `initial deploy` (first ship) or `redeploy after update` (subsequent ships)
  - `--env-file <path> (optional)` — path RELATIVE TO `project_dir` of the gitignored runtime dotenv file. Omit on redeploys that don't change env (the host already holds them).
- **Does:** POSTs the deploy to the manager (spawning it on demand if not running) and blocks until it finishes, printing the JSON DeployResult.
- **Triggers:** "deploy", "ship", "publish", "redeploy", "push this live", "update the deployed site"

## Workflow

1. Resolve MANAGER_DIR. If the absolute path is unknown, locate the `pi-deployment-manager` checkout next to the other pi-* projects and confirm it contains `pi-deploy.sh`.
2. Gather the args: `project_dir` (absolute path), `subdomain`, and `intent` (map "first time / initial" to `initial deploy`, anything else to `redeploy after update`). Check the Preparing-the-project items: confirm a Dockerfile exists for a plain backend, and if the app needs runtime secrets, point `--env-file` at the gitignored dotenv file.
3. Run the `deploy` tool and wait. The call is synchronous and may take minutes — do not poll, time out, or re-run it.
4. Report per the Report section.

## Report

Relay the manager's JSON result to the user verbatim-ish — do not drop or paraphrase away fields. The result carries:

- `status` — `ok` | `failed`
- `phase` — last deploy phase reached
- `url` — `https://<subdomain>.<zone>`
- `app_uuid`
- `health` — `healthy` | `unhealthy`
- `logs_tail` — present only on failure

A deploy succeeded **only** when `status == ok` AND `health == healthy`. On anything else, report it as failed and surface `phase` and `logs_tail`.
