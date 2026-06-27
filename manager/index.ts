// The deployment manager: one gated pi session a project agent SUMMONS over pi RPC
// mode and converses with in natural language. The caller sends a prompt ("deploy
// <dir> at <subdomain>…"); the manager's LLM drives the 10 verbs, asks the caller
// back when it is blocked, and CONCLUDES a deploy by health-checking the shipped app.
//
// Transport is pi's native --mode rpc (stdin/stdout JSONL) — there is NO HTTP server,
// port, or portfile here; the client driver owns the process pipes. The structured
// result is emitted IN CODE (buildResult over the ledger) as a notify event the driver
// captures — never parsed from the LLM's prose. The agent's plain assistant text is
// only ever a human summary or a question for the caller.
//
// THE GATE has two layers: the driver spawns pi with --no-builtin-tools (so bash/read/
// write/edit/glob are unrepresentable), and session_start calls setActiveTools to the
// 10 verbs (belt-and-braces). The verbs' own sandbox (shared/sandbox.ts) bounds what
// their CODE may touch. One purpose, one agent, one deploy at a time.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getModelConfig } from "../shared/config.ts";
import { createLogger } from "../shared/log.ts";
import type { CurrentDeploy, DeployLedger, DeployResult, Role } from "../shared/types.ts";

import { registerManagerTools, VERB_NAMES } from "./tools.ts";

const ROLE: Role = "manager";

// Notify markers the client driver greps for on the RPC event stream. READY lets the
// driver's `up` confirm the session actually booted; RESULT carries the code-derived
// DeployResult JSON. Plain (unmarked) assistant text is a question/summary for the caller.
const READY_MARK = "PIDEPLOY_READY";
const RESULT_MARK = "PIDEPLOY_RESULT";

// The manager's persona, layered onto pi's base prompt every turn. Deliberately flow-
// level only — per-project/per-framework specifics live in the DeployProfiles the verbs
// resolve, never here (a hardcoded-wrong premise would be worse than none).
const MANAGER_RULES = `

## pi-deployment-manager
You are the deployment manager — a single-purpose, gated service a project agent talks to over RPC. The caller converses with you: each message is a natural-language deployment request or a reply to a question you asked. Built-in tools (bash, read, write, edit, glob) are DISABLED — your ONLY tools are these ten verbs, by design:

- detect (read) — START HERE on every new request. Takes project_dir (absolute), subdomain, and optional env_file (a path, relative to project_dir, to a gitignored runtime dotenv of secrets). It binds the deploy, inspects the project, picks its profile (a framework profile, or the generic "dockerfile" profile that honors a project's own Dockerfile) + backend addons, and tells you the flow.
- scaffold (write) — generate deploy/ files (Dockerfile, deploy.sh, .env.deploy) from the profile (the "dockerfile" profile reuses the project's own Dockerfile).
- convex (write) — deploy the Convex Cloud backend and capture its prod URL (only if detect found convex-cloud; runs BEFORE the frontend build).
- provision (write) — create the Coolify app (initial deploy only).
- env (write) — set the app's env vars (auto PUBLIC_BASE_URL + the caller's runtime env_file secrets + captured Convex URL).
- dns (write) — point the caller's subdomain at the app (Cloudflare record + Coolify domain).
- deploy (write) — build the image, push to GHCR, trigger the Coolify deploy (initial ship).
- redeploy (write) — rebuild + re-trigger for an already-set-up project (update path, API-only).
- status (read) — read the Coolify deployment status.
- logs (read) — tail the Coolify app logs (for diagnosing a failure).

Two flows (detect tells you which applies):
- INITIAL deploy: detect -> scaffold -> [convex if present] -> provision -> env -> dns -> deploy. Then confirm health via status.
- UPDATE deploy: detect -> [convex if the backend changed] -> redeploy. Then confirm via status.

Working with the caller:
- Always call detect FIRST, extracting project_dir + subdomain (+ env_file if mentioned) from the caller's message. Never invent a subdomain or deploy a directory the caller did not name.
- If you are BLOCKED or anything is ambiguous — no Dockerfile for a plain backend, a subdomain collision, a missing/empty env_file, unclear intent — STOP and ASK the caller. End that turn with just your question in plain language; the caller will reply and you continue with full context. Do not guess destructively.
- read != write: status / logs / detect never change infra — use them freely to check your work.
- A deploy CONCLUDES only when you run deploy/redeploy and it health-checks the app. The structured result is reported to the caller automatically IN CODE from the verbs you called — do NOT write, format, or invent the result yourself. Your final message each turn is just a short human-readable summary, or a question.
- Never print secrets. The env verb reads the caller's env_file itself, in-sandbox.`;

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Build the client-facing result FROM the ledger the verbs wrote (never from LLM prose).
 * A deploy is "ok" ONLY when the deploy-health guard positively confirmed health — never
 * inferred from merely reaching a phase. A ship that failed sets ledger.error; an unhealthy
 * ship sets health="unhealthy"; both yield "failed".
 */
