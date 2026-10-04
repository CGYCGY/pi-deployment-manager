// Shared helpers for the deploy-via-manager RPC driver. The driver summons the gated
// pi-deployment-manager over pi's native --mode rpc (stdin/stdout JSONL, no HTTP/port)
// and converses with it. This file owns: locating the manager checkout, loading its
// config, the pi spawn argv, JSONL framing, and the notify-marker contract the manager emits.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The skill root (parent of tools/), self-located so config resolution is independent of the
// caller's cwd. Realpath'd so a skill folder symlinked into ~/.claude/skills resolves to the
// checkout it lives in.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = realpathSync(resolve(TOOLS_DIR, ".."));

// Notify markers the manager emits on the RPC event stream (extension_ui_request /
// method:"notify"). READY = session booted; RESULT = a code-derived DeployResult JSON.
export const READY_MARK = "PIDEPLOY_READY";
export const RESULT_MARK = "PIDEPLOY_RESULT";

// pi process --name tag; distinctive enough that `pkill -f PI_NAME` can target the
// manager's pi without matching the driver's own argv.
export const PI_NAME = "pi-deployment-manager:rpc";

// Bun's os.homedir() caches its first answer, so a changed $HOME (tests, sudo -E) would be missed.
function home(): string {
  return process.env.HOME || homedir();
}

export function expandTilde(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/")) return join(home(), p.slice(2));
  return p;
}

// Must match shared/config.ts in the manager: both sides read the same config and state paths.
// Functions, not constants, so a test can swap HOME between cases.
export function dataDir(): string {
  return join(home(), ".gylab", "pi-deployment-manager");
}

export function managerConfigPath(): string {
  const override = process.env.PI_DEPLOYMENT_MANAGER_CONFIG?.trim();
  return override ? resolve(expandTilde(override)) : join(dataDir(), "config.json");
}

export function defaultStateDir(): string {
  return join(dataDir(), "state");
}

export function isManagerCheckout(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
    if (pkg.name === "pi-deployment-manager") return true;
  } catch {
    /* no or unreadable package.json: fall through to the layout check */
  }
  return existsSync(join(dir, "manager")) && existsSync(join(dir, "shared", "config.ts"));
}

/**
 * Resolve the pi-deployment-manager checkout. Order: PI_DEPLOYMENT_MANAGER_DIR, the skill-local
 * config.json {managerDir}, the checkout the skill folder really sits in (developer mode: the
 * skill is a symlink into it), then ~/.gylab/pi-deployment-manager (skill mode: setup.sh clones
 * it there). An explicit location that is not a checkout is an error, never skipped.
 */
export function resolveManagerDir(skillDir: string = SKILL_DIR): string {
  const explicit: [string, string | undefined][] = [
    ["PI_DEPLOYMENT_MANAGER_DIR", process.env.PI_DEPLOYMENT_MANAGER_DIR?.trim()],
    [join(skillDir, "config.json"), readSkillConfig(skillDir).managerDir?.trim()],
  ];
  for (const [source, value] of explicit) {
    if (!value) continue;
    const dir = resolve(expandTilde(value));
    if (!isManagerCheckout(dir)) {
      throw new Error(`manager dir "${dir}" (from ${source}) is not a pi-deployment-manager checkout.`);
    }
    return dir;
  }

  let real = skillDir;
  try {
    real = realpathSync(skillDir);
  } catch {
    /* a vanished skill dir just fails the checkout test below */
  }
  const enclosing = resolve(real, "..", "..", "..");
  if (isManagerCheckout(enclosing)) return enclosing;

  if (isManagerCheckout(dataDir())) return dataDir();

  throw new Error(
    "no pi-deployment-manager checkout found (checked PI_DEPLOYMENT_MANAGER_DIR, " +
      `${join(skillDir, "config.json")}, the checkout enclosing ${real}, and ${dataDir()}). ` +
      `Run \`bash "${join(skillDir, "setup.sh")}" -y\` to clone and set it up.`,
  );
}

interface SkillConfig {
  managerDir?: string;
}

function readSkillConfig(skillDir: string): SkillConfig {
  const file = join(skillDir, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SkillConfig;
  } catch {
    return {};
  }
}

export interface ManagerCfg {
  /** The config file both the manager and this driver read. */
  configPath: string;
  /** Where the manager (and this driver) keep state/logs. */
  stateDir: string;
  /** pi model + thinking overrides (passed to the spawned pi). */
  model?: string;
  thinking?: string;
}

/**
 * Read stateDir + model/thinking from the manager's config (creds stay untouched). A missing file
 * yields the defaults so `down`/`clean` still work; commands that spawn the manager check
 * configPath themselves.
 */
export function loadManagerCfg(): ManagerCfg {
  const file = managerConfigPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`manager config is not valid JSON: ${file}`);
    }
  }
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const stateDir = str(raw.stateDir);
  return {
    configPath: file,
    stateDir: stateDir ? expandTilde(stateDir) : defaultStateDir(),
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

/**
 * Project dirs named in a request that the manager set up before but whose gitignored
 * deploy/.env.deploy is gone (a fresh clone, another machine). scaffold always writes
 * deploy/Dockerfile, deploy/deploy.sh and deploy/.env.deploy together, and deploy.sh is the
 * manager's own bundled asset, so the two committed files prove a prior setup. Without the
 * .env.deploy the manager cannot find the existing Coolify app and falls back to the initial
 * flow, so the driver refuses before summoning it.
 */
export function missingEnvDeploy(message: string): string[] {
  const found: string[] = [];
  for (const m of message.matchAll(/(?:^|[\s"'`(])((?:~|\/)[^\s"'`()]*)/g)) {
    const raw = m[1];
    if (!raw) continue;
    const dir = expandTilde(raw.replace(/[.,;:!?]+$/, "").replace(/\/+$/, ""));
    if (!dir.startsWith("/") || found.includes(dir)) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const deploy = join(dir, "deploy");
    if (
      existsSync(join(deploy, "deploy.sh")) &&
      existsSync(join(deploy, "Dockerfile")) &&
      !existsSync(join(deploy, ".env.deploy"))
    ) {
      found.push(dir);
    }
  }
  return found;
}
