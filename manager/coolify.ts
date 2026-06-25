// Native Coolify API client (HTTP only, no subprocess). The verb CODE calls these; the
// LLM never does. Everything authenticates from the manager's central config — the
// project's deploy/.env.deploy is consumed ONLY by the vendored deploy.sh (docker
// build/push + webhook trigger), never by these reads/writes.

import { getCoolify } from "../shared/config.ts";

const API_PREFIX = "/api/v1";

interface CoolifyFetchOpts {
  method?: string;
  body?: unknown;
}

/** One fetch against the Coolify API with the central bearer token; never throws on HTTP status. */
async function coolifyFetch(path: string, opts: CoolifyFetchOpts = {}): Promise<Response> {
  const c = getCoolify();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.api_token}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${c.base_url}${API_PREFIX}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** Coolify API call returning parsed JSON; throws on non-2xx (fail closed). */
async function coolifyApi(path: string, opts: CoolifyFetchOpts = {}): Promise<unknown> {
  const res = await coolifyFetch(path, opts);
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `Coolify API ${opts.method ?? "GET"} ${path} -> HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
    );
  }
  return res.json();
}

// ── Mutations (the write path) ──────────────────────────────────────────────────

export async function createProject(name: string): Promise<string> {
  const data = (await coolifyApi("/projects", {
    method: "POST",
    body: { name, description: "Created by pi-deployment-manager" },
  })) as { uuid?: string };
  if (!data.uuid) throw new Error(`createProject: Coolify returned no uuid for "${name}".`);
  return data.uuid;
}

export interface CreateAppOpts {
  projectUuid: string;
  name: string;
  /** Full image ref, e.g. ghcr.io/<org>/<repo>. */
  image: string;
  exposedPort?: number;
  tag?: string;
  portsMappings?: string;
  /** "name:/mount[,name2:/mount2]" — persistent Coolify volumes (sqlite-volume addon). */
  persistentStorages?: string;
  instantDeploy?: boolean;
}

export interface CreatedApp {
  uuid: string;
  /** Deploy webhook the project's deploy.sh curls to trigger a redeploy. */
  webhookUrl: string;
}

/**
 * Create the Coolify app from a registry image and return its uuid + deploy webhook.
 * The caller writes both into deploy/.env.deploy (via writeEnvDeploy) so deploy.sh can
 * trigger the deployment. Persistent-volume attach is best-effort (a failed attach warns
 * but does not abort the provision), matching the prior behaviour.
 */
export async function createApp(opts: CreateAppOpts): Promise<CreatedApp> {
  const c = getCoolify();

  // Coolify needs the target environment's NAME; use the project's first env, else "production".
  let envName = "production";
  try {
    const envs = (await coolifyApi(`/projects/${opts.projectUuid}/environments`)) as Array<{ name?: string }>;
    if (Array.isArray(envs) && envs[0]?.name) envName = envs[0].name;
  } catch {
    /* fall back to "production" */
  }

  const body: Record<string, unknown> = {
    server_uuid: c.server_uuid,
    project_uuid: opts.projectUuid,
    environment_name: envName,
    destination_uuid: c.dest_uuid,
    name: opts.name,
    docker_registry_image_name: opts.image,
    docker_registry_image_tag: opts.tag ?? "latest",
    ports_exposes: String(opts.exposedPort ?? 80),
    instant_deploy: opts.instantDeploy ?? true,
  };
  if (opts.portsMappings) body.ports_mappings = opts.portsMappings;

  const created = (await coolifyApi("/applications/dockerimage", { method: "POST", body })) as { uuid?: string };
  if (!created.uuid) throw new Error(`createApp: Coolify returned no app uuid for "${opts.name}".`);
  const uuid = created.uuid;

  if (opts.persistentStorages) {
    for (const entry of opts.persistentStorages.split(",")) {
      const i = entry.indexOf(":");
      if (i <= 0) continue;
      const name = entry.slice(0, i).trim();
      const mount = entry.slice(i + 1).trim();
      if (!name || !mount) continue;
      try {
        await coolifyApi(`/applications/${uuid}/storages`, {
          method: "POST",
          body: { type: "persistent", name, mount_path: mount },
        });
      } catch (err) {
        console.error(`createApp: could not attach storage "${name}:${mount}" (${(err as Error).message}); continuing.`);
      }
    }
  }

  return { uuid, webhookUrl: `${c.base_url}${API_PREFIX}/deploy?uuid=${uuid}&force=false` };
}

/** Replace the app's env var set (Coolify's bulk endpoint overwrites, it is not additive). */
export async function setEnvs(appUuid: string, vars: Array<[string, string]>): Promise<void> {
  if (!vars.length) return;
  const data = vars.map(([key, value]) => ({ key, value, is_preview: false, is_build_time: false }));
  await coolifyApi(`/applications/${appUuid}/envs/bulk`, { method: "POST", body: { data } });
}

export async function updateAppDomain(appUuid: string, fqdn: string): Promise<void> {
  await coolifyApi(`/applications/${appUuid}`, { method: "PATCH", body: { domains: fqdn } });
}

// ── Reads ────────────────────────────────────────────────────────────────────────

/** Latest deployment status: "queued" | "in_progress" | "finished" | "failed" | "none". */
export async function getDeploymentStatus(appUuid: string): Promise<string> {
  const data = await coolifyApi(`/deployments/applications/${appUuid}?take=1`);
  if (!Array.isArray(data) || data.length === 0) return "none";
  const status = (data[0] as { status?: string }).status;
  if (!status) throw new Error(`getDeploymentStatus: malformed deployment response for ${appUuid}.`);
  return status;
}

export async function getAppLogs(appUuid: string, lines = 100): Promise<string> {
  // Logs are diagnostic only: a Coolify instance without a logging API must NOT fail a
  // deploy, so an "unsupported/unavailable" response returns "" rather than throwing.
  const res = await coolifyFetch(`/applications/${appUuid}/logs?lines=${lines}`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (res.ok) {
    if (parsed && typeof parsed === "object" && "logs" in parsed) {
      return String((parsed as { logs: unknown }).logs ?? "");
    }
    if (typeof parsed === "string") return parsed;
    return text.trim();
  }

  const msg =
    parsed && typeof parsed === "object" && "message" in parsed
      ? String((parsed as { message: unknown }).message ?? "")
      : "";
  if (/not support|unavailable/i.test(msg)) return ""; // logging API absent — non-fatal
  if (/not found|does not exist/i.test(msg)) throw new Error(`getAppLogs: application ${appUuid} not found.`);
  throw new Error(`getAppLogs: HTTP ${res.status}${msg ? `: ${msg}` : ""}.`);
}

export interface CoolifyApp {
  uuid: string;
  name: string;
  /** Coolify stores domains as a comma-separated string (may include scheme); null if unset. */
  fqdn: string | null;
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
export async function findOrCreateProject(name: string): Promise<string> {
  const existing = (await listProjects()).find((p) => p.name === name && p.uuid);
  if (existing) return existing.uuid;
  return createProject(name);
}

/**
 * Public IP of the configured Coolify server — the A-record target for a project's
 * subdomain, matched by the configured server_uuid.
 */
export async function getServerIp(): Promise<string> {
  const { server_uuid } = getCoolify();
  const data = await coolifyApi("/servers");
  if (!Array.isArray(data)) throw new Error("getServerIp: unexpected /servers response.");
  for (const s of data) {
    const srv = s as { uuid?: string; ip?: string };
    if (srv.uuid === server_uuid) {
      if (!srv.ip) throw new Error(`getServerIp: server ${server_uuid} has no IP in the Coolify servers list.`);
      return srv.ip;
    }
  }
  throw new Error(`getServerIp: server ${server_uuid} not found in the Coolify servers list.`);
}
