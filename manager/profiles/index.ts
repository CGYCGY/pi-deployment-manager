// The DeployProfile registry: fail-loud lookup + auto-detection from the repo.
//
// detectProfile resolves ONE frontend by priority (most-specific signal first), so a
// mis-detect deploys the wrong runtime — it fails loud instead. Adding a framework =
// drop a profile file and list it here.

import { astroStatic } from "./astro-static.ts";
import { convexCloud } from "./addons/convex-cloud.ts";
import { nextjsNode } from "./nextjs-node.ts";
import { nextjsStatic } from "./nextjs-static.ts";
import { reactSpa } from "./react-spa.ts";
import { sqliteVolume } from "./addons/sqlite-volume.ts";
import { staticHtml } from "./static-html.ts";
import type { BackendAddon, DeployProfile } from "./types.ts";
import { hasDep, isAstroStatic, nextOutputIsExport, readPackageJson } from "./util.ts";

export const FRONTEND_PROFILES: DeployProfile[] = [
  staticHtml,
  reactSpa,
  astroStatic,
  nextjsNode,
  nextjsStatic,
];

export const BACKEND_ADDONS: BackendAddon[] = [convexCloud, sqliteVolume];

const BY_ID: Record<string, DeployProfile> = Object.fromEntries(
  FRONTEND_PROFILES.map((p) => [p.id, p]),
);

export function getProfile(id: string): DeployProfile {
  const p = BY_ID[id];
  if (!p) {
    const known = Object.keys(BY_ID).sort().join(", ");
    throw new Error(`pi-deployment-manager: unknown deploy profile "${id}". Known: ${known}.`);
  }
  return p;
}

/**
 * Resolve the one frontend profile, by priority. Next is checked first (its dep is the
 * strongest signal and is the project default), then Astro-static, then a client React
 * SPA, then a bare static site. No match throws — better than mis-deploying.
 */
export async function detectProfile(projectDir: string): Promise<DeployProfile> {
  const pkg = readPackageJson(projectDir);

  if (hasDep(pkg, "next")) {
    return nextOutputIsExport(projectDir) ? nextjsStatic : nextjsNode;
  }
  if (isAstroStatic(projectDir, pkg)) {
    return astroStatic;
  }
  if ((hasDep(pkg, "vite") || hasDep(pkg, "react-scripts")) && hasDep(pkg, "react")) {
    return reactSpa;
  }
  if (await staticHtml.detect(projectDir)) {
    return staticHtml;
  }

  throw new Error(
    `pi-deployment-manager: could not detect a deploy profile for ${projectDir}. Looked for: ` +
      `a "next" dep (nextjs-node / nextjs-static by output:'export'), an astro.config with no SSR ` +
      `adapter (astro-static), "vite"/"react-scripts" + "react" (react-spa), or a root index.html ` +
      `with no build script (static-html). Add a profile or adjust the project.`,
  );
}

/** All backend addons whose signal is present (compose on top of the frontend). */
export async function detectAddons(projectDir: string): Promise<BackendAddon[]> {
  const matched: BackendAddon[] = [];
  for (const addon of BACKEND_ADDONS) {
    if (await addon.detect(projectDir)) matched.push(addon);
  }
  return matched;
}

export type { BackendAddon, DeployProfile, DockerfileOutput } from "./types.ts";
