// The project agent's handoff helper: discover a running manager via the portfile it
// publishes (<stateDir>/endpoint.json) and POST a deploy. Synchronous RPC — the POST
// blocks until the deploy completes and returns the structured DeployResult, so the
// caller needs no server of its own. (For the spawn-on-demand path, see pi-deploy.sh.)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getPort, getStateDir, getToken } from "../shared/config.ts";
import type { DeployRequest, DeployResult } from "../shared/types.ts";

interface Endpoint {
  port: number;
  token: string;
  pid?: number;
}

function readEndpoint(stateDir?: string): Endpoint | null {
  const file = join(stateDir ?? getStateDir(), "endpoint.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Endpoint;
  } catch {
    return null;
  }
}

/** True if a manager has published an endpoint (it is up, or recently was). */
export function isManagerUp(stateDir?: string): boolean {
  return readEndpoint(stateDir) != null;
}

/**
 * Hand a deploy to the manager and await its structured result. Resolves the endpoint
 * from the portfile (falling back to config's port/token), POSTs, and returns the
 * DeployResult. Rejects on transport failure; a deploy that FAILED still resolves with
 * `{status:"failed", ...}` (a result, not a throw).
 */
export async function deploy(
  req: DeployRequest,
  opts: { stateDir?: string; token?: string; timeoutMs?: number } = {},
): Promise<DeployResult> {
  const ep = readEndpoint(opts.stateDir);
  const port = ep?.port ?? getPort();
  const token = opts.token ?? ep?.token ?? getToken();
  const body = JSON.stringify({
    type: "deploy",
    from: "client",
    ts: Date.now(),
    requestId: `client-${process.pid}-${Date.now()}`,
    ...req,
  });
  const res = await fetch(`http://127.0.0.1:${port}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pideploy-token": token },
    body,
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  if (!res.ok) throw new Error(`pi-deployment-manager returned HTTP ${res.status}`);
  const json = (await res.json()) as { result?: DeployResult };
  if (!json.result) throw new Error("pi-deployment-manager response missing `result`");
  return json.result;
}
