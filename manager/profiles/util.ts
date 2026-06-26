// Read-only project inspection helpers shared by every profile/addon detect().
//
// Every path goes through shared/sandbox.assertReadable first: detection reads the
// caller's repo, so it MUST be confined to project_dir (read-only) exactly like the
// verbs are — an unvetted fs read here would be a hole in the gate. assertReadable
// throws on escape; these wrappers swallow that (and ENOENT) into a null/false so a
// missing or out-of-bounds file simply means "signal absent", never a crash.

import { existsSync, readFileSync, statSync } from "node:fs";

import { assertReadable } from "../../shared/sandbox.ts";

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [k: string]: unknown;
}

export function readText(projectDir: string, relPath: string): string | null {
  let full: string;
  try {
    full = assertReadable(projectDir, relPath);
  } catch {
    return null;
  }
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

export function exists(projectDir: string, relPath: string): boolean {
  try {
    return existsSync(assertReadable(projectDir, relPath));
  } catch {
    return false;
  }
}

export function isDir(projectDir: string, relPath: string): boolean {
  try {
    return statSync(assertReadable(projectDir, relPath)).isDirectory();
  } catch {
    return false;
  }
}

export function existsFirst(projectDir: string, names: string[]): boolean {
  return names.some((n) => exists(projectDir, n));
}

/** First readable file from the candidate list (config files have many extensions). */
export function readFirst(projectDir: string, names: string[]): string | null {
  for (const n of names) {
    const t = readText(projectDir, n);
    if (t != null) return t;
  }
  return null;
}

export function readPackageJson(projectDir: string): PackageJson | null {
  const text = readText(projectDir, "package.json");
  if (!text) return null;
  try {
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

export function allDeps(pkg: PackageJson | null): Record<string, string> {
  if (!pkg) return {};
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

export function hasDep(pkg: PackageJson | null, name: string): boolean {
  return name in allDeps(pkg);
}

export function hasAnyDep(pkg: PackageJson | null, names: string[]): boolean {
  const deps = allDeps(pkg);
  return names.some((n) => n in deps);
}

export function hasBuildScript(pkg: PackageJson | null): boolean {
  return Boolean(pkg?.scripts?.build);
}

// Config-file name candidates + the SSR-adapter list, shared so a profile.detect and
// detectProfile() can't drift on what counts as "a Next/Astro project".
export const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"];
export const ASTRO_CONFIGS = ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.cjs"];
// An Astro adapter dep means the project wants SSR (a running server) — which this
// manager does not host. Its presence disqualifies the static profile.
export const ASTRO_SSR_ADAPTERS = ["@astrojs/node", "@astrojs/vercel", "@astrojs/netlify", "@astrojs/cloudflare"];

/** True when next.config declares `output: 'export'` (a fully static bundle in out/). */
export function nextOutputIsExport(projectDir: string): boolean {
  const cfg = readFirst(projectDir, NEXT_CONFIGS) ?? "";
  return /output\s*:\s*['"]export['"]/.test(cfg);
}

export function isAstroStatic(projectDir: string, pkg: PackageJson | null): boolean {
  return existsFirst(projectDir, ASTRO_CONFIGS) && !hasAnyDep(pkg, ASTRO_SSR_ADAPTERS);
}

// ── Bring-your-own-Dockerfile (generic profile) ──────────────────────────────

/** The project's own Dockerfile (root preferred, then deploy/), or null if it ships none. */
export function readProjectDockerfile(projectDir: string): string | null {
  return readText(projectDir, "Dockerfile") ?? readText(projectDir, "deploy/Dockerfile");
}

export interface DockerfileMeta {
  /** First EXPOSE port. */
  expose?: number;
  /** First VOLUME mount path (e.g. "/data"). */
  volumeMount?: string;
  /** URL path pulled from the HEALTHCHECK CMD (e.g. "/healthz"). */
  healthPath?: string;
}

/**
 * Parse the deploy-relevant directives a container declares about itself, so the generic
 * profile can honor the project's own Dockerfile instead of needing language knowledge.
 * Best-effort and forgiving: a directive that isn't found simply stays undefined.
 */
export function parseDockerfile(text: string): DockerfileMeta {
  const meta: DockerfileMeta = {};

  const expose = text.match(/^\s*EXPOSE\s+(\d+)/im);
  if (expose?.[1]) meta.expose = Number(expose[1]);

  // `VOLUME ["/data", ...]` (JSON array) or `VOLUME /data /other` (shell form) — take the first path.
  const volume = text.match(/^\s*VOLUME\s+(.+)$/im);
  const firstMount = volume?.[1]?.match(/\/[^\s"'[\],]+/);
  if (firstMount) meta.volumeMount = firstMount[0];

  // HEALTHCHECK can wrap across lines with `\`; pull the first URL path out of its CMD.
  const health = text.match(/HEALTHCHECK[\s\S]*?CMD[\s\S]*?https?:\/\/[^/\s]+(\/[^\s"'|)\\]*)/i);
  if (health?.[1]) meta.healthPath = health[1];

  return meta;
}
