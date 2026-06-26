---
name: deploy-via-manager
description: Dispatches a deployment to the gated pi-deployment-manager service by running its pi-deploy.sh handoff script — never deploys manually. Use when the project agent is asked to "deploy", "ship", "publish", "redeploy", "push this live", "update the deployed site", or otherwise put the project's app/site online. Thin client only — the manager owns all deploy logic, creds, and infra; the caller passes a project dir, subdomain, and intent, then relays the JSON result.
argument-hint: <subdomain> [initial|redeploy]
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

## Tools

### deploy
- **Run:** `bash "$MANAGER_DIR/pi-deploy.sh" "<project_dir>" "<subdomain>" "<intent>"`
- **Args:**
  - `project_dir (absolute path, required)` — the project being deployed
  - `subdomain (str, required)` — the app is served at `https://<subdomain>.<zone>`
  - `intent (str, required)` — `initial deploy` (first ship) or `redeploy after update` (subsequent ships)
- **Does:** POSTs the deploy to the manager (spawning it on demand if not running) and blocks until it finishes, printing the JSON DeployResult.
- **Triggers:** "deploy", "ship", "publish", "redeploy", "push this live", "update the deployed site"

## Workflow

1. Resolve MANAGER_DIR. If the absolute path is unknown, locate the `pi-deployment-manager` checkout next to the other pi-* projects and confirm it contains `pi-deploy.sh`.
2. Gather the three args: `project_dir` (absolute path of the project to deploy), `subdomain`, and `intent`. Map "first time / initial" to `initial deploy`, anything else to `redeploy after update`.
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
