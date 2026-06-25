// Native Cloudflare API client (HTTP only, no subprocess). The verb CODE calls these;
// the LLM never does. Authenticates from the manager's central config (token + the one
// managed zone id). The Cloudflare API wraps every response in {success, result, errors}.

import { getCloudflare } from "../shared/config.ts";

const API = "https://api.cloudflare.com/client/v4";

interface CfResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { total_pages?: number };
}

/** A Cloudflare API call; throws (with the API's own error messages) unless success=true. */
async function cfApi<T>(path: string, init?: RequestInit): Promise<CfResponse<T>> {
  const c = getCloudflare();
  const headers: Record<string, string> = { Authorization: `Bearer ${c.api_token}` };
  if (init?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers as object) } });
  const json = (await res.json().catch(() => ({}))) as CfResponse<T>;
  if (!res.ok || !json.success) {
    const errs = (json.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
    throw new Error(`Cloudflare API ${path} -> HTTP ${res.status}${errs ? `: ${errs}` : ""}`);
  }
  return json;
}

export async function findZoneId(domain: string): Promise<string> {
  const { result } = await cfApi<Array<{ id: string; name: string }>>(`/zones?name=${encodeURIComponent(domain)}`);
  if (result.length === 0) throw new Error(`findZoneId: no Cloudflare zone found for "${domain}".`);
  if (result.length > 1) {
    throw new Error(`findZoneId: multiple zones match "${domain}": ${result.map((z) => z.name).join(", ")}.`);
  }
  const id = result[0]?.id;
  if (!id) throw new Error(`findZoneId: Cloudflare returned no zone id for "${domain}".`);
  return id;
}

export async function getZoneName(): Promise<string> {
  const { zone_id } = getCloudflare();
  const { result } = await cfApi<{ name: string }>(`/zones/${zone_id}`);
  return result.name;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/** List DNS records on the managed zone, optionally filtered by type and/or name (paginated). */
export async function listRecords(type?: string, name?: string): Promise<DnsRecord[]> {
  const { zone_id } = getCloudflare();
  const out: DnsRecord[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({ per_page: "100", page: String(page) });
    if (type) params.set("type", type);
    if (name) params.set("name", name);
    const resp = await cfApi<Array<Record<string, unknown>>>(`/zones/${zone_id}/dns_records?${params}`);
    for (const r of resp.result) {
      out.push({
        id: String(r.id ?? ""),
        type: String(r.type ?? ""),
        name: String(r.name ?? ""),
        content: String(r.content ?? ""),
        proxied: r.proxied === true,
      });
    }
    const totalPages = resp.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return out;
}

/** Build the record body per type, mirroring the prior create-record.sh field handling. */
function recordBody(type: string, name: string, content: string, extra?: string): Record<string, unknown> {
  const base: Record<string, unknown> = { type, name, content, ttl: 1 };
  switch (type) {
    case "A":
    case "AAAA":
    case "CNAME":
      return { ...base, proxied: extra ? extra === "true" : true };
    case "MX":
      return { ...base, priority: extra ? Number(extra) : 10 };
    case "SRV": {
      const [weight, port, target] = content.split(/\s+/);
      return { ...base, data: { priority: extra ? Number(extra) : 0, weight: Number(weight), port: Number(port), target } };
    }
    case "CAA": {
      const [flags, tag, value] = content.split(/\s+/);
      return { ...base, data: { flags: Number(flags), tag, value } };
    }
    default: // TXT and anything else: bare base
      return base;
  }
}

/**
 * Create or update (idempotent upsert by type+name) a DNS record; returns the record id.
 * `proxiedOrPriority` is `proxied` (true/false) for A/AAAA/CNAME or `priority` for MX/SRV.
 */
export async function createRecord(
  type: string,
  name: string,
  content: string,
  proxiedOrPriority?: string,
): Promise<string> {
  const { zone_id } = getCloudflare();
  const valid = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"];
  if (!valid.includes(type)) throw new Error(`createRecord: unsupported record type "${type}".`);

  const body = JSON.stringify(recordBody(type, name, content, proxiedOrPriority));
  const existing = await cfApi<Array<{ id: string }>>(
    `/zones/${zone_id}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
  );
  const existingId = existing.result[0]?.id;

  const { result } = existingId
    ? await cfApi<{ id: string }>(`/zones/${zone_id}/dns_records/${existingId}`, { method: "PUT", body })
    : await cfApi<{ id: string }>(`/zones/${zone_id}/dns_records`, { method: "POST", body });
  return result.id;
}

export async function deleteRecord(id: string): Promise<void> {
  const { zone_id } = getCloudflare();
  await cfApi<{ id: string }>(`/zones/${zone_id}/dns_records/${id}`, { method: "DELETE" });
}
