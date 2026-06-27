// Shared helpers for the deploy-via-manager RPC driver. The driver summons the gated
// pi-deployment-manager over pi's native --mode rpc (stdin/stdout JSONL, no HTTP/port)
// and converses with it. This file owns: locating the manager (config only, never a
// hardcoded path), loading its config, the pi spawn argv, JSONL framing, and the
// notify-marker contract the manager emits.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The skill root (parent of tools/), self-located so config resolution is independent
// of the caller's cwd.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = resolve(TOOLS_DIR, "..");

// Notify markers the manager emits on the RPC event stream (extension_ui_request /
// method:"notify"). READY = session booted; RESULT = a code-derived DeployResult JSON.
export const READY_MARK = "PIDEPLOY_READY";
export const RESULT_MARK = "PIDEPLOY_RESULT";

// pi process --name tag; distinctive enough that `pkill -f PI_NAME` can target the
// manager's pi without matching the driver's own argv.
export const PI_NAME = "pi-deployment-manager:rpc";

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the pi-deployment-manager checkout — CONFIG ONLY, never a hardcoded fallback.
 * Order: PI_DEPLOYMENT_MANAGER_DIR env var, then the skill-local config.json {managerDir}.
 * If neither is set (or the path is not a manager checkout), throw a clear, actionable error.
 */
export function resolveManagerDir(): string {
  const fromEnv = process.env.PI_DEPLOYMENT_MANAGER_DIR?.trim();
  let dir = fromEnv || readSkillConfig().managerDir?.trim();
  if (!dir) {
    throw new Error(
      "manager location not configured. Set PI_DEPLOYMENT_MANAGER_DIR, or add " +
        `{"managerDir": "/abs/path/to/pi-deployment-manager"} to ${join(SKILL_DIR, "config.json")} ` +
        "(see config.json.example). No path is assumed.",
    );
  }
  dir = expandTilde(dir);
  if (!existsSync(join(dir, "manager", "index.ts"))) {
    throw new Error(`manager dir "${dir}" is not a pi-deployment-manager checkout (no manager/index.ts).`);
  }
  return dir;
}

interface SkillConfig {
  managerDir?: string;
}

function readSkillConfig(): SkillConfig {
  const file = join(SKILL_DIR, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SkillConfig;
  } catch {
    return {};
  }
}

export interface ManagerCfg {
  /** Where the manager (and this driver) keep state/logs. */
  stateDir: string;
  /** pi model + thinking overrides (passed to the spawned pi). */
  model?: string;
  thinking?: string;
}

/** Read the manager's own config.json for stateDir + model/thinking (creds stay untouched). */
export function loadManagerCfg(managerDir: string): ManagerCfg {
  const file = join(managerDir, "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`manager config.json is not valid JSON: ${file}`);
    }
  }
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  return {
    stateDir: expandTilde(str(raw.stateDir) ?? "~/.pi-deployment-manager"),
    model: str(raw.model),
    thinking: str(raw.thinking),
  };
}

export interface Paths {
  dir: string;
  /** FIFO the CLI writes deploy requests to; the detached __manager reads them. */
  fifo: string;
  /** JSONL the __manager appends per-request results to; the CLI tails it. */
  out: string;
  /** Session record: {pid, piPid, ready, ...}. */
  state: string;
}

export function paths(stateDir: string): Paths {
  return {
    dir: stateDir,
    fifo: join(stateDir, "client.in"),
    out: join(stateDir, "client.out"),
    state: join(stateDir, "client.json"),
  };
}

/**
 * The pi argv that summons the manager in RPC mode. THE GATE: --no-builtin-tools makes
 * bash/read/write/edit/glob unrepresentable; --no-extensions blocks other extensions from
 * re-adding tools; -nc drops ambient AGENTS.md/CLAUDE.md. --mode rpc = stdin/stdout JSONL.
 */
export function piArgs(managerDir: string, cfg: ManagerCfg): string[] {
  const args = [
    "--no-extensions",
    "--no-builtin-tools",
    "-nc",
    "--mode",
    "rpc",
    "-e",
    join(managerDir, "manager", "index.ts"),
    // Distinctive tag so teardown's `pkill -f` matches ONLY this pi, never the driver itself.
    "--name",
    PI_NAME,
  ];
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.thinking) args.push("--thinking", cfg.thinking);
  return args;
}

/**
 * Inspect one parsed RPC event for the manager's notify markers. RPC mode surfaces
 * ctx.ui.notify as {type:"extension_ui_request", method:"notify", message}. READY/RESULT
 * are the manager's two structured signals; everything else (plain assistant text) is a
 * human reply for the caller.
 */
export function parseNotify(msg: unknown): { ready?: boolean; result?: unknown } {
  const m = msg as { type?: string; method?: string; message?: unknown };
  if (m?.type !== "extension_ui_request" || m?.method !== "notify") return {};
  const text = String(m.message ?? "");
  if (text.startsWith(READY_MARK)) return { ready: true };
  if (text.startsWith(RESULT_MARK)) {
    const json = text.slice(RESULT_MARK.length).trim();
    try {
      return { result: JSON.parse(json) };
    } catch {
      return { result: { status: "failed", phase: "parse", error: `unparseable result: ${json.slice(0, 200)}` } };
    }
  }
  return {};
}

/** Split a growing buffer into complete LF-delimited lines (RPC is LF-only; strip a stray \r). */
export function takeLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buf;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl < 0) break;
    let line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) lines.push(line);
  }
  return { lines, rest };
}
