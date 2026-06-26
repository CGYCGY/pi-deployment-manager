// dockerfile — the generic "bring-your-own-Dockerfile" profile (DESIGN §6). The fallback
// for any project that ships its own working Dockerfile (a Bun/Hono, Go, Python, Rust, …
// server), resolved only after every framework profile declines. Unlike the frontend
// profiles, this one GENERATES NOTHING: it honors the project's own Dockerfile and reads
// the port/volume/health the project already declares (EXPOSE / VOLUME / HEALTHCHECK), so
// the deploy stays completely language-blind. Per-language *generator* profiles (for repos
// that ship no Dockerfile) are a future addition layered on top of this floor.

import type { DeployProfile, DockerfileOutput, ProfileInspection } from "./types.ts";
import { parseDockerfile, readProjectDockerfile } from "./util.ts";

export const dockerfileProfile: DeployProfile = {
  id: "dockerfile",
  // Fallbacks only — the real values come from the project's Dockerfile via inspect().
  port: 3000,
  healthPath: "/",
  buildHints:
    "Uses the project's OWN Dockerfile (./Dockerfile, else ./deploy/Dockerfile) verbatim — the " +
    "manager generates nothing. The image must EXPOSE its port; a VOLUME line is honored as a " +
    "persistent Coolify volume, and a HEALTHCHECK URL path becomes the deploy-health probe.",
  async detect(projectDir) {
    return readProjectDockerfile(projectDir) != null;
  },
  async dockerfile(projectDir): Promise<DockerfileOutput> {
    const text = readProjectDockerfile(projectDir);
    if (!text) {
      throw new Error(
        "dockerfile profile: no Dockerfile found (looked at ./Dockerfile and ./deploy/Dockerfile).",
      );
    }
    return { dockerfile: text };
  },
  async inspect(projectDir): Promise<ProfileInspection> {
    const text = readProjectDockerfile(projectDir);
    if (!text) return {};
    const m = parseDockerfile(text);
    const out: ProfileInspection = {};
    if (m.expose) out.port = m.expose;
    if (m.healthPath) out.healthPath = m.healthPath;
    if (m.volumeMount) {
      // Bare spec "name:/mount"; provision prefixes the subdomain (volume names are global
      // on the shared Coolify box). Name = last path segment ("/data" -> "data").
      const name = m.volumeMount.split("/").filter(Boolean).pop() ?? "data";
      out.volumeSpec = `${name}:${m.volumeMount}`;
    }
    return out;
  },
};
