/**
 * shared/types.ts — the manager's wire + state contracts.
 *
 * Two halves:
 *   1. The RPC contract a project agent (client) sees: DeployRequest in,
 *      DeployResult out, carried by the DeployMessage / DeployResultMessage union.
 *   2. The in-process contract the verbs + door share: DeployLedger (the
 *      structured accumulator) and CurrentDeploy (the live deploy context).
 *
 * Uses no pi runtime — importable from transport/config/sandbox via jiti.
 */

/** The manager has a single session role (no spokes — a deploy runs to completion). */
export type Role = "manager";

// ── RPC contract (client ↔ manager) ────────────────────────────────────────

/** What a project agent hands off. project_dir is ABSOLUTE — the manager operates in place. */
export interface DeployRequest {
  /** Absolute path to the caller's already-checked-out repo. */
  project_dir: string;
  /** Caller-specified subdomain label (validated against collisions, not invented). */
  subdomain: string;
  /** Natural-language instruction ("initial deploy", "redeploy after update", …). */
  intent: string;
  /** Optional extra env KEY=VALUE pairs to set on the app. */
  env?: Record<string, string>;
}

/**
 * The single structured result a deploy ends with. BUILT FROM the ledger in code
 * — never parsed from the LLM's prose (the testers' VERDICT-parse is the #1 runtime
 * risk; here the source of truth is the ledger the verbs write).
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

// ── In-process contract (door ↔ verbs) ──────────────────────────────────────

/**
 * The structured accumulator the verbs WRITE and the door READS to build the
 * DeployResult. The verbs mutate this (never return prose the door must parse);
 * `error` set by any verb forces status="failed", as does health "unhealthy".
 */
export interface DeployLedger {
  /** Advanced by each verb (e.g. "detected", "provisioned", "shipped"). */
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
  /** First fatal error; presence forces a "failed" result. */
  error?: string;
}

/**
 * The live deploy context the door sets and the verbs read. One at a time
 * (a deploy is serialized); `getCurrentDeploy()` exposes it to the verb code.
 */
export interface CurrentDeploy {
  /** Validated absolute project dir (the sandbox root). */
  project_dir: string;
  subdomain: string;
  intent: string;
  env?: Record<string, string>;
  ledger: DeployLedger;
  /**
   * Transient inter-verb scratchpad (e.g. the captured Convex URL + the build-env var
   * name it goes under, the resolved flow). NOT surfaced to the client — only the ledger
   * is. Door inits it to {}.
   */
  scratch: Record<string, string>;
}

// ── Transport union ──────────────────────────────────────────────────────────

export interface TransportBase {
  type: string;
  ts: number;
  requestId: string;
}

/** client → manager: please run this deploy. */
export interface DeployMessage extends TransportBase {
  type: "deploy";
  from: "client";
  project_dir: string;
  subdomain: string;
  intent: string;
  env?: Record<string, string>;
}

/**
 * manager → client: the deploy is done, here is the structured result.
 *
 * v1 transport is synchronous request/response — this is returned as the HTTP 200
 * body of the client's POST /deploy (a deploy runs to completion and returns, per
 * DESIGN §2), so the client needs no server of its own. The type tag keeps the
 * body self-describing and leaves room for a future async-callback variant.
 */
export interface DeployResultMessage extends TransportBase {
  type: "deploy_result";
  from: "manager";
  result: DeployResult;
}

export type TransportMessage = DeployMessage | DeployResultMessage;
