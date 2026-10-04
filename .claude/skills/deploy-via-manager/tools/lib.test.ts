// The missing-.env.deploy guard. Regression: a fresh clone of gen-image-gateway carried the
// committed deploy/Dockerfile + deploy/deploy.sh but not the gitignored deploy/.env.deploy, and
// the redeploy request went to the manager with nothing reporting the missing file (2026-10-03).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadManagerCfg, missingEnvDeploy, resolveManagerDir } from "./lib.ts";

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

describe("manager checkout resolution", () => {
  const saved = {
    HOME: process.env.HOME,
    DIR: process.env.PI_DEPLOYMENT_MANAGER_DIR,
    CONFIG: process.env.PI_DEPLOYMENT_MANAGER_CONFIG,
  };
  // realpath: macOS tmpdir() is under the /var -> /private/var symlink, and resolution realpaths.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dvm-resolve-")));
  let n = 0;
  let home = "";

  function checkout(at: string): string {
    mkdirSync(join(at, "manager"), { recursive: true });
    mkdirSync(join(at, "shared"), { recursive: true });
    mkdirSync(join(at, ".claude", "skills", "deploy-via-manager"), { recursive: true });
    writeFileSync(join(at, "package.json"), JSON.stringify({ name: "pi-deployment-manager" }));
    writeFileSync(join(at, "shared", "config.ts"), "");
    return at;
  }
  const skillOf = (co: string): string => join(co, ".claude", "skills", "deploy-via-manager");
  function plainSkill(): string {
    const dir = join(home, ".claude", "skills", "deploy-via-manager");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    home = join(base, `case-${n++}`);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    delete process.env.PI_DEPLOYMENT_MANAGER_DIR;
    delete process.env.PI_DEPLOYMENT_MANAGER_CONFIG;
  });
  afterEach(() => {
    for (const [k, v] of [
      ["HOME", saved.HOME],
      ["PI_DEPLOYMENT_MANAGER_DIR", saved.DIR],
      ["PI_DEPLOYMENT_MANAGER_CONFIG", saved.CONFIG],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("the env var wins over everything else", () => {
    const fromEnv = checkout(join(home, "env-co"));
    const dev = checkout(join(home, "dev-co"));
    checkout(join(home, ".gylab", "pi-deployment-manager"));
    process.env.PI_DEPLOYMENT_MANAGER_DIR = fromEnv;
    expect(resolveManagerDir(skillOf(dev))).toBe(fromEnv);
  });

  test("the skill-local config.json comes next, with ~ expanded", () => {
    checkout(join(home, "pinned"));
    const dev = checkout(join(home, "dev-co"));
    writeFileSync(join(skillOf(dev), "config.json"), JSON.stringify({ managerDir: "~/pinned" }));
    expect(resolveManagerDir(skillOf(dev))).toBe(join(home, "pinned"));
  });

  test("an explicit location that is not a checkout is an error, not skipped", () => {
    checkout(join(home, ".gylab", "pi-deployment-manager"));
    process.env.PI_DEPLOYMENT_MANAGER_DIR = join(home, "nowhere");
    expect(() => resolveManagerDir(plainSkill())).toThrow(/PI_DEPLOYMENT_MANAGER_DIR.*not a pi-deployment-manager checkout/);
  });

  test("a skill folder symlinked into ~/.claude/skills resolves to its real checkout", () => {
    const dev = checkout(join(home, "projects", "pi-deployment-manager"));
    checkout(join(home, ".gylab", "pi-deployment-manager"));
    const link = join(home, ".claude", "skills", "deploy-via-manager");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(skillOf(dev), link);
    expect(resolveManagerDir(link)).toBe(dev);
  });

  test("a checkout is recognised by its layout when package.json is absent", () => {
    const dev = checkout(join(home, "renamed"));
    rmSync(join(dev, "package.json"));
    expect(resolveManagerDir(skillOf(dev))).toBe(dev);
  });

  test("a copied skill folder falls back to ~/.gylab/pi-deployment-manager", () => {
    const gylab = checkout(join(home, ".gylab", "pi-deployment-manager"));
    expect(resolveManagerDir(plainSkill())).toBe(gylab);
  });

  test("with no checkout anywhere the error points at setup.sh", () => {
    // config.json + state/ alone (developer-mode data dir) is not a checkout.
    mkdirSync(join(home, ".gylab", "pi-deployment-manager", "state"), { recursive: true });
    const skill = plainSkill();
    expect(() => resolveManagerDir(skill)).toThrow(join(skill, "setup.sh"));
  });

  test("the manager config is read from ~/.gylab, not from the checkout", () => {
    const data = join(home, ".gylab", "pi-deployment-manager");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ model: "m", thinking: "low" }));
    expect(loadManagerCfg()).toEqual({
      configPath: join(data, "config.json"),
      stateDir: join(data, "state"),
      model: "m",
      thinking: "low",
    });
  });

  test("PI_DEPLOYMENT_MANAGER_CONFIG overrides the config path, and stateDir expands ~", () => {
    const file = join(home, "elsewhere.json");
    writeFileSync(file, JSON.stringify({ stateDir: "~/custom-state" }));
    process.env.PI_DEPLOYMENT_MANAGER_CONFIG = file;
    const cfg = loadManagerCfg();
    expect(cfg.configPath).toBe(file);
    expect(cfg.stateDir).toBe(join(home, "custom-state"));
  });
});
