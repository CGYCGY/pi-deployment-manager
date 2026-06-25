/**
 * shared/sandbox.ts — the gate, enforced in code (DESIGN §5.0).
 *
 * pi has NO path sandbox for tools, and the manager mutates files in a DIFFERENT
 * repo than its own (the caller's project_dir). So every path the verbs touch is
 * vetted HERE, in code — this allowlist IS the "only ever touch deploy/, never
 * other files" guarantee, not a sentence the LLM is asked to honor.
 *
 * Scope (per deploy, rooted at the caller's project_dir):
 *   read   — anywhere under project_dir (detect must inspect package.json etc.)
 *   write  — ONLY <project_dir>/deploy/**, plus the two project-root writes
 *            coolify-setup makes: <project_dir>/.gitignore and .env.production.
 *
 * Uses only node: built-ins, no pi runtime dependency.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Validate the caller-supplied project_dir: must be an ABSOLUTE path to an existing
 * directory. Returns the resolved (normalized) path — the sandbox root for this
 * deploy. Throws on anything else (fail closed before any verb runs).
 */
export function validateProjectDir(dir: string): string {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("project_dir is required");
  }
  if (!isAbsolute(dir)) {
    throw new Error(`project_dir must be an absolute path (got "${dir}")`);
  }
  const full = resolve(dir);
  let st;
  try {
    st = statSync(full);
  } catch {
    throw new Error(`project_dir does not exist: ${full}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`project_dir is not a directory: ${full}`);
  }
  return full;
}

/** True if `child` is `parent` itself or lives strictly inside it (no `..` escape). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Assert `p` is READABLE under this deploy: it must resolve inside project_dir.
 * Returns the resolved absolute path. Read scope is the whole repo (read-only) so
 * detect can inspect manifests; it can never widen write scope.
 */
export function assertReadable(projectDir: string, p: string): string {
  const root = resolve(projectDir);
  const full = resolve(root, p);
  if (!isInside(root, full)) {
    throw new Error(`refused read: "${p}" resolves outside the project dir ${root}.`);
  }
  return full;
}

/**
 * Assert `p` is WRITABLE under this deploy. Allowlist ONLY:
 *   - anything under <project_dir>/deploy/
 *   - exactly <project_dir>/.gitignore
 *   - exactly <project_dir>/.env.production
 * Throws otherwise. Returns the resolved absolute path.
 */
export function assertWritable(projectDir: string, p: string): string {
  const root = resolve(projectDir);
  const full = resolve(root, p);
  const deployDir = resolve(root, "deploy");
  const allowedRootFiles = [resolve(root, ".gitignore"), resolve(root, ".env.production")];

  if (isInside(deployDir, full) || allowedRootFiles.includes(full)) {
    return full;
  }
  throw new Error(
    `refused write: "${p}" is outside the deploy allowlist ` +
      `(<project_dir>/deploy/**, .gitignore, .env.production). The manager only ` +
      `ever writes a project's deploy/ files.`,
  );
}

/**
 * Resolve a BARE filename under <project_dir>/deploy/ (no slashes, no `..`).
 * Defense-in-depth mirror of pi-e2e's safeWorkspacePath: regex-vet the name,
 * assert the parent dir, assert the basename round-trips.
 */
export function safeDeployPath(projectDir: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `invalid deploy file name "${name}": expected a bare file name ` +
        `(letters, digits, '.', '_', '-' only — no slashes or "..").`,
    );
  }
  const deployDir = resolve(projectDir, "deploy");
  const full = resolve(deployDir, name);
  if (resolve(full, "..") !== deployDir) {
    throw new Error(`refused: "${name}" resolves outside ${deployDir}.`);
  }
  return full;
}
