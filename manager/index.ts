// The deployment manager: one gated pi session that receives a deploy task over
// RPC, drives the 10 verbs to completion, and returns a structured result. The
// Node code (HTTP server) always runs; the LLM runs only during a deploy turn.
//
// THE GATE has two layers: launch-manager.sh passes --no-builtin-tools (so bash/
// read/write/edit are unrepresentable), and session_start calls setActiveTools to
// the 10 verbs (belt-and-braces). The verbs' own sandbox (shared/sandbox.ts) bounds
// what their CODE may touch. One purpose, one agent, one deploy at a time.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getModelConfig, getPort, getStateDir, getToken } from "../shared/config.ts";
import { createLogger } from "../shared/log.ts";
import { validateProjectDir } from "../shared/sandbox.ts";
import { createTransportServer, type TransportServer } from "../shared/transport.ts";
import type {
  CurrentDeploy,
  DeployLedger,
  DeployResult,
  DeployResultMessage,
  Role,
} from "../shared/types.ts";

import { registerManagerTools, VERB_NAMES } from "./tools.ts";

const ROLE: Role = "manager";

// A deploy is allowed a long wall-clock (image build + push + Coolify + health poll),
// but not forever — a wedged run must return a failure to the client, not hang it.
const DEPLOY_TIMEOUT_MS = 20 * 60_000;

// The manager's persona. Layered onto pi's base prompt every turn. Deliberately
// flow-level only — per-project/per-framework specifics live in the DeployProfiles
// the verbs resolve, never here (a hardcoded-wrong premise would be worse than none).
const MANAGER_RULES = `

## pi-deployment-manager
You are the deployment manager — a single-purpose, gated service. You receive ONE deploy task per turn: a project at a given project_dir, to be deployed at a given subdomain on the shared Coolify VPS + Cloudflare domain. Built-in tools (bash, read, write, edit, glob) are DISABLED — your ONLY tools are these ten verbs, and that is by design:

- detect (read) — inspect the project, pick its profile (a framework profile, or the generic "dockerfile" profile that honors a project's own Dockerfile) + backend addons. START HERE, always.
- scaffold (write) — generate the project's deploy/ files (Dockerfile, deploy.sh, .env.deploy) from the profile (the "dockerfile" profile reuses the project's own Dockerfile).
- convex (write) — deploy the Convex Cloud backend and capture its prod URL (only if detect found convex-cloud; runs BEFORE the frontend build).
- provision (write) — create the Coolify app (initial deploy only).
- env (write) — set the app's env vars (auto PUBLIC_BASE_URL + the caller's runtime env_file secrets + captured Convex URL).
- dns (write) — point the caller's subdomain at the app (Cloudflare record + Coolify domain).
- deploy (write) — build the image, push to GHCR, trigger the Coolify deploy (initial ship).
- redeploy (write) — rebuild + re-trigger for an already-set-up project (update path, API-only).
- status (read) — read the Coolify deployment status.
- logs (read) — tail the Coolify app logs (for diagnosing a failure).

Two flows:
- INITIAL deploy (project not yet set up): detect -> scaffold -> [convex if present] -> provision -> env -> dns -> deploy. Then confirm health via status.
- UPDATE deploy (project already set up): detect -> [convex if the backend changed] -> redeploy. Then confirm via status.
Call detect first; it tells you which flow applies and which addons to run.

read != write: status / logs / detect never change infra — use them freely to check your work. The structured result returned to the caller is built IN CODE from the verbs you call, NOT from your prose: your final message is just a short human-readable summary. End each turn with a one-line summary of what you deployed (or why it failed).`;

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Build the client-facing result FROM the ledger the verbs wrote (never from LLM prose).
 * A deploy is "ok" ONLY when the deploy-health guard positively confirmed health — never
 * inferred from merely reaching a phase. So a flow that stops early (no ship, LLM gave up)
 * is correctly "failed", as is any set error.
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

/** The instruction handed to the manager LLM to start a deploy turn. */
function deployPrompt(d: CurrentDeploy): string {
  const envKeys = d.env && Object.keys(d.env).length ? Object.keys(d.env).join(", ") : "(none)";
  return [
    "New deploy task.",
    `project_dir: ${d.project_dir}`,
    `subdomain: ${d.subdomain}`,
    `extra env keys supplied by caller: ${envKeys}`,
    `runtime env_file: ${d.env_file ?? "(none)"}`,
    "",
    `Caller intent: ${d.intent}`,
    "",
    "Begin by calling detect.",
  ].join("\n");
}

