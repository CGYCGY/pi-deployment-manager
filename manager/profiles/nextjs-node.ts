// nextjs-node — the DEFAULT Next.js profile: a long-running node server from Next's
// standalone output. Used for any Next app that is NOT a static export (App Router,
// API routes, SSR, middleware — the common case).

import type { DeployProfile, DockerfileOutput } from "./types.ts";
import { hasDep, nextOutputIsExport, readPackageJson } from "./util.ts";

// Built AND run with bun (the stack standard); Next's standalone server is plain JS that
// bun executes (`bun server.js`). mkdir -p public so the COPY never fails on a repo with
// no public/ dir. HOSTNAME=0.0.0.0 so the standalone server binds outside the container.
// SKIP_ENV_VALIDATION: a no-op unless the app uses @t3-oss/env — then it lets the build
// run without the server-only envs (Coolify injects those at runtime).
const DOCKERFILE = `FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV SKIP_ENV_VALIDATION=1
RUN bun run build
RUN mkdir -p public

FROM oven/bun:1-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \\
  CMD wget -qO- http://localhost:3000/ || exit 1
EXPOSE 3000
CMD ["bun", "server.js"]
`;

export const nextjsNode: DeployProfile = {
  id: "nextjs-node",
  port: 3000,
  healthPath: "/",
  resourceHint: { cpu: "1", memory: "512M" },
  buildHints:
    "Requires `output: 'standalone'` in next.config (the standalone build is what we " +
    "copy). If the project lacks it, the image build will fail — note it in the summary.",
  // Disambiguated by detectProfile; self-check stays consistent (Next, not a static export).
  async detect(projectDir) {
    return hasDep(readPackageJson(projectDir), "next") && !nextOutputIsExport(projectDir);
  },
  async dockerfile(): Promise<DockerfileOutput> {
    return { dockerfile: DOCKERFILE };
  },
};
