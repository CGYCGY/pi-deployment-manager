// astro-static — a static Astro build (no SSR adapter). The Dockerfile is the exact
// asset astro-setup ships (bun build → nginx), reused verbatim so the manager stays in
// lockstep with that skill. Health is a port-open check (nc), NOT /healthz: this is
// stock nginx serving dist/ with no custom conf, so there's no app route to hit — a
// listening :80 is the right liveness signal, and healthPath "/" reflects that.

import type { DeployProfile, DockerfileOutput } from "./types.ts";
import { isAstroStatic, readPackageJson } from "./util.ts";

const DOCKERFILE = `FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \\
  CMD nc -z localhost 80
EXPOSE 80
`;

export const astroStatic: DeployProfile = {
  id: "astro-static",
  port: 80,
  healthPath: "/",
  resourceHint: { cpu: "0.5", memory: "256M" },
  buildHints:
    "Uses `bun install --frozen-lockfile` — the project must commit bun.lock. For an " +
    "SSR Astro app (an @astrojs/* adapter), this static profile does not apply.",
  async detect(projectDir) {
    return isAstroStatic(projectDir, readPackageJson(projectDir));
  },
  async dockerfile(): Promise<DockerfileOutput> {
    return { dockerfile: DOCKERFILE };
  },
};
