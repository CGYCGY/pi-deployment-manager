/**
 * shared/config.ts — load, parse, and expand config.json (the manager's single
 * source of truth for all deployment creds + infra coordinates).
 *
 * Read once (cached) at startup. This is the ONLY place the Coolify / Cloudflare /
 * GHCR / Convex credentials live: the manager injects them into each project's
 * gitignored deploy/.env.deploy at deploy time and never commits them, so projects
 * stop carrying secrets (DESIGN §5.1).
 *
 * Uses only node: built-ins, no pi runtime dependency.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory containing this module (shared/), resolved at runtime. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute project root, derived from this module's own location (shared/ lives
 * directly under it). Self-locating: survives moving/renaming the project dir,
 * so it can never drift the way a hardcoded path would.
 */
export const PROJECT_DIR = resolve(HERE, "..");

/**
 * Per-user data home, shared by every install mode: a developer checkout under ~/projects and a
 * skill-mode clone living at this very path both read config and write state here.
 */
export const DATA_DIR = join(home(), ".gylab", "pi-deployment-manager");

/** The manager config; PI_DEPLOYMENT_MANAGER_CONFIG overrides it (tests, unusual setups). */
export const CONFIG_PATH = process.env.PI_DEPLOYMENT_MANAGER_CONFIG?.trim()
  ? resolve(expandTilde(process.env.PI_DEPLOYMENT_MANAGER_CONFIG.trim()))
  : join(DATA_DIR, "config.json");

/** Logs and the skill driver's session files, unless config.json sets stateDir. */
export const DEFAULT_STATE_DIR = join(DATA_DIR, "state");

/** Bundled assets shipped with the manager (e.g. deploy.sh copied into a project). */
export const ASSETS_DIR = resolve(PROJECT_DIR, "assets");

/** Central Coolify creds — the one VPS the manager deploys to. */
export interface CoolifyConfig {
  base_url: string;
  api_token: string;
  server_uuid: string;
  dest_uuid: string;
}

/** Central Cloudflare creds + the one zone/domain every project gets a subdomain on. */
export interface CloudflareConfig {
  api_token: string;
  zone_id: string;
  zone_name: string;
  /**
   * How a subdomain is pointed at the app — depends on how the Coolify server is exposed:
   *   "@" (default)            → proxied CNAME to the zone apex (server behind a Cloudflare Tunnel)
   *   "<host>" (e.g. *.cfargotunnel.com) → proxied CNAME to that host
   *   "server-ip"              → proxied A record to the Coolify server's public IP
   * Cloudflare rejects proxied A records to private/CGNAT IPs, so a Tailscale-only server MUST
   * use a CNAME mode.
   */
  dns_target: string;
}

/**
 * Registry host only. The owner/repo half of the image name is per-project — detect
 * resolves it from the project's git origin remote, never from central config.
 */
export interface RegistryConfig {
  /** Registry host; "ghcr.io" in v1. */
  ghcr: string;
}

/** Convex Cloud deploy key (managed Convex, not self-hosted). */
export interface ConvexConfig {
  deploy_key: string;
}

export interface Config {
  /** Self-located project root (not from JSON). */
  projectDir: string;
  /** State/logs dir (~ expanded). */
  stateDir: string;
  coolify: CoolifyConfig;
  cloudflare: CloudflareConfig;
  registry: RegistryConfig;
  convex: ConvexConfig;
  /** Optional model + thinking overrides for the manager session. */
  model?: string;
  thinking?: string;
}

// $HOME first: Bun's os.homedir() caches its first answer, and the skill driver (run by Bun)
// must agree with this module on every path.
function home(): string {
  return process.env.HOME || homedir();
}

/** Expand a leading "~" or "~/" to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/")) return join(home(), p.slice(2));
  return p;
}

/** Validate the required shape; tolerate extra `_*` note keys (they're harmless). */
function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`config.json: expected an object, got ${typeof raw}`);
  }
  const r = raw as Record<string, unknown>;

  const obj = (key: string): Record<string, unknown> => {
    const v = r[key];
    if (typeof v !== "object" || v === null) {
      throw new Error(`config.json: "${key}" must be an object`);
    }
    return v as Record<string, unknown>;
  };
  const reqStr = (o: Record<string, unknown>, path: string, key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`config.json: "${path}.${key}" must be a non-empty string`);
    }
    return v;
  };
  const optStr = (o: Record<string, unknown>, key: string): string | undefined =>
    typeof o[key] === "string" && (o[key] as string).length > 0 ? (o[key] as string) : undefined;

  const coolify = obj("coolify");
  const cloudflare = obj("cloudflare");
  const registry = obj("registry");
  const convex = obj("convex");

  return {
    projectDir: PROJECT_DIR,
    stateDir: typeof r.stateDir === "string" && r.stateDir.length > 0 ? expandTilde(r.stateDir) : DEFAULT_STATE_DIR,
    coolify: {
      base_url: reqStr(coolify, "coolify", "base_url"),
      api_token: reqStr(coolify, "coolify", "api_token"),
      server_uuid: reqStr(coolify, "coolify", "server_uuid"),
      dest_uuid: reqStr(coolify, "coolify", "dest_uuid"),
    },
    cloudflare: {
      api_token: reqStr(cloudflare, "cloudflare", "api_token"),
      zone_id: reqStr(cloudflare, "cloudflare", "zone_id"),
      zone_name: reqStr(cloudflare, "cloudflare", "zone_name"),
      dns_target: optStr(cloudflare, "dns_target") ?? "@",
    },
    registry: {
      ghcr: typeof registry.ghcr === "string" && registry.ghcr.length > 0 ? registry.ghcr : "ghcr.io",
    },
    convex: { deploy_key: reqStr(convex, "convex", "deploy_key") },
    model: optStr(r, "model"),
    thinking: optStr(r, "thinking"),
  };
}

/** Cached parsed config (config.json does not change during a run). */
let cached: Config | null = null;

/** Load (and cache) the parsed, tilde-expanded config. */
export function loadConfig(): Config {
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `manager config not found at ${CONFIG_PATH} (${(err as Error).message}). ` +
        "Run setup.sh in the manager checkout (or the deploy-via-manager skill's setup.sh) to create it.",
    );
  }
  cached = parseConfig(JSON.parse(text));
  return cached;
}

/** Force a re-read on next access (useful in tests / after edits). */
export function clearConfigCache(): void {
  cached = null;
}

/** Project directory (absolute, self-located — see PROJECT_DIR). */
export function getProjectDir(): string {
  return PROJECT_DIR;
}

/** State/logs directory (~ expanded). */
export function getStateDir(): string {
  return loadConfig().stateDir;
}

export function getCoolify(): CoolifyConfig {
  return loadConfig().coolify;
}
export function getCloudflare(): CloudflareConfig {
  return loadConfig().cloudflare;
}
export function getRegistry(): RegistryConfig {
  return loadConfig().registry;
}
export function getConvex(): ConvexConfig {
  return loadConfig().convex;
}
export function getModelConfig(): { model?: string; thinking?: string } {
  const c = loadConfig();
  return { model: c.model, thinking: c.thinking };
}
