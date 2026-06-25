// react-spa — a client-only React build (Vite or CRA), served as static files by
// nginx with an SPA fallback (every unknown path → index.html, so client routing works).

import type { DeployProfile, DockerfileOutput } from "./types.ts";
import { hasDep, isAstroStatic, readPackageJson } from "./util.ts";

const NGINX_CONF = `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;

    location = /healthz { access_log off; return 200 "ok"; }
    location / { try_files $uri $uri/ /index.html; }
}
`;

// Built with bun (the stack standard — every project ships bun.lock, not package-lock).
// --frozen-lockfile keeps the install reproducible against the committed lockfile.
function dockerfile(outDir: string): string {
  return `FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:alpine
COPY --from=build /app/${outDir} /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \\
  CMD wget -qO- http://localhost/healthz || exit 1
EXPOSE 80
`;
}

export const reactSpa: DeployProfile = {
  id: "react-spa",
  port: 80,
  healthPath: "/healthz",
  resourceHint: { cpu: "0.5", memory: "256M" },
  async detect(projectDir) {
    const pkg = readPackageJson(projectDir);
    return (
      (hasDep(pkg, "vite") || hasDep(pkg, "react-scripts")) &&
      hasDep(pkg, "react") &&
      !hasDep(pkg, "next") &&
      !isAstroStatic(projectDir, pkg)
    );
  },
  async dockerfile(projectDir): Promise<DockerfileOutput> {
    // Vite emits dist/, Create-React-App emits build/.
    const pkg = readPackageJson(projectDir);
    const outDir = hasDep(pkg, "react-scripts") && !hasDep(pkg, "vite") ? "build" : "dist";
    return { dockerfile: dockerfile(outDir), files: { "nginx.conf": NGINX_CONF } };
  },
};
