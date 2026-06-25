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

export interface DeployProfile {
  id: string;
  /** Read-only inspection of project_dir (via shared/sandbox + node fs — never bash). */
  detect(projectDir: string): Promise<boolean>;
  dockerfile(projectDir: string): Promise<DockerfileOutput>;
  /** The EXPOSE port — MUST match the generated Dockerfile (provision infers from it). */
  port: number;
  /** What the deploy-health guard polls ("/healthz" for served apps, "/" for bare static). */
  healthPath: string;
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
