// sqlite-volume — a server app that keeps a SQLite file on disk. Without a persistent
// Coolify volume that file is in the container's ephemeral layer and is wiped on every
// redeploy; this addon flags that a volume must be mounted at the db's directory.
//
// volumeSpec carries a generic name; phase-4 code prefixes the Coolify app slug so the
// name is unique on the shared box (volume names are global to a Coolify server).

import type { BackendAddon } from "../types.ts";
import { existsFirst, hasAnyDep, hasDep, readPackageJson } from "../util.ts";

const SQLITE_DEPS = ["better-sqlite3", "sqlite3", "@libsql/client", "libsql"];
// Server frameworks (or just `next`, which runs a node server) — sqlite-on-disk only
// matters when something long-running owns the file, not for a pure static build.
const SERVER_DEPS = ["next", "express", "fastify", "hono", "@hono/node-server", "koa", "@nestjs/core"];
const COMMITTED_DB_FILES = ["data.db", "db.sqlite", "sqlite.db", "database.sqlite", "dev.db"];

export const sqliteVolume: BackendAddon = {
  id: "sqlite-volume",
  // A set volumeSpec IS the "needs a persistent volume" signal phase-4 keys off.
  volumeSpec: "sqlite-data:/app/data",
  async detect(projectDir) {
    const pkg = readPackageJson(projectDir);
    const serverLike = hasAnyDep(pkg, SERVER_DEPS) || Boolean(pkg?.scripts?.start);
    const sqliteSignal = hasAnyDep(pkg, SQLITE_DEPS) || existsFirst(projectDir, COMMITTED_DB_FILES);
    return serverLike && sqliteSignal;
  },
};
