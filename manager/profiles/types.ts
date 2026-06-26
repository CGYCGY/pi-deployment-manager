// The DeployProfile registry contract — the DeviceProfile analog (DESIGN §6).
//
// A project resolves to ONE frontend DeployProfile + zero or more BackendAddons,
// detected from the repo (read-only). The profile owns the per-framework Dockerfile
// so that knowledge lives in a pluggable file, never hardcoded in the verbs: adding a
// target framework = dropping one profile file and listing it in index.ts.

/**
 * A generated Dockerfile plus any sidecar files it COPYs. Keys in `files` are paths
 * RELATIVE TO deploy/ (e.g. "nginx.conf" → deploy/nginx.conf). The build context is
 * the project root, so a Dockerfile references them as `deploy/<key>`.
 */
export interface DockerfileOutput {
  dockerfile: string;
  files?: Record<string, string>;
}

/**
 * Per-project facts a profile resolves from the repo at detect time. The framework
 * profiles generate their own Dockerfile, so their port/health are static; the generic
 * `dockerfile` profile instead READS these from the project's own Dockerfile (EXPOSE /
 * VOLUME / HEALTHCHECK), so they must be resolved per-deploy, not baked into the singleton.
 */
export interface ProfileInspection {
  /** EXPOSE port — overrides the profile's static `port` for provision. */
  port?: number;
  /** Bare Coolify PERSISTENT_STORAGES spec ("name:/mount"); provision prefixes the subdomain. */
  volumeSpec?: string;
  /** Health-probe path (e.g. from a HEALTHCHECK) — overrides the profile's static `healthPath`. */
  healthPath?: string;
}

export interface DeployProfile {
  id: string;
  /** Read-only inspection of project_dir (via shared/sandbox + node fs — never bash). */
  detect(projectDir: string): Promise<boolean>;
  dockerfile(projectDir: string): Promise<DockerfileOutput>;
  /** The EXPOSE port — MUST match the generated Dockerfile (provision infers from it). */
  port: number;
  /** What the deploy-health guard polls ("/healthz" for served apps, "/" for bare static). */
  healthPath: string;
  /**
   * Optional: resolve per-project port/volume/health from the repo at detect time. The
   * detect verb stores the result in the deploy scratch; provision/deploy prefer it over
   * the static fields. Profiles that generate their own Dockerfile omit this.
   */
  inspect?(projectDir: string): Promise<ProfileInspection>;
  resourceHint?: { cpu?: string; memory?: string };
  needsVolume?: boolean;
  /** A non-obvious build precondition worth surfacing in the deploy summary. */
  buildHints?: string;
}

export interface BackendAddon {
  id: string;
  detect(projectDir: string): Promise<boolean>;
  /** convex-cloud: the build-time env var the captured prod URL is injected as, by frontend family. */
  buildEnvVar?(frontendId: string): string;
  /** sqlite-volume: the Coolify PERSISTENT_STORAGES spec ("name:/mount/path"). */
  volumeSpec?: string;
}
