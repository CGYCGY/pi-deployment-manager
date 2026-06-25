// The subprocess engine: how the verb CODE runs the deployment skill scripts (and
// other CLIs). The manager LLM never reaches this — a skill is "a prompt telling an
// LLM to run bash", exactly the capability the gate removes; here the bash is driven
// by code instead (DESIGN §5). Mirrors pi-e2e-tester spoke/device.ts spawnCli:
// capture stdout/stderr, hard timeout → SIGKILL, fail closed on non-zero exit.

import { spawn } from "node:child_process";
import { join } from "node:path";

import { getSkillsDir } from "../shared/config.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed (timeout) or never spawned (spawn error). */
  code: number | null;
}

export interface RunOpts {
  /** Scripts source deploy/.env.deploy from cwd, so cwd MUST be the project_dir. */
  cwd: string;
  /** Extra env merged over process.env (central creds — belt-and-braces). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

// Skill scripts are Coolify/Cloudflare API calls (curl) — quick, but bound them so a
// hung curl can't wedge a deploy past the door's own DEPLOY_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** A failed skill/command: carries the exit code so callers can branch (e.g. logs exit 2). */
export class SkillError extends Error {
  readonly code: number | null;
  constructor(what: string, code: number | null, detail: string) {
    super(`${what} failed (exit ${code ?? "killed"})${detail ? `: ${detail}` : ""}`);
    this.name = "SkillError";
    this.code = code;
  }
}

/** Absolute path to a skill script under the configured skills dir. */
export function skillScript(relScriptPath: string): string {
  return join(getSkillsDir(), relScriptPath);
}

export function runCommand(bin: string, args: string[], opts: RunOpts): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]`, code: null });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + "\n" + err.message, code: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** runCommand that fails closed: throws SkillError (with stderr) on non-zero/killed; returns trimmed stdout. */
export async function runChecked(bin: string, args: string[], opts: RunOpts): Promise<string> {
  const r = await runCommand(bin, args, opts);
  if (r.code !== 0) {
    const what = bin === "bash" ? (args[0] ?? bin) : bin;
    throw new SkillError(what, r.code, r.stderr.trim() || r.stdout.trim());
  }
  return r.stdout.trim();
}

/** Run a skill script (e.g. "coolify/tools/create-app.sh") fail-closed; returns trimmed stdout. */
export async function runSkill(relScriptPath: string, args: string[], opts: RunOpts): Promise<string> {
  return runChecked("bash", [skillScript(relScriptPath), ...args], opts);
}
