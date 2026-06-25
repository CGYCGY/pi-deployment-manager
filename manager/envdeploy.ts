// The cred-injection seam (DESIGN §5.1): central creds live ONLY in the manager's
// config; here they are written into the project's gitignored deploy/.env.deploy at
// deploy time so the skill scripts (which source it from cwd) can authenticate, and
// the project itself never carries secrets. Every path goes through the sandbox.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getCloudflare, getCoolify, getRegistry } from "../shared/config.ts";
import { assertReadable, assertWritable, safeDeployPath } from "../shared/sandbox.ts";

/** Project-specific values to fold into deploy/.env.deploy (creds come from central config). */
export interface EnvDeployFields {
  repoName?: string;
  subdomain?: string;
  domain?: string;
  appUuid?: string;
  webhookUrl?: string;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // create-app.sh writes COOLIFY_WEBHOOK_URL quoted; strip one quote layer.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Parse the project's existing deploy/.env.deploy into a map ({} if absent). */
export function readEnvDeploy(projectDir: string): Record<string, string> {
  const path = assertReadable(projectDir, "deploy/.env.deploy");
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

/**
 * (Re)write deploy/.env.deploy from central config + the passed project fields,
 * PRESERVING any COOLIFY_APP_UUID / COOLIFY_WEBHOOK_URL the skill scripts already
 * wrote (create-app.sh appends them as a side effect — clobbering would orphan the
 * provisioned app). Returns the absolute path. The file is gitignored; never committed.
 */
export function writeEnvDeploy(projectDir: string, fields: EnvDeployFields = {}): string {
  const existing = readEnvDeploy(projectDir);
  const coolify = getCoolify();
  const cf = getCloudflare();
  const reg = getRegistry();

  const appUuid = fields.appUuid ?? existing.COOLIFY_APP_UUID ?? "";
  const webhookUrl = fields.webhookUrl ?? existing.COOLIFY_WEBHOOK_URL ?? "";
  const repoName = fields.repoName ?? existing.REPO_NAME ?? "";
  const subdomain = fields.subdomain ?? existing.SUBDOMAIN ?? "";
  const domain = fields.domain ?? existing.DOMAIN ?? "";

  const lines = [
    "# Managed by pi-deployment-manager — central creds injected at deploy time.",
    "# Gitignored; never committed.",
    "",
    "# GitHub / registry",
    `GITHUB_ORG=${reg.github_org}`,
    `REPO_NAME=${repoName}`,
    "",
    "# Coolify (central creds)",
    `COOLIFY_BASE_URL=${coolify.base_url}`,
    `COOLIFY_API_TOKEN=${coolify.api_token}`,
    `COOLIFY_SERVER_UUID=${coolify.server_uuid}`,
    `COOLIFY_DEST_UUID=${coolify.dest_uuid}`,
    "",
    "# Coolify app (written by create-app.sh; preserved across rewrites)",
    `COOLIFY_APP_UUID=${appUuid}`,
    `COOLIFY_WEBHOOK_URL="${webhookUrl}"`,
    "",
    "# Domain",
    `DOMAIN=${domain}`,
    `SUBDOMAIN=${subdomain}`,
    "",
    "# Cloudflare (central creds)",
    `CLOUDFLARE_API_TOKEN=${cf.api_token}`,
    `CLOUDFLARE_ZONE_ID=${cf.zone_id}`,
    "",
  ];

  const path = safeDeployPath(projectDir, ".env.deploy");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

/** Ensure deploy/.env.deploy is gitignored in the project root (append if missing). */
export function ensureGitignored(projectDir: string): void {
  const path = assertWritable(projectDir, ".gitignore");
  const entry = "deploy/.env.deploy";
  let content = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (content.split("\n").some((l) => l.trim() === entry)) return;
  const sep = content.length && !content.endsWith("\n") ? "\n" : "";
  writeFileSync(path, content + sep + entry + "\n", "utf8");
}
