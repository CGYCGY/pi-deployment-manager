// static-html — a pre-built static site (bare index.html, no build step). Served by
// nginx with an explicit /healthz so the deploy-health guard has a cheap 200 to poll.

import type { DeployProfile } from "./types.ts";
import { exists, hasBuildScript, readPackageJson } from "./util.ts";

const NGINX_CONF = `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location = /healthz { access_log off; return 200 "ok"; }
    location / { try_files $uri $uri/ =404; }
}
`;

// COPY . brings the whole repo in; for a bare static site the root IS the docroot.
const DOCKERFILE = `FROM nginx:alpine
COPY . /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \\
  CMD wget -qO- http://localhost/healthz || exit 1
EXPOSE 80
`;

export const staticHtml: DeployProfile = {
  id: "static-html",
  port: 80,
  healthPath: "/healthz",
  resourceHint: { cpu: "0.25", memory: "128M" },
  // Last-resort match: a root index.html and nothing that builds it.
  async detect(projectDir) {
    return exists(projectDir, "index.html") && !hasBuildScript(readPackageJson(projectDir));
  },
  async dockerfile() {
    return { dockerfile: DOCKERFILE, files: { "nginx.conf": NGINX_CONF } };
  },
};
