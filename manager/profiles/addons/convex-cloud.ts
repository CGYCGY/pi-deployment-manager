// convex-cloud — a Convex Cloud backend (managed, NOT self-hosted). Deployed BEFORE the
// frontend build so its prod URL can be baked in as a build-time env var. The var NAME
// differs by frontend family, because each bundler only exposes its own prefixed vars to
// client code (NEXT_PUBLIC_*, PUBLIC_* for Astro/Vite-with-Astro, VITE_* for Vite).

import type { BackendAddon } from "../types.ts";
import { hasDep, isDir, readPackageJson } from "../util.ts";

export const convexCloud: BackendAddon = {
  id: "convex-cloud",
  async detect(projectDir) {
    return isDir(projectDir, "convex") && hasDep(readPackageJson(projectDir), "convex");
  },
  buildEnvVar(frontendId) {
    if (frontendId.startsWith("nextjs")) return "NEXT_PUBLIC_CONVEX_URL";
    if (frontendId === "astro-static") return "PUBLIC_CONVEX_URL";
    if (frontendId === "react-spa") return "VITE_CONVEX_URL";
    return "CONVEX_URL";
  },
};