function buildResult(ledger: DeployLedger): DeployResult {
  const failed = Boolean(ledger.error) || ledger.health !== "healthy";
  return {
    status: failed ? "failed" : "ok",
    phase: ledger.phase,
    url: ledger.url,
    app_uuid: ledger.app_uuid,
    deployment_id: ledger.deployment_id,
    health: ledger.health,
    // Keep success results clean: logs only travel on failure.
    logs_tail: failed ? ledger.logs_tail : undefined,
    error: ledger.error,
  };
}

export default function managerExtension(pi: ExtensionAPI) {
  const log = createLogger(ROLE);
  const modelCfg = getModelConfig();

  // Extension memory, NOT LLM context.
  let activeCtx: ExtensionContext | undefined;
  let cumulativeCost = 0;

  // The live deploy context detect binds; the verbs read it + write its ledger. It
  // PERSISTS across turns (so a caller can answer a question and the agent continues)
  // and is reset only after a deploy concludes, so the next, unrelated deploy in the
  // same session starts clean. `concludedThisTurn` is set by concludeDeploy (the ship
  // verbs) so agent_end knows the deploy is over and can shed context.
  let currentDeploy: CurrentDeploy | null = null;
  let concludedThisTurn = false;

  const refreshUI = (ctx?: ExtensionContext): void => {
    const c = ctx ?? activeCtx;
    if (!c?.hasUI) return;
    const usage = c.getContextUsage();
    const model = c.model?.id ?? "no-model";
    const phase = currentDeploy
      ? `deploying ${currentDeploy.subdomain} (${currentDeploy.ledger.phase})`
      : "idle";
    const ctxStr = usage?.tokens != null ? ` | ctx ${fmtTokens(usage.tokens)}` : "";
    c.ui.setStatus("manager", `● ${phase} | ${model}${ctxStr} | $${cumulativeCost.toFixed(3)}`);
  };

  /**
   * Conclude the in-flight deploy: emit its code-derived DeployResult on the RESULT
   * notify channel for the driver to capture. Called by the ship verbs (deploy/redeploy)
   * once the app has been health-checked (or the ship failed) — the only terminal points.
   * Does NOT clear currentDeploy (the agent may still call status/logs to summarize); the
   * agent_end hook resets it for the next deploy.
   */
  const concludeDeploy = (ctx: ExtensionContext): void => {
    if (!currentDeploy) return;
    const result = buildResult(currentDeploy.ledger);
    concludedThisTurn = true;
    try {
      ctx.ui.notify(`${RESULT_MARK} ${JSON.stringify(result)}`, result.status === "ok" ? "info" : "error");
    } catch (err) {
      log.warn("result notify failed", { err: String(err) });
    }
    log.info("deploy concluded", { status: result.status, phase: result.phase });
    refreshUI(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.hasUI) ctx.ui.setWorkingIndicator(undefined);
    // Belt-and-braces with --no-builtin-tools: pin the active set to exactly the verbs.
    pi.setActiveTools([...VERB_NAMES]);
    refreshUI(ctx);
    // Announce readiness so the driver's `up` can confirm the session actually booted
    // (model loaded, extension live) rather than silently dying like an interactive launch.
    try {
      ctx.ui.notify(`${READY_MARK} manager up`, "info");
    } catch (err) {
      log.warn("ready notify failed", { err: String(err) });
    }
    log.info("manager extension loaded", { model: modelCfg.model });
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + MANAGER_RULES,
  }));

  pi.on("turn_start", async (_event, ctx) => {
    activeCtx = ctx;
  });
  pi.on("message_end", async (event, ctx) => {
    activeCtx = ctx;
    if (event.message.role === "assistant") {
      const usage = (event.message as { usage?: { cost?: { total?: number } } }).usage;
      if (usage?.cost?.total != null) cumulativeCost += usage.cost.total;
    }
    refreshUI(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    activeCtx = ctx;
    refreshUI(ctx);
  });

  // A deploy turn ended. If it CONCLUDED (a ship was health-checked, result already
  // emitted by concludeDeploy), shed this deploy: drop the context so the next, UNRELATED
  // deploy in the same session starts clean, and clear the bound context. If it did NOT
  // conclude, the agent's last message is a question — leave everything in place so the
  // caller's reply continues this same deploy.
  pi.on("agent_end", async (_event, ctx) => {
    activeCtx = ctx;
    if (!concludedThisTurn) return;
    concludedThisTurn = false;
    currentDeploy = null;
    try {
      const usage = ctx.getContextUsage();
      if (usage?.tokens != null && usage.tokens > 2000) {
        ctx.compact({
          customInstructions:
            "A brand-new, UNRELATED deploy may start next. Discard everything about the " +
            "previous deploy — its project, subdomain, profile, and result are over and must " +
            "NOT influence the next one. Summarize to a single line: 'ready for next deploy'.",
          onError: (e) => log.warn("compaction failed", { err: e.message }),
        });
      }
    } catch (err) {
      log.warn("compact failed", { err: String(err) });
    }
    refreshUI(ctx);
  });

  registerManagerTools(pi, {
    roleLog: log,
    getCurrentDeploy: () => currentDeploy,
    setCurrentDeploy: (d) => {
      currentDeploy = d;
    },
    concludeDeploy,
    setActiveCtx: (ctx) => {
      activeCtx = ctx;
    },
  });
}
