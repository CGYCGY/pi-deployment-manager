// The 10 deployment verbs registered as pi tools — the COMPLETE tool surface the
// manager LLM sees. Built-in tools are gated off (--no-builtin-tools + setActiveTools),
// so these verbs are the only things representable. read ≠ write: detect/status/logs
// never mutate infra.
//
// Each verb operates on the CURRENT deploy context (project_dir / subdomain / ledger /
// scratch) the door set — that is why most take no params: the target is not the LLM's
// to choose, it is bound by the RPC payload. The verbs' CODE drives the skill scripts
// (via the engine modules); the LLM never reaches the underlying bash. Verbs MUTATE the
// ledger (the door builds the client result from it); they never return prose to parse.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ASSETS_DIR, getCloudflare, getConvex, getRegistry } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import { assertWritable, safeDeployPath } from "../shared/sandbox.ts";
import type { CurrentDeploy } from "../shared/types.ts";

import { createRecord } from "./cloudflare.ts";
import {
  createApp,
  findOrCreateProject,
  getAppLogs,
  getApplication,
  getDeploymentStatus,
  getServerIp,
  setEnvs,
  updateAppDomain,
} from "./coolify.ts";
import { ensureGitignored, readEnvDeploy, writeEnvDeploy } from "./envdeploy.ts";
import { assertHealthy, assertSubdomainFree, assertTargetsOurApp } from "./guards.ts";
import { detectAddons, detectProfile, getProfile } from "./profiles/index.ts";
import { runCommand } from "./subprocess.ts";

export interface ManagerToolDeps {
  roleLog: Logger;
  /** The live deploy context the door set; null between deploys. Verbs read it + write its ledger. */
  getCurrentDeploy: () => CurrentDeploy | null;
  setActiveCtx: (ctx: ExtensionContext) => void;
}

/** The complete verb set, in flow order. Passed to pi.setActiveTools as the gate's allowlist. */
export const VERB_NAMES = [
  "detect",
  "scaffold",
  "convex",
  "provision",
  "env",
  "dns",
  "deploy",
  "redeploy",
  "status",
  "logs",
] as const;

/** Ship timeout for deploy.sh (docker build + push can be slow); under the door's 20-min cap. */
const SHIP_TIMEOUT_MS = 15 * 60_000;

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

/** Lowercase repo slug (GHCR + git remotes are lowercase; Coolify app name uses the subdomain). */
function repoSlug(projectDir: string): string {
  return basename(projectDir).toLowerCase();
}

