/**
 * shared/types.ts — the manager's result + state contracts.
 *
 * The manager is summoned over pi RPC mode and conversed with in natural language, so
 * there is no bespoke wire union: the caller's request is a prompt, and the verbs take
 * their target as params (detect binds project_dir/subdomain/env_file). What remains:
 *   - DeployResult: the single structured result a deploy concludes with (built in code).
 *   - DeployLedger + CurrentDeploy: the in-process contract the verbs share.
 *
 * Uses no pi runtime — importable from config/sandbox/log via jiti.
 */

/** The manager has a single session role (no spokes — a deploy runs to completion). */
export type Role = "manager";

/**
 * The single structured result a deploy concludes with. BUILT FROM the ledger in code
 * — never parsed from the LLM's prose. Emitted to the client driver on the RESULT notify
 * channel; the driver returns it verbatim to the calling project agent.
 */
export interface DeployResult {
  status: "ok" | "failed";
  /** Last phase reached (so a failure says where it stopped). */
  phase: string;
  url?: string;
  app_uuid?: string;
  deployment_id?: string;
  health?: "healthy" | "unhealthy";
  /** Tail of app logs — included only on failure, to keep success results clean. */
  logs_tail?: string;
  error?: string;
}

// ── In-process contract (verbs ↔ extension) ──────────────────────────────────

/**
 * The structured accumulator the verbs WRITE and concludeDeploy READS to build the
 * DeployResult. The verbs mutate this (never return prose to parse); `error` set by a
 * ship verb forces status="failed", as does health "unhealthy".
 */
export interface DeployLedger {
  /** Advanced by each verb (e.g. "detected", "provisioned", "deployed"). */
  phase: string;
  /** Frontend profile id chosen by detect. */
  profile?: string;
  /** Backend addon ids chosen by detect (e.g. ["convex-cloud"]). */
  addons?: string[];
  app_uuid?: string;
  deployment_id?: string;
  url?: string;
  health?: "healthy" | "unhealthy";
  logs_tail?: string;
  /** First fatal (terminal) error; presence forces a "failed" result. */
  error?: string;
}

/**
 * The live deploy context detect binds and the verbs read. One at a time (a deploy is
 * serialized). It PERSISTS across turns so the caller can answer a question and the agent
 * continues; it is reset only after the deploy concludes.
 */
export interface CurrentDeploy {
  /** Validated absolute project dir (the sandbox root). */
  project_dir: string;
  subdomain: string;
  /** Sandbox-relative path to a gitignored runtime dotenv file (read by the env verb). */
  env_file?: string;
  ledger: DeployLedger;
  /**
   * Transient inter-verb scratchpad (e.g. the captured Convex URL + the build-env var name
   * it goes under, the resolved flow, the port/volume/health detect read from a Dockerfile).
   * NOT surfaced to the client — only the ledger is. detect inits it to {}.
   */
  scratch: Record<string, string>;
}
