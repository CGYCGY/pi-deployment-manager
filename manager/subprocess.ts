// The one place the manager shells out. All API calls (Coolify, Cloudflare) are native
// HTTP now; the only real subprocesses left are the local build/deploy CLIs the manager
// can't replace with a fetch: the vendored deploy.sh (docker build → GHCR push → webhook),
// `npx convex deploy`, and `gh`/`git`. Capture stdout/stderr, hard timeout → SIGKILL.

import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed (timeout) or never spawned (spawn error). */
  code: number | null;
}

export interface RunOpts {
  /** Working directory — the project_dir for build/deploy CLIs. */
  cwd: string;
  /** Extra env merged over process.env. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

// deploy.sh runs docker build + push, which can be slow; default high and let callers
// tighten. The door's own DEPLOY_TIMEOUT_MS is the outer bound.
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

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
