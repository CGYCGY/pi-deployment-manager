// The cred-injection seam (DESIGN §5.1): central creds live ONLY in the manager's
// config; here they are written into the project's gitignored deploy/.env.deploy at
// deploy time so the bundled deploy.sh (docker build/push + Coolify webhook) can
// authenticate, and the project itself never carries secrets. The manager's own API
// calls read creds from config directly — this file exists only for deploy.sh. Every
// path goes through the sandbox.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getCloudflare, getCoolify, getRegistry } from "../shared/config.ts";
import { assertReadable, assertWritable, safeDeployPath } from "../shared/sandbox.ts";

/**
 * Double-quote a value so deploy.sh can `source` it safely. deploy.sh does `set -a; source`,
 * so an UNquoted value with a shell metachar breaks it — notably Coolify API tokens are
 * `<id>|<hash>`, and the `|` is read as a pipe (the exit-127 "command not found" on the hash).
 * Double quotes neutralise |, spaces, & etc.; we still backslash-escape \ " $ ` so a value
 * can't expand a variable, run a command, or close the quote.
 */
function shDq(v: string): string {
  return `"${v.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/** Project-specific values to fold into deploy/.env.deploy (creds come from central config). */
export interface EnvDeployFields {
  repoName?: string;
  subdomain?: string;
  domain?: string;
  appUuid?: string;
  webhookUrl?: string;
}

/**
 * Parse dotenv text (KEY=VALUE per line, `#` comments and blanks skipped). Splits on the
 * FIRST `=` so values may contain `=` (base64 secrets), and strips one surrounding quote
 * layer. Shared with the env verb, which loads a project's runtime secret file the same way.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
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
  return parseDotenv(readFileSync(path, "utf8"));
}

/**
 * (Re)write deploy/.env.deploy from central config + the passed project fields,
 * PRESERVING any COOLIFY_APP_UUID / COOLIFY_WEBHOOK_URL already on disk (provision writes
 * them; later rewrites for DOMAIN/SUBDOMAIN must not clobber them or the app is orphaned).
 * Returns the absolute path. The file is gitignored; never committed.
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

  // Every value is shell-quoted: deploy.sh sources this file, so a bare metachar (e.g. the `|`
  // in a Coolify `<id>|<hash>` token) would otherwise execute as a command.
  const lines = [
    "# Managed by pi-deployment-manager — central creds injected at deploy time.",
    "# Gitignored; never committed.",
    "",
    "# GitHub / registry",
    `GITHUB_ORG=${shDq(reg.github_org)}`,
    `REPO_NAME=${shDq(repoName)}`,
    "",
    "# Coolify (central creds)",
    `COOLIFY_BASE_URL=${shDq(coolify.base_url)}`,
    `COOLIFY_API_TOKEN=${shDq(coolify.api_token)}`,
    `COOLIFY_SERVER_UUID=${shDq(coolify.server_uuid)}`,
    `COOLIFY_DEST_UUID=${shDq(coolify.dest_uuid)}`,
    "",
    "# Coolify app (written by provision; preserved across rewrites)",
    `COOLIFY_APP_UUID=${shDq(appUuid)}`,
    `COOLIFY_WEBHOOK_URL=${shDq(webhookUrl)}`,
    "",
    "# Domain",
    `DOMAIN=${shDq(domain)}`,
    `SUBDOMAIN=${shDq(subdomain)}`,
    "",
    "# Cloudflare (central creds)",
    `CLOUDFLARE_API_TOKEN=${shDq(cf.api_token)}`,
    `CLOUDFLARE_ZONE_ID=${shDq(cf.zone_id)}`,
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
