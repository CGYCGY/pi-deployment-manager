/**
 * shared/transport.ts — the localhost HTTP backbone (reused from pi-4b-tester).
 *
 * The manager runs one node:http server bound to 127.0.0.1 on rpc.port; a project
 * agent (client) POSTs a JSON DeployMessage to it. Every request carries the shared
 * token in the `x-pideploy-token` header, checked on receipt. Mismatched/absent
 * token => 401.
 *
 * v1 RPC is synchronous: the client's POST blocks until the deploy finishes and the
 * manager returns a DeployResultMessage as the 200 body (a deploy runs to completion
 * and returns, per DESIGN §2). A deploy can take minutes, so the server's request
 * timeouts must be disabled by the caller (see manager/index.ts).
 *
 * PORT AUTO-FALLBACK: createTransportServer takes a PREFERRED port and, if it is
 * occupied (EADDRINUSE), transparently retries the next port up to a small bound.
 * The handle exposes the RESOLVED port (`.port`).
 *
 * Uses only node: built-ins + shared/{types,config}. No pi runtime dependency.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { getPort, getToken } from "./config.ts";
import type { DeployMessage, TransportMessage } from "./types.ts";

/**
 * Constant-time token check. Hashing both sides to a fixed 32-byte digest keeps
 * timingSafeEqual from throwing on length mismatch AND stops the token length
 * itself from leaking via early return / compare time. Gates a primitive that can
 * mutate live infra, so the compare must not be an `!==` oracle.
 */
export function tokenMatches(provided: string | undefined, token: string): boolean {
  if (provided === undefined) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** HTTP header that carries the shared token. */
export const TOKEN_HEADER = "x-pideploy-token";

/** Path all transport POSTs target. */
export const TRANSPORT_PATH = "/deploy";

/** How many consecutive ports to try (preferred, +1, +2, …) before giving up. */
export const PORT_FALLBACK_TRIES = 20;

/**
 * Per-message-type handler map. Each handler receives the narrowed message and may
 * optionally return a JSON-serializable value sent back as the 200 body. Unhandled
 * types fall through to onUnhandled (or a 200 ack).
 */
export interface TransportHandlers {
  deploy?: (msg: DeployMessage) => unknown | Promise<unknown>;
  /** Called for any type without a specific handler. */
  onUnhandled?: (msg: TransportMessage) => unknown | Promise<unknown>;
  /** Called on parse/dispatch errors (logging hook). Does not affect the response. */
  onError?: (err: Error, raw: string) => void;
}

/** Options for createTransportServer. */
export interface TransportServerOptions {
  /** PREFERRED port to bind (127.0.0.1). Auto-falls-back to the next free port. */
  port: number;
  /** Shared token to validate. Defaults to config token. */
  token?: string;
  handlers: TransportHandlers;
  /** Bind host. Defaults to 127.0.0.1. */
  host?: string;
  /**
   * Max consecutive ports to try on EADDRINUSE (preferred, +1, …). Defaults to
   * PORT_FALLBACK_TRIES. Set to 1 to disable fallback (fail if the port is busy).
   */
  fallbackTries?: number;
}

/** A running transport server handle. */
export interface TransportServer {
  /** The underlying node http.Server (exposed so the caller can tune timeouts). */
  server: http.Server;
  /** The RESOLVED bound port (may differ from the preferred port after fallback). */
  port: number;
  close: () => Promise<void>;
}

/** Read an entire request body as a UTF-8 string (bounded by node defaults). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

/** Send a JSON response with a status code. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? { ok: true });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Dispatch a parsed message to the matching handler. */
async function dispatch(msg: TransportMessage, handlers: TransportHandlers): Promise<unknown> {
  switch (msg.type) {
    case "deploy":
      return handlers.deploy?.(msg) ?? handlers.onUnhandled?.(msg);
    default:
      // Exhaustiveness guard: a new message type without a case still forwards to
      // onUnhandled rather than throwing.
      return handlers.onUnhandled?.(msg as TransportMessage);
  }
}

/** Try to listen on one specific port; resolve true on success, false on EADDRINUSE. */
function tryListen(server: http.Server, port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolveTry, rejectTry) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        resolveTry(false); // occupied — caller advances to the next port
      } else {
        rejectTry(err); // a real error (permissions, etc.) — surface it
      }
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveTry(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Start a transport server on the PREFERRED port, auto-falling-back to the next
 * free port (preferred, +1, +2, …, up to fallbackTries) if it is occupied.
 * Validates the token header, parses the JSON body, and dispatches by message.type.
 * Returns a handle whose `.port` is the RESOLVED bound port.
 */
export async function createTransportServer(
  opts: TransportServerOptions,
): Promise<TransportServer> {
  const token = opts.token ?? getToken();
  const host = opts.host ?? "127.0.0.1";
  const tries = Math.max(1, opts.fallbackTries ?? PORT_FALLBACK_TRIES);

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== "POST" || req.url !== TRANSPORT_PATH) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const got = req.headers[TOKEN_HEADER];
        const provided = Array.isArray(got) ? got[0] : got;
        if (!tokenMatches(provided, token)) {
          sendJson(res, 401, { error: "bad token" });
          return;
        }
        const raw = await readBody(req);
        let msg: TransportMessage;
        try {
          msg = JSON.parse(raw) as TransportMessage;
        } catch (err) {
          opts.handlers.onError?.(err as Error, raw);
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const result = await dispatch(msg, opts.handlers);
        sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        opts.handlers.onError?.(err as Error, "");
        sendJson(res, 500, { error: (err as Error).message });
      }
    })();
  });

  let bound = false;
  let lastPort = opts.port;
  for (let i = 0; i < tries; i++) {
    lastPort = opts.port + i;
    // eslint-disable-next-line no-await-in-loop
    if (await tryListen(server, lastPort, host)) {
      bound = true;
      break;
    }
  }
  if (!bound) {
    throw new Error(
      `transport: no free port in [${opts.port}, ${opts.port + tries - 1}] on ${host}`,
    );
  }

  const addr = server.address() as AddressInfo | null;
  const boundPort = addr ? addr.port : lastPort;
  return {
    server,
    port: boundPort,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

/** Result of a client post. */
export interface PostResult {
  status: number;
  body: unknown;
  ok: boolean;
}

/** Options for the post client. */
export interface PostOptions {
  token?: string;
  host?: string;
  /** Request timeout in ms. Defaults to 5000 — a deploy client MUST raise this. */
  timeoutMs?: number;
}

/**
 * POST a TransportMessage to a target port over the localhost transport.
 * Resolves with the response; rejects on network error or timeout.
 */
export function post(
  targetPort: number,
  message: TransportMessage,
  options: PostOptions = {},
): Promise<PostResult> {
  const token = options.token ?? getToken();
  const host = options.host ?? "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? 5000;
  const payload = JSON.stringify(message);

  return new Promise<PostResult>((resolvePost, rejectPost) => {
    const req = http.request(
      {
        host,
        port: targetPort,
        path: TRANSPORT_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          [TOKEN_HEADER]: token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          const status = res.statusCode ?? 0;
          resolvePost({ status, body, ok: status >= 200 && status < 300 });
        });
      },
    );
    req.on("error", rejectPost);
    req.on("timeout", () => {
      req.destroy(new Error(`post to ${host}:${targetPort} timed out after ${timeoutMs}ms`));
    });
    req.write(payload);
    req.end();
  });
}

/** Convenience: POST a message to the manager (port from config). */
export function postToManager(
  message: TransportMessage,
  options: PostOptions = {},
): Promise<PostResult> {
  return post(getPort(), message, options);
}
