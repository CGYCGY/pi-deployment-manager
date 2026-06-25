// nextjs-node — the DEFAULT Next.js profile: a long-running node server from Next's
// standalone output. Used for any Next app that is NOT a static export (App Router,
// API routes, SSR, middleware — the common case).

import type { DeployProfile, DockerfileOutput } from "./types.ts";
import { hasDep, nextOutputIsExport, readPackageJson } from "./util.ts";

// `mkdir -p public` so the COPY never fails on a repo without a public/ dir.
// HOSTNAME=0.0.0.0 so the standalone server binds outside the container, not just lo.
const DOCKERFILE = `FROM node:alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build
RUN mkdir -p public

FROM node:alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \\
  CMD wget -qO- http://localhost:3000/ || exit 1
EXPOSE 3000
CMD ["node", "server.js"]
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
