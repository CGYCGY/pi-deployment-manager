// Typed wrappers over the coolify skill scripts (mutations) + direct Coolify API
// reads (idempotency / collision checks the scripts don't cover). The verb CODE calls
// these; the LLM never does. Mutations run the scripts with cwd=project_dir so they
// source deploy/.env.deploy, and also receive the central creds via env.

import { getCoolify } from "../shared/config.ts";
import { runCommand, runSkill, SkillError, skillScript } from "./skills.ts";

const TOOLS = "coolify/tools";

/** Central Coolify creds for every skill call (belt-and-braces with deploy/.env.deploy). */
function coolifyEnv(): Record<string, string> {
  const c = getCoolify();
  return {
    COOLIFY_BASE_URL: c.base_url,
    COOLIFY_API_TOKEN: c.api_token,
    COOLIFY_SERVER_UUID: c.server_uuid,
    COOLIFY_DEST_UUID: c.dest_uuid,
  };
}

export async function createProject(projectDir: string, name: string): Promise<string> {
  return runSkill(`${TOOLS}/create-project.sh`, [name], { cwd: projectDir, env: coolifyEnv() });
}

export interface CreateAppOpts {
  projectUuid: string;
  name: string;
  /** Full image ref, e.g. ghcr.io/<org>/<repo>. */
  image: string;
  exposedPort?: number;
  portsMappings?: string;
  /** "name:/mount[,name2:/mount2]" — persistent Coolify volumes (sqlite-volume addon). */
  persistentStorages?: string;
  instantDeploy?: boolean;
}

/**
 * Create the Coolify app. Side effect (in create-app.sh): appends COOLIFY_APP_UUID +
 * COOLIFY_WEBHOOK_URL to deploy/.env.deploy — so deploy/.env.deploy MUST already exist
 * (call writeEnvDeploy first). Returns the new app uuid.
 */
export async function createApp(projectDir: string, opts: CreateAppOpts): Promise<string> {
  const env = coolifyEnv();
  if (opts.exposedPort != null) env.EXPOSED_PORT = String(opts.exposedPort);
  if (opts.portsMappings) env.PORTS_MAPPINGS = opts.portsMappings;
  if (opts.persistentStorages) env.PERSISTENT_STORAGES = opts.persistentStorages;
  env.INSTANT_DEPLOY = String(opts.instantDeploy ?? true);
  return runSkill(`${TOOLS}/create-app.sh`, [opts.projectUuid, opts.name, opts.image], {
    cwd: projectDir,
    env,
  });
}

/** Set the app's env vars from a KEY=VALUE file (replaces the app's env set, not additive). */
export async function setEnvs(projectDir: string, appUuid: string, envFilePath: string): Promise<void> {
  await runSkill(`${TOOLS}/set-envs.sh`, [appUuid, envFilePath], { cwd: projectDir, env: coolifyEnv() });
}

export async function updateAppDomain(projectDir: string, appUuid: string, fqdn: string): Promise<void> {
  await runSkill(`${TOOLS}/update-app-domain.sh`, [appUuid, fqdn], { cwd: projectDir, env: coolifyEnv() });
}

/** Latest deployment status: "queued" | "in_progress" | "finished" | "failed" | "none". */
export async function getDeploymentStatus(projectDir: string, appUuid: string): Promise<string> {
  return runSkill(`${TOOLS}/get-deployment-status.sh`, [appUuid], { cwd: projectDir, env: coolifyEnv() });
}

export async function getAppLogs(projectDir: string, appUuid: string, lines = 100): Promise<string> {
  // exit 2 = Coolify logging API unavailable. Logs are diagnostic only, so a missing
  // logging API must NOT fail the deploy — handle the code instead of throwing.
  const r = await runCommand("bash", [skillScript(`${TOOLS}/get-app-logs.sh`), appUuid, String(lines)], {
    cwd: projectDir,
    env: coolifyEnv(),
  });
  if (r.code === 0) return r.stdout.trimEnd();
  if (r.code === 2) return "";
  throw new SkillError(`${TOOLS}/get-app-logs.sh`, r.code, r.stderr.trim());
}

// ── Live reads (idempotency + subdomain-collision guard) ────────────────────────

export interface CoolifyApp {
  uuid: string;
  name: string;
  /** Coolify stores domains as a comma-separated string (may include scheme); null if unset. */
  fqdn: string | null;
}

async function coolifyApi(path: string): Promise<unknown> {
  const c = getCoolify();
  const res = await fetch(`${c.base_url}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${c.api_token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Coolify API ${path} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** All applications on the server — the live source of truth for what subdomains exist. */
export async function listApplications(): Promise<CoolifyApp[]> {
  const data = await coolifyApi("/applications");
  if (!Array.isArray(data)) return [];
  return data.map((a) => {
    const app = a as { uuid?: string; name?: string; fqdn?: string | null };
    return { uuid: app.uuid ?? "", name: app.name ?? "", fqdn: app.fqdn ?? null };
  });
}

export async function getApplication(uuid: string): Promise<CoolifyApp | null> {
  try {
    const a = (await coolifyApi(`/applications/${uuid}`)) as {
      uuid?: string;
      name?: string;
      fqdn?: string | null;
    };
    return { uuid: a.uuid ?? uuid, name: a.name ?? "", fqdn: a.fqdn ?? null };
  } catch {
    return null;
  }
}

export interface CoolifyProject {
  uuid: string;
  name: string;
}

/** All Coolify projects (the grouping containers apps live under). */
export async function listProjects(): Promise<CoolifyProject[]> {
  const data = await coolifyApi("/projects");
  if (!Array.isArray(data)) return [];
  return data.map((p) => {
    const x = p as { uuid?: string; name?: string };
    return { uuid: x.uuid ?? "", name: x.name ?? "" };
  });
}

/**
 * Find the Coolify project named `name`, or create it. All managed apps live under one
 * reused project. Fails loud if the project list can't be read — creating blindly would
 * spawn a duplicate project on every deploy.
 */
export async function findOrCreateProject(projectDir: string, name: string): Promise<string> {
  const existing = (await listProjects()).find((p) => p.name === name && p.uuid);
  if (existing) return existing.uuid;
  return createProject(projectDir, name);
}

/**
 * Public IP of the configured Coolify server — the A-record target for a project's
 * subdomain. Parsed from list-servers.sh (`uuid|name|ip`) rather than guessing the API
 * shape, matching the configured server_uuid.
 */
export async function getServerIp(projectDir: string): Promise<string> {
  const out = await runSkill(`${TOOLS}/list-servers.sh`, [], { cwd: projectDir, env: coolifyEnv() });
  const { server_uuid } = getCoolify();
  for (const line of out.split("\n")) {
    const [uuid, , ip] = line.trim().split("|");
    if (uuid === server_uuid) {
      if (!ip) throw new Error(`getServerIp: server ${server_uuid} has no IP in the Coolify servers list.`);
      return ip;
    }
  }
  throw new Error(`getServerIp: server ${server_uuid} not found in the Coolify servers list.`);
}
