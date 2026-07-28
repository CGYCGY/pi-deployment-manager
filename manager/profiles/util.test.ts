// Dockerfile inspection. The multi-volume cases are regressions: reading only the FIRST VOLUME
// path provisioned one mount for a two-path declaration, and the unmounted path lost its data on
// the next redeploy with nothing reporting a problem (pi-image-gateway, 2026-07-07 -> 07-28).

import { expect, test } from "bun:test";

import { dockerfileProfile } from "./dockerfile.ts";
import { parseDockerfile } from "./util.ts";

test("every path of a JSON-array VOLUME is parsed, not just the first", () => {
  const m = parseDockerfile(`FROM oven/bun:1\nEXPOSE 8080\nVOLUME ["/root/.codex", "/root/.pi"]\n`);
  expect(m.volumeMounts).toEqual(["/root/.codex", "/root/.pi"]);
  expect(m.expose).toBe(8080);
});

test("shell-form and repeated VOLUME lines both contribute, de-duplicated", () => {
  const m = parseDockerfile(`FROM x\nVOLUME /data /cache\nVOLUME ["/data", "/logs"]\n`);
  expect(m.volumeMounts).toEqual(["/data", "/cache", "/logs"]);
});

test("no VOLUME line leaves volumeMounts unset", () => {
  expect(parseDockerfile("FROM x\nEXPOSE 3000\n").volumeMounts).toBeUndefined();
});

test("HEALTHCHECK path and EXPOSE still parse alongside volumes", () => {
  const m = parseDockerfile(
    `FROM x\nEXPOSE 8080\nVOLUME ["/data"]\nHEALTHCHECK CMD bun -e "fetch('http://127.0.0.1:8080/healthz')"\n`,
  );
  expect(m.healthPath).toBe("/healthz");
  expect(m.volumeMounts).toEqual(["/data"]);
});

async function specsFor(dockerfile: string): Promise<string[] | undefined> {
  const dir = `/tmp/gw-profile-${Bun.hash(dockerfile).toString(36)}`;
  await Bun.write(`${dir}/Dockerfile`, dockerfile);
  return (await dockerfileProfile.inspect!(dir)).volumeSpecs;
}

test("inspect emits one spec per mount, named from the last path segment", async () => {
  expect(await specsFor(`FROM x\nEXPOSE 80\nVOLUME ["/root/.codex", "/root/.pi"]\n`)).toEqual([
    ".codex:/root/.codex",
    ".pi:/root/.pi",
  ]);
});

test("colliding last segments fall back to the flattened path, keeping names unique", async () => {
  expect(await specsFor(`FROM x\nEXPOSE 80\nVOLUME ["/a/data", "/b/data"]\n`)).toEqual([
    "data:/a/data",
    "b-data:/b/data",
  ]);
});
