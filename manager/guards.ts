// The three fail-closed guards (DESIGN §8). Deterministic, in CODE — not the LLM's
// judgment. On a shared single VPS + single domain, COLLISIONS are the top silent
// failure, so these run around the mutating verbs and refuse on uncertainty.

import { getDeploymentStatus, listApplications } from "./coolify.ts";
import { readEnvDeploy } from "./envdeploy.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Normalize Coolify's comma-separated, scheme-and-path-bearing fqdn string to hostnames. */
function hostsOf(fqdn: string | null): string[] {
  if (!fqdn) return [];
  return fqdn
    .split(",")
    .map((s) => s.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase())
    .filter(Boolean);
}

/**
 * GUARD 1 — subdomain-collision. Refuse if `<subdomain>.<zone>` already maps to a
 * DIFFERENT Coolify app than ours. The caller picks the subdomain, so a clash is caller
 * error that must be caught, never silently clobbered. Fails CLOSED: if the live query
 * fails we can't prove the name is free, so we refuse.
 */
export async function assertSubdomainFree(
  subdomain: string,
  zoneName: string,
  ourAppUuid?: string,
): Promise<void> {
  const fqdn = `${subdomain}.${zoneName}`.toLowerCase();
  let apps;
  try {
    apps = await listApplications();
  } catch (err) {
    throw new Error(
      `subdomain-collision guard: could not query Coolify to verify "${fqdn}" is free ` +
        `(${(err as Error).message}). Refusing (fail closed).`,
    );
  }
  for (const app of apps) {
    if (ourAppUuid && app.uuid === ourAppUuid) continue;
    if (hostsOf(app.fqdn).includes(fqdn)) {
      throw new Error(
        `subdomain-collision guard: "${fqdn}" already maps to a different Coolify app ` +
          `(${app.name || app.uuid}). Refusing to clobber it — choose another subdomain.`,
      );
    }
  }
}

/**
 * GUARD 2 — wrong-target. Every mutating Coolify call must target the app bound to THIS
 * project_dir (its COOLIFY_APP_UUID in deploy/.env.deploy). Refuse otherwise, so the
 * manager can never mutate another project's app on the shared server. Fails CLOSED on a
 * missing/empty recorded uuid.
 */
export function assertTargetsOurApp(projectDir: string, appUuid: string): void {
  const recorded = readEnvDeploy(projectDir).COOLIFY_APP_UUID;
  if (!recorded) {
    throw new Error(
      `wrong-target guard: deploy/.env.deploy has no COOLIFY_APP_UUID for ${projectDir}; ` +
        `cannot confirm a mutating call targets THIS project's app. Refusing.`,
    );
  }
  if (recorded !== appUuid) {
    throw new Error(
      `wrong-target guard: refusing to mutate app ${appUuid} — this project is bound to ${recorded}.`,
    );
  }
}

export interface HealthResult {
  healthy: boolean;
  detail: string;
}

/**
 * GUARD 3 — deploy-health. After a ship, wait for the Coolify deployment to settle, then
 * probe the live URL for a serving response (2xx/3xx — a redirect still means it's up).
 * The crash-guard analog: a deploy that "succeeded" but serves a broken app is caught
 * here. Never throws on unhealthy (the caller records it + pulls logs); only reports.
 */
export async function assertHealthy(
  appUuid: string,
  url: string,
  healthPath: string,
): Promise<HealthResult> {
  // Phase A — wait out the Coolify deployment queue (bounded).
  const statusDeadline = Date.now() + 5 * 60_000;
  let status = "none";
  while (Date.now() < statusDeadline) {
    try {
      status = await getDeploymentStatus(appUuid);
    } catch (err) {
      return { healthy: false, detail: `deploy-health guard: status query failed: ${(err as Error).message}` };
    }
    if (status === "finished" || status === "failed") break;
    await sleep(5000);
  }
  if (status === "failed") {
    return { healthy: false, detail: "deploy-health guard: Coolify reported the deployment FAILED." };
  }
  if (status !== "finished") {
    return { healthy: false, detail: `deploy-health guard: deployment did not finish in time (last status "${status}").` };
  }

  // Phase B — probe the public URL. First deploy also waits on DNS propagation + the
  // Cloudflare edge cert, so allow a warmup window before declaring it unhealthy.
  const target = url.replace(/\/+$/, "") + (healthPath.startsWith("/") ? healthPath : `/${healthPath}`);
  const probeDeadline = Date.now() + 3 * 60_000;
  let last = "no response";
  while (Date.now() < probeDeadline) {
    try {
      const res = await fetch(target, { redirect: "manual" });
      if (res.status >= 200 && res.status < 400) {
        return { healthy: true, detail: `deploy-health guard: ${target} -> HTTP ${res.status}.` };
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(5000);
  }
  return { healthy: false, detail: `deploy-health guard: ${target} never returned 2xx/3xx (last: ${last}).` };
}
