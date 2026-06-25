/**
 * shared/log.ts — simple append-only file logger.
 *
 * The manager writes timestamped lines to <stateDir>/logs/<role>.log. Use
 * createLogger(role) once and call .info/.warn/.error/.debug. An optional console
 * echo is provided for foreground debugging (off by default — pi owns the TUI).
 *
 * Uses only node: built-ins + shared/config. No pi runtime dependency.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { getStateDir } from "./config.ts";
import type { Role } from "./types.ts";

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A bound logger for one role. */
export interface Logger {
  path: string;
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  log: (level: LogLevel, message: string, data?: unknown) => void;
}

/** ISO-8601 timestamp for a log line. */
function stamp(): string {
  return new Date().toISOString();
}

/** Serialize optional structured data compactly; never throws. */
function fmtData(data: unknown): string {
  if (data === undefined) return "";
  try {
    return " " + JSON.stringify(data);
  } catch {
    return " " + String(data);
  }
}

/** Path to a role's log file. */
export function getLogPath(role: Role): string {
  return join(getStateDir(), "logs", `${role}.log`);
}

/**
 * Create a file logger for a role. Writes are synchronous appends (small,
 * infrequent lines), so they are safe to call from timers and handlers.
 *
 * @param opts.echo  if true, also echo to console.error (stderr) — use only
 *                   when not inside the pi TUI (e.g. a standalone script).
 */
export function createLogger(role: Role, opts: { echo?: boolean } = {}): Logger {
  const path = getLogPath(role);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const echo = opts.echo ?? false;

  const write = (level: LogLevel, message: string, data?: unknown): void => {
    const line = `${stamp()} [${role}] ${level.toUpperCase()} ${message}${fmtData(data)}\n`;
    try {
      appendFileSync(path, line, "utf8");
    } catch {
      // Logging must never crash the caller; swallow write failures.
    }
    if (echo) {
      // eslint-disable-next-line no-console
      console.error(line.trimEnd());
    }
  };

  return {
    path,
    log: write,
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
  };
}
