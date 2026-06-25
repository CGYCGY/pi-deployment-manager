// nextjs-static — a Next.js app with `output: 'export'`, built to a static bundle
// (out/) and served by nginx. try_files probes the bare path, then the .html Next
// export emits, then a directory index, before 404 — and /healthz for the guard.

import type { DeployProfile, DockerfileOutput } from "./types.ts";
import { hasDep, nextOutputIsExport, readPackageJson } from "./util.ts";

const NGINX_CONF = `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;

    location = /healthz { access_log off; return 200 "ok"; }
    location / { try_files $uri $uri.html $uri/ =404; }
}
`;

// Built with bun (the stack standard); next build with output:'export' emits out/.
const DOCKERFILE = `FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:alpine
COPY --from=build /app/out /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \\
  CMD wget -qO- http://localhost/healthz || exit 1
EXPOSE 80
`;

export const nextjsStatic: DeployProfile = {
  id: "nextjs-static",
  port: 80,
  healthPath: "/healthz",
  resourceHint: { cpu: "0.5", memory: "256M" },
  buildHints: "Requires `output: 'export'` in next.config (it produces the out/ dir we serve).",
  async detect(projectDir) {
    return hasDep(readPackageJson(projectDir), "next") && nextOutputIsExport(projectDir);
  },
  async dockerfile(): Promise<DockerfileOutput> {
    return { dockerfile: DOCKERFILE, files: { "nginx.conf": NGINX_CONF } };
  },
};
