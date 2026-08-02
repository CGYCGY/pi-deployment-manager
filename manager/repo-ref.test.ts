// The image namespace is derived from the origin remote and NOTHING else (no config org, no
// dir basename), so a parse miss silently pushes to the wrong owner — or refuses a valid repo.
// These pin the remote forms git actually emits, plus the lowercasing GHCR requires.

import { describe, expect, test } from "bun:test";

import { parseGithubRemote } from "./tools.ts";

describe("parseGithubRemote", () => {
  test("parses the forms git emits, lowercasing both parts", () => {
    for (const url of [
      "git@github.com:CGYCGY/Pi-Projects.git",
      "https://github.com/CGYCGY/Pi-Projects.git",
      "https://github.com/CGYCGY/Pi-Projects",
      "ssh://git@github.com/CGYCGY/Pi-Projects.git",
      "https://token@github.com/CGYCGY/Pi-Projects.git\n",
    ]) {
      expect(parseGithubRemote(url)).toEqual({ owner: "cgycgy", repo: "pi-projects" });
    }
  });

  test("rejects non-github and incomplete remotes", () => {
    for (const url of ["git@gitlab.com:owner/repo.git", "https://github.com/owner", "/srv/git/repo.git", ""]) {
      expect(parseGithubRemote(url)).toBeNull();
    }
  });
});
