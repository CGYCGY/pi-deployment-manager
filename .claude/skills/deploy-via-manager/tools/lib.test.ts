// The missing-.env.deploy guard. Regression: a fresh clone of gen-image-gateway carried the
// committed deploy/Dockerfile + deploy/deploy.sh but not the gitignored deploy/.env.deploy, and
// the redeploy request went to the manager with nothing reporting the missing file (2026-10-03).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { missingEnvDeploy } from "./lib.ts";

const root = mkdtempSync(join(tmpdir(), "dvm-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, files: string[]): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "deploy"), { recursive: true });
  for (const f of files) writeFileSync(join(dir, "deploy", f), "");
  return dir;
}

test("a set-up project missing deploy/.env.deploy is flagged", () => {
  const dir = project("cloned", ["Dockerfile", "deploy.sh"]);
  expect(missingEnvDeploy(`redeploy after update: ${dir} at subdomain x`)).toEqual([dir]);
});

test("trailing punctuation, a trailing slash and quotes around the path are tolerated", () => {
  const dir = project("punct", ["Dockerfile", "deploy.sh"]);
  expect(missingEnvDeploy(`redeploy ${dir}/, please`)).toEqual([dir]);
  expect(missingEnvDeploy(`redeploy "${dir}" (update)`)).toEqual([dir]);
});

test("a project with its .env.deploy present passes", () => {
  const dir = project("complete", ["Dockerfile", "deploy.sh", ".env.deploy"]);
  expect(missingEnvDeploy(`redeploy ${dir}`)).toEqual([]);
});

test("a deploy/ dir the manager never scaffolded passes", () => {
  const own = project("own-dockerfile", ["Dockerfile"]);
  const bare = project("bare", []);
  expect(missingEnvDeploy(`deploy ${own} and ${bare}`)).toEqual([]);
});

test("paths that are not directories, and messages with no path, pass", () => {
  const dir = project("file-path", ["Dockerfile", "deploy.sh"]);
  expect(missingEnvDeploy(`runtime env ${join(dir, "deploy", "Dockerfile")}`)).toEqual([]);
  expect(missingEnvDeploy(`${root}/does-not-exist`)).toEqual([]);
  expect(missingEnvDeploy("yes, go ahead")).toEqual([]);
});
