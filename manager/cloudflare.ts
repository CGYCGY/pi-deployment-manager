// Typed wrappers over the cloudflare skill scripts. The verb CODE calls these; the
// LLM never does. Every call runs the script with cwd=project_dir and the central
// Cloudflare creds (token + the one zone id) injected via env.

import { getCloudflare } from "../shared/config.ts";
import { runSkill } from "./skills.ts";

const TOOLS = "cloudflare/tools";

function cfEnv(): Record<string, string> {
  const c = getCloudflare();
  return { CLOUDFLARE_API_TOKEN: c.api_token, CLOUDFLARE_ZONE_ID: c.zone_id };
}

export async function findZoneId(projectDir: string, domain: string): Promise<string> {
  return runSkill(`${TOOLS}/find-zone-id.sh`, [domain], { cwd: projectDir, env: cfEnv() });
}

export async function getZoneName(projectDir: string): Promise<string> {
  return runSkill(`${TOOLS}/get-zone-name.sh`, [], { cwd: projectDir, env: cfEnv() });
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/**
 * List DNS records on the zone. The script's name filter is positional arg2, so a
 * name filter REQUIRES a type (arg1) — callers (the collision guard) always pass both.
 */
export async function listRecords(projectDir: string, type?: string, name?: string): Promise<DnsRecord[]> {
  const args: string[] = [];
  if (type) args.push(type);
  if (name) args.push(name);
  const out = await runSkill(`${TOOLS}/list-records.sh`, args, { cwd: projectDir, env: cfEnv() });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, t, n, content, proxied] = l.split("|");
      return { id: id ?? "", type: t ?? "", name: n ?? "", content: content ?? "", proxied: proxied === "true" };
    });
}

/**
 * Create or update (idempotent upsert by type+name) a DNS record; returns the record id.
 * The 4th arg is `proxied` (true/false) for A/AAAA/CNAME, or `priority` for MX/SRV.
 */
export async function createRecord(
  projectDir: string,
  type: string,
  name: string,
  content: string,
  proxiedOrPriority?: string,
): Promise<string> {
  const args = [type, name, content];
  if (proxiedOrPriority != null) args.push(proxiedOrPriority);
  return runSkill(`${TOOLS}/create-record.sh`, args, { cwd: projectDir, env: cfEnv() });
}

export async function deleteRecord(projectDir: string, id: string): Promise<void> {
  await runSkill(`${TOOLS}/delete-record.sh`, [id], { cwd: projectDir, env: cfEnv() });
}