export function registerManagerTools(pi: ExtensionAPI, deps: ManagerToolDeps): void {
  const { roleLog, getCurrentDeploy, setActiveCtx } = deps;

  const need = (verb: string): CurrentDeploy => {
    const d = getCurrentDeploy();
    if (!d) throw new Error(`${verb}: no active deploy — the door binds the context per request.`);
    return d;
  };

  /** The Coolify app uuid bound to this deploy: from the ledger, else deploy/.env.deploy. */
  const appUuidFor = (d: CurrentDeploy): string | undefined => {
    if (d.ledger.app_uuid) return d.ledger.app_uuid;
    return readEnvDeploy(d.project_dir).COOLIFY_APP_UUID || undefined;
  };

  pi.registerTool({
    name: "detect",
    label: "Detect (read)",
    description:
      "Inspect the target project (read-only) to select its frontend DeployProfile " +
      "(static-html | react-spa | astro-static | nextjs-node | nextjs-static) and any " +
      "backend addons (convex-cloud | sqlite-volume). Read-only — never mutates the repo " +
      "or infra. START every deploy here.",
    promptSnippet: "Inspect the project and pick its deploy profile + backend addons (read-only).",
    promptGuidelines: ["Always call detect first — every later verb depends on the chosen profile."],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("detect");
      const profile = await detectProfile(d.project_dir);
      const addons = await detectAddons(d.project_dir);
      d.ledger.profile = profile.id;
      d.ledger.addons = addons.map((a) => a.id);

      // Idempotency is decided LIVE against Coolify (locked): deploy/.env.deploy is only a
      // hint — Coolify is authoritative. App recorded AND confirmed present ⇒ update path.
      let flow: "initial" | "update" = "initial";
      const recorded = readEnvDeploy(d.project_dir).COOLIFY_APP_UUID;
      if (recorded && (await getApplication(recorded))) {
        flow = "update";
        d.ledger.app_uuid = recorded;
        d.scratch.appUuid = recorded;
      }
      d.scratch.flow = flow;
      d.ledger.phase = "detected";

      const addonStr = addons.length ? addons.map((a) => a.id).join(", ") : "(none)";
      const hint = profile.buildHints ? `\nBuild note: ${profile.buildHints}` : "";
      const plan =
        flow === "initial"
          ? "INITIAL flow: scaffold -> [convex if present] -> provision -> env -> dns -> deploy, then status."
          : "UPDATE flow: [convex if the backend changed] -> redeploy, then status.";
      return ok(
        `Detected ${profile.id} (port ${profile.port}, health ${profile.healthPath}); addons: ${addonStr}. ` +
          `Flow: ${flow.toUpperCase()}.${hint}\n${plan}`,
        { profile: profile.id, addons: d.ledger.addons, flow, port: profile.port, healthPath: profile.healthPath },
      );
    },
  });

  pi.registerTool({
    name: "scaffold",
    label: "Scaffold (write)",
    description:
      "Generate the project's deploy/ files from the detected profile: deploy/Dockerfile " +
      "(+ nginx conf, /healthz, HEALTHCHECK), deploy/deploy.sh, deploy/.env.deploy. Writes " +
      "ONLY under deploy/ (and .gitignore). Initial deploy only.",
    promptSnippet: "Generate the project's deploy/ files (Dockerfile, deploy.sh, .env.deploy) from the profile.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("scaffold");
      if (!d.ledger.profile) throw new Error("scaffold: call detect first to choose a profile.");
      const profile = getProfile(d.ledger.profile);
      const out = await profile.dockerfile(d.project_dir);

      const written: string[] = [];
      const dockerfilePath = safeDeployPath(d.project_dir, "Dockerfile");
      mkdirSync(dirname(dockerfilePath), { recursive: true });
      writeFileSync(dockerfilePath, out.dockerfile, "utf8");
      written.push("deploy/Dockerfile");
      for (const [rel, content] of Object.entries(out.files ?? {})) {
        const p = assertWritable(d.project_dir, join("deploy", rel));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content, "utf8");
        written.push(`deploy/${rel}`);
      }

      // deploy.sh (bundled asset) is the one real build step: docker build -> GHCR push ->
      // Coolify webhook. Copy it in so the project owns its deploy command.
      const deployShDst = assertWritable(d.project_dir, "deploy/deploy.sh");
      copyFileSync(join(ASSETS_DIR, "deploy.sh"), deployShDst);
      chmodSync(deployShDst, 0o755);
      written.push("deploy/deploy.sh");

      writeEnvDeploy(d.project_dir, { repoName: repoSlug(d.project_dir), subdomain: d.subdomain });
      ensureGitignored(d.project_dir);
      written.push("deploy/.env.deploy (gitignored)");

      d.ledger.phase = "scaffolded";
      return ok(`Scaffolded ${written.join(", ")} for ${profile.id}.`, { written, profile: profile.id });
    },
  });

  pi.registerTool({
    name: "convex",
    label: "Convex deploy (write)",
    description:
      "For a convex-cloud project: run `convex deploy` against Convex Cloud and capture the " +
      "prod deployment URL, so it can be injected as a BUILD-TIME env into the frontend image. " +
      "Runs BEFORE the frontend build (backend-first).",
    promptSnippet: "Deploy the Convex Cloud backend and capture its prod URL (run before the frontend build).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("convex");
      const addons = await detectAddons(d.project_dir);
      const convex = addons.find((a) => a.id === "convex-cloud");
      if (!convex) {
        return ok("convex: no convex-cloud addon detected; nothing to deploy.", { skipped: true });
      }

      const r = await runCommand("npx", ["convex", "deploy", "-y"], {
        cwd: d.project_dir,
        env: { CONVEX_DEPLOY_KEY: getConvex().deploy_key },
      });
      if (r.code !== 0) {
        throw new Error(`convex deploy failed (exit ${r.code ?? "killed"}): ${(r.stderr.trim() || r.stdout.trim()).slice(-500)}`);
      }
      const m = `${r.stdout}\n${r.stderr}`.match(/https?:\/\/[a-z0-9-]+\.convex\.(?:cloud|site)/i);
      if (!m) throw new Error(`convex deploy: prod URL not found in output. Tail: ${`${r.stdout}\n${r.stderr}`.slice(-400)}`);
      const convexUrl = m[0];

      // Build-time injection: the frontend bundler inlines this var at build, so write it
      // into .env.production (sandbox-allowed) BEFORE the image build. Name is per-bundler.
      const envVar = convex.buildEnvVar?.(d.ledger.profile ?? "") ?? "CONVEX_URL";
      const prodPath = assertWritable(d.project_dir, ".env.production");
      const prev = existsSync(prodPath) ? readFileSync(prodPath, "utf8") : "";
      const re = new RegExp(`^${envVar}=.*$`, "m");
      const line = `${envVar}=${convexUrl}`;
      const next = re.test(prev) ? prev.replace(re, line) : `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}${line}\n`;
      writeFileSync(prodPath, next, "utf8");

      d.scratch.convexUrl = convexUrl;
      d.scratch.convexEnvVar = envVar;
      d.ledger.phase = "convex-deployed";
      return ok(`Convex Cloud deployed; ${envVar} written to .env.production for build-time inject.`, {
        convexUrl,
        envVar,
      });
    },
  });

  pi.registerTool({
    name: "provision",
    label: "Provision Coolify app (write)",
    description:
      "Create the Coolify app for this project (image = <ghcr>/<org>/<repo>), inferring the " +
      "exposed port from the Dockerfile and setting resource limits. Initial deploy only — " +
      "guarded so it can only target THIS project's subdomain.",
    promptSnippet: "Create the Coolify app for this project (initial deploy only).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("provision");
      if (!d.ledger.profile) throw new Error("provision: call detect first.");
      const profile = getProfile(d.ledger.profile);
      const reg = getRegistry();
      const cf = getCloudflare();

      try {
        await assertSubdomainFree(d.subdomain, cf.zone_name);
      } catch (err) {
        d.ledger.error = (err as Error).message;
        throw err;
      }

      const repoName = repoSlug(d.project_dir);
      const projectName = `pi-${reg.github_org}`.toLowerCase();
      const projectUuid = await findOrCreateProject(projectName);
      const image = `${reg.ghcr}/${reg.github_org}/${repoName}`.toLowerCase();

      const addons = await detectAddons(d.project_dir);
      const sqlite = addons.find((a) => a.id === "sqlite-volume");
      // Volume names are global on the shared Coolify box — prefix the subdomain to keep
      // each project's volume distinct.
      const persistentStorages = sqlite?.volumeSpec ? `${d.subdomain}-${sqlite.volumeSpec}` : undefined;

      const { uuid: appUuid, webhookUrl } = await createApp({
        projectUuid,
        name: d.subdomain,
        image,
        exposedPort: profile.port,
        persistentStorages,
        instantDeploy: false, // image not pushed yet — deploy ships it.
      });
      // Persist the new app uuid + deploy webhook into deploy/.env.deploy so deploy.sh can
      // trigger the deployment (it sources COOLIFY_WEBHOOK_URL from there).
      writeEnvDeploy(d.project_dir, { repoName, subdomain: d.subdomain, appUuid, webhookUrl });

      d.ledger.app_uuid = appUuid;
      d.scratch.appUuid = appUuid;
      d.scratch.image = image;
      d.ledger.phase = "provisioned";
      return ok(
        `Provisioned Coolify app "${d.subdomain}" (uuid ${appUuid}) under ${projectName}, image ${image}, ` +
          `port ${profile.port}${persistentStorages ? `, volume ${persistentStorages}` : ""}.`,
        { app_uuid: appUuid, image },
      );
    },
  });

  pi.registerTool({
    name: "env",
    label: "Set app env (write)",
    description:
      "Set environment variables on the Coolify app — including the captured Convex prod URL and " +
      "any extra vars the caller passed. Targets only THIS project's app.",
    promptSnippet: "Set environment variables on this project's Coolify app.",
    parameters: Type.Object({
      vars: Type.Optional(
        Type.Array(
          Type.Object({
            key: Type.String({ description: "Env var name." }),
            value: Type.String({ description: "Env var value." }),
          }),
          { description: "Extra vars to set, beyond those derived from the deploy context." },
        ),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("env");
      const appUuid = appUuidFor(d);
      if (!appUuid) throw new Error("env: no provisioned app yet (run provision first).");
      assertTargetsOurApp(d.project_dir, appUuid);

      const pairs: Array<[string, string]> = [];
      for (const v of (params as { vars?: Array<{ key: string; value: string }> }).vars ?? []) {
        pairs.push([v.key, v.value]);
      }
      for (const [k, v] of Object.entries(d.env ?? {})) pairs.push([k, v]);
      if (d.scratch.convexUrl && d.scratch.convexEnvVar) {
        pairs.push([d.scratch.convexEnvVar, d.scratch.convexUrl]);
      }
      if (!pairs.length) return ok("env: nothing to set (no caller vars, no Convex URL).", { set: 0 });

      // Coolify's bulk endpoint REPLACES the app's env set (initial-flow step). Sent over
      // the API directly — caller secrets never touch disk.
      await setEnvs(appUuid, pairs);
      d.ledger.phase = "env-set";
      return ok(`Set ${pairs.length} env var(s) on app ${appUuid}: ${pairs.map(([k]) => k).join(", ")}.`, {
        keys: pairs.map(([k]) => k),
      });
    },
  });

  pi.registerTool({
    name: "dns",
    label: "DNS + domain (write)",
    description:
      "Create/update the Cloudflare record for THIS project's caller-specified subdomain on the " +
      "one managed zone, and set the matching domain on the Coolify app. Subdomain-collision " +
      "guarded: refuses if the subdomain already maps to a different project.",
    promptSnippet: "Point the caller's subdomain at this app (Cloudflare record + Coolify domain).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("dns");
      const appUuid = appUuidFor(d);
      if (!appUuid) throw new Error("dns: no provisioned app yet (run provision first).");
      const cf = getCloudflare();
      const fqdn = `${d.subdomain}.${cf.zone_name}`;
      const url = `https://${fqdn}`;

      try {
        await assertSubdomainFree(d.subdomain, cf.zone_name, appUuid); // ours is allowed
      } catch (err) {
        d.ledger.error = (err as Error).message;
        throw err;
      }
      assertTargetsOurApp(d.project_dir, appUuid);

      const ip = await getServerIp();
      await createRecord("A", fqdn, ip, "true"); // proxied through Cloudflare
      await updateAppDomain(appUuid, url);
      writeEnvDeploy(d.project_dir, { domain: fqdn, subdomain: d.subdomain });

      d.ledger.url = url;
      d.ledger.phase = "dns-set";
      return ok(`DNS: ${fqdn} -> ${ip} (proxied); Coolify app domain set to ${url}.`, { url, fqdn, ip });
    },
  });

  pi.registerTool({
    name: "deploy",
    label: "Deploy (write)",
    description:
      "Ship: build the Docker image, push it to GHCR, and trigger the Coolify deployment " +
      "(runs deploy/deploy.sh). Use for the initial deploy after provision/dns are done.",
    promptSnippet: "Build the image, push to GHCR, and trigger the Coolify deploy.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("deploy");
      const appUuid = appUuidFor(d);
      if (!appUuid) throw new Error("deploy: no provisioned app yet (run provision first).");
      const reg = getRegistry();
      const slug = `${reg.github_org}/${repoSlug(d.project_dir)}`;

      // Best-effort: ensure the GitHub repo exists as the GHCR image namespace. Non-fatal —
      // a GHCR push can create the package on its own, and gh may be unavailable.
      const view = await runCommand("gh", ["repo", "view", slug], { cwd: d.project_dir });
      if (view.code !== 0) {
        const create = await runCommand("gh", ["repo", "create", slug, "--private"], { cwd: d.project_dir });
        if (create.code !== 0) {
          roleLog.warn("deploy: gh repo create failed (continuing; GHCR push may still work)", {
            slug,
            stderr: create.stderr.trim().slice(0, 200),
          });
        }
      }

      const ship = await runCommand("bash", ["deploy/deploy.sh"], { cwd: d.project_dir, timeoutMs: SHIP_TIMEOUT_MS });
      if (ship.code !== 0) {
        d.ledger.logs_tail = (ship.stderr.trim() || ship.stdout.trim()).slice(-2000);
        d.ledger.phase = "ship-failed";
        throw new Error(`deploy: deploy.sh failed (exit ${ship.code ?? "killed"}). See logs_tail.`);
      }

      const profile = d.ledger.profile ? getProfile(d.ledger.profile) : undefined;
      const url = d.ledger.url ?? `https://${d.subdomain}.${getCloudflare().zone_name}`;
      const health = await assertHealthy(appUuid, url, profile?.healthPath ?? "/");
      d.ledger.url = url;
      d.ledger.health = health.healthy ? "healthy" : "unhealthy";
      if (!health.healthy) d.ledger.logs_tail = await getAppLogs(appUuid).catch(() => "");

      // Stage (NOT commit) the deploy files — the project agent owns the commit. .env.deploy
      // is gitignored, so `git add deploy` skips the secrets.
      await runCommand("git", ["add", "deploy", ".gitignore"], { cwd: d.project_dir }).catch(() => undefined);

      d.ledger.phase = health.healthy ? "deployed" : "unhealthy";
      return ok(
        health.healthy
          ? `Deployed ${d.subdomain}: ${url} is healthy (${health.detail}). deploy/ files staged (not committed).`
          : `Deployed but UNHEALTHY: ${health.detail}. App logs captured.`,
        { url, health: d.ledger.health, detail: health.detail },
      );
    },
  });

  pi.registerTool({
    name: "redeploy",
    label: "Redeploy (write)",
    description:
      "Update path for an already-provisioned project: rebuild + push + re-trigger Coolify " +
      "(API-only, no re-provision). Use when the project is already set up and only its code " +
      "changed.",
    promptSnippet: "Rebuild and re-trigger the Coolify deploy for an already-set-up project.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("redeploy");
      const appUuid = appUuidFor(d);
      if (!appUuid) throw new Error("redeploy: project not set up (no COOLIFY_APP_UUID) — use the initial flow.");
      assertTargetsOurApp(d.project_dir, appUuid);

      const ship = await runCommand("bash", ["deploy/deploy.sh"], { cwd: d.project_dir, timeoutMs: SHIP_TIMEOUT_MS });
      if (ship.code !== 0) {
        d.ledger.logs_tail = (ship.stderr.trim() || ship.stdout.trim()).slice(-2000);
        d.ledger.phase = "ship-failed";
        throw new Error(`redeploy: deploy.sh failed (exit ${ship.code ?? "killed"}). See logs_tail.`);
      }

      const env = readEnvDeploy(d.project_dir);
      const profile = d.ledger.profile ? getProfile(d.ledger.profile) : undefined;
      const url = d.ledger.url ?? (env.DOMAIN ? `https://${env.DOMAIN}` : `https://${d.subdomain}.${getCloudflare().zone_name}`);
      const health = await assertHealthy(appUuid, url, profile?.healthPath ?? "/");
      d.ledger.url = url;
      d.ledger.health = health.healthy ? "healthy" : "unhealthy";
      if (!health.healthy) d.ledger.logs_tail = await getAppLogs(appUuid).catch(() => "");

      d.ledger.phase = health.healthy ? "redeployed" : "unhealthy";
      return ok(
        health.healthy ? `Redeployed ${url}; healthy (${health.detail}).` : `Redeployed but UNHEALTHY: ${health.detail}.`,
        { url, health: d.ledger.health, detail: health.detail },
      );
    },
  });

  pi.registerTool({
    name: "status",
    label: "Status (read)",
    description:
      "Read the current Coolify deployment status for this project (queued | in_progress | " +
      "finished | failed). Read-only — never mutates infra.",
    promptSnippet: "Read this project's Coolify deployment status (read-only).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("status");
      const appUuid = appUuidFor(d);
      if (!appUuid) throw new Error("status: no app for this project yet.");
      const status = await getDeploymentStatus(appUuid);
      return ok(`Coolify deployment status: ${status}.`, { status });
    },
  });

  pi.registerTool({
    name: "logs",
    label: "Logs (read)",
    description:
      "Tail this project's Coolify app logs (for diagnosing a failed or unhealthy deploy). " +
      "Read-only — never mutates infra.",
    promptSnippet: "Tail this project's Coolify app logs (read-only).",
    parameters: Type.Object({
      lines: Type.Optional(Type.Number({ description: "How many log lines to tail (default 100)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const d = need("logs");
      const appUuid = appUuidFor(d);
      if (!appUuid) throw new Error("logs: no app for this project yet.");
      const text = await getAppLogs(appUuid, (params as { lines?: number }).lines ?? 100);
      return ok(text || "(no logs returned / Coolify logging API unavailable)", {});
    },
  });
}