export default function managerExtension(pi: ExtensionAPI) {
  const log = createLogger(ROLE);
  const modelCfg = getModelConfig();

  // Extension memory, NOT LLM context.
  let server: TransportServer | undefined;
  let endpointFile: string | undefined;
  let activeCtx: ExtensionContext | undefined;
  let cumulativeCost = 0;

  // Serialized to ONE in-flight deploy. The door awaits `pending.resolve`, which
  // agent_end calls once the deploy turn ends. `armed` flips on the deploy's OWN
  // agent_start so a stray run's agent_end can't resolve it early (mirrors the
  // testers' intent-arming).
  let currentDeploy: CurrentDeploy | null = null;
  let pending:
    | { requestId: string; armed: boolean; resolve: (r: DeployResult) => void }
    | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const refreshUI = (ctx?: ExtensionContext): void => {
    const c = ctx ?? activeCtx;
    if (!c?.hasUI) return;
    const usage = c.getContextUsage();
    const model = c.model?.id ?? "no-model";
    const phase = currentDeploy ? `deploying ${currentDeploy.subdomain} (${currentDeploy.ledger.phase})` : "idle";
    const ctxStr = usage?.tokens != null ? ` | ctx ${fmtTokens(usage.tokens)}` : "";
    c.ui.setStatus("manager", `● ${phase} | ${model}${ctxStr} | $${cumulativeCost.toFixed(3)}`);
  };

  // Resolve the in-flight deploy exactly once. The requestId guard ensures a late
  // timer or a stray agent_end can't resolve the wrong (or an already-finished) deploy.
  const finishDeploy = (requestId: string, result: DeployResult): void => {
    if (!pending || pending.requestId !== requestId) return;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    const resolve = pending.resolve;
    pending = null;
    currentDeploy = null;
    log.info("deploy finished", { requestId, status: result.status, phase: result.phase });
    resolve(result);
    refreshUI();
  };

  // The synchronous RPC door: POST /deploy blocks here until the deploy completes,
  // then the returned DeployResultMessage becomes the 200 body. The caller needs no
  // server of its own.
  const handleDeploy = (msg: {
    requestId: string;
    project_dir: string;
    subdomain: string;
    intent: string;
    env?: Record<string, string>;
    env_file?: string;
  }): Promise<DeployResultMessage> => {
    const wrap = (result: DeployResult): DeployResultMessage => ({
      type: "deploy_result",
      from: "manager",
      ts: Date.now(),
      requestId: msg.requestId,
      result,
    });

    // SERIALIZE: one deploy at a time.
    if (currentDeploy || pending) {
      log.warn("deploy rejected: another deploy in flight", { requestId: msg.requestId });
      return Promise.resolve(
        wrap({ status: "failed", phase: "reject", error: "manager busy with another deploy" }),
      );
    }

    // Validate the sandbox root BEFORE waking the LLM (fail closed).
    let projectDir: string;
    try {
      projectDir = validateProjectDir(msg.project_dir);
    } catch (err) {
      return Promise.resolve(
        wrap({ status: "failed", phase: "validate", error: (err as Error).message }),
      );
    }

    currentDeploy = {
      project_dir: projectDir,
      subdomain: msg.subdomain,
      intent: msg.intent,
      env: msg.env,
      env_file: msg.env_file,
      ledger: { phase: "received" },
      scratch: {},
    };
    log.info("deploy received", {
      requestId: msg.requestId,
      project_dir: projectDir,
      subdomain: msg.subdomain,
    });

    return new Promise<DeployResult>((resolve) => {
      pending = { requestId: msg.requestId, armed: false, resolve };
      pendingTimer = setTimeout(() => {
        log.warn("deploy timed out", { requestId: msg.requestId });
        finishDeploy(msg.requestId, {
          status: "failed",
          phase: currentDeploy?.ledger.phase ?? "unknown",
          error: `deploy exceeded ${DEPLOY_TIMEOUT_MS}ms`,
        });
      }, DEPLOY_TIMEOUT_MS);

      const prompt = deployPrompt(currentDeploy!);
      try {
        if (activeCtx?.isIdle()) pi.sendUserMessage(prompt);
        else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      } catch (err) {
        log.error("deploy dispatch failed", { requestId: msg.requestId, err: String(err) });
        finishDeploy(msg.requestId, {
          status: "failed",
          phase: "dispatch",
          error: `dispatch failed: ${(err as Error).message}`,
        });
      }
    }).then(wrap);
  };

  const startServer = async (): Promise<void> => {
    if (server) return;
    server = await createTransportServer({
      port: getPort(),
      handlers: {
        deploy: (msg) => handleDeploy(msg),
        onUnhandled: (m) => {
          log.debug("unhandled transport message", { type: (m as { type?: string }).type });
          return { ok: true };
        },
        onError: (err, raw) =>
          log.warn("transport server error", { err: err.message, raw: raw.slice(0, 200) }),
      },
    });
    // A deploy blocks the HTTP response for minutes; Node's default request/header
    // timeouts (~5min/1min) would kill the connection mid-deploy. Disable them — the
    // DEPLOY_TIMEOUT_MS guard above is what bounds a wedged deploy instead.
    server.server.requestTimeout = 0;
    server.server.headersTimeout = 0;
    server.server.timeout = 0;

    // Transport binds the configured port OR an auto-fallback, chosen here at runtime —
    // so the client can't know it in advance. Publish the resolved {port, token} to a
    // portfile; the client (pi-deploy.sh / client.ts) reads it to reach a spawned manager.
    try {
      const dir = getStateDir();
      mkdirSync(dir, { recursive: true });
      endpointFile = join(dir, "endpoint.json");
      writeFileSync(
        endpointFile,
        JSON.stringify({ port: server.port, token: getToken(), pid: process.pid }, null, 2),
        "utf8",
      );
    } catch (err) {
      log.warn("could not write endpoint file", { err: String(err) });
    }
    log.info("manager transport listening", { port: server.port });
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.hasUI) ctx.ui.setWorkingIndicator(undefined);
    // Belt-and-braces with --no-builtin-tools: pin the active set to exactly the verbs.
    pi.setActiveTools([...VERB_NAMES]);
    await startServer();
    refreshUI(ctx);
    log.info("manager extension loaded", { port: server?.port, model: modelCfg.model });
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + MANAGER_RULES,
  }));

  pi.on("turn_start", async (_event, ctx) => {
    activeCtx = ctx;
  });
  // Arm the pending deploy when ITS run starts (agent_start fires once per run).
  pi.on("agent_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (pending && !pending.armed) pending.armed = true;
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

  // The deploy turn ended → build the result from the ledger and resolve the door.
  // Only the deploy's OWN (armed) run may resolve it. Then shed context so the next,
  // UNRELATED deploy starts clean — but never mid-deploy (would orphan an in-flight ship).
  pi.on("agent_end", async (_event, ctx) => {
    activeCtx = ctx;
    if (!pending || !pending.armed) return;
    const requestId = pending.requestId;
    const ledger = currentDeploy?.ledger ?? { phase: "unknown" };
    finishDeploy(requestId, buildResult(ledger));

    try {
      const usage = ctx.getContextUsage();
      if (usage?.tokens != null && usage.tokens > 2000) {
        ctx.compact({
          customInstructions:
            "A brand-new, UNRELATED deploy is starting. Discard everything about the " +
            "previous deploy — its project, subdomain, profile, and result are over and " +
            "must NOT influence the next one. Summarize to a single line: 'ready for next deploy'.",
          onError: (e) => log.warn("compaction failed", { err: e.message }),
        });
      }
    } catch (err) {
      log.warn("compact failed", { err: String(err) });
    }
    refreshUI(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = undefined;
    if (endpointFile) {
      try {
        rmSync(endpointFile);
      } catch {
        /* already gone */
      }
      endpointFile = undefined;
    }
    await server?.close();
    server = undefined;
  });

  registerManagerTools(pi, {
    roleLog: log,
    getCurrentDeploy: () => currentDeploy,
    setActiveCtx: (ctx) => {
      activeCtx = ctx;
    },
  });
}
