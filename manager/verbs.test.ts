// session_start hands VERB_NAMES to pi.setActiveTools, which replaces the whole active set, so a
// registered verb missing from the list never reaches the model (sync_storages shipped that way).

import { expect, test } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ManagerToolDeps } from "./tools.ts";
import { registerManagerTools, VERB_NAMES } from "./tools.ts";

test("every registered tool is in the active verb set, and nothing else is", () => {
  const registered: string[] = [];
  const pi = { registerTool: (t: { name: string }) => registered.push(t.name) } as unknown as ExtensionAPI;
  registerManagerTools(pi, {} as ManagerToolDeps);
  expect(registered.length).toBeGreaterThan(0);
  expect([...registered].sort()).toEqual([...VERB_NAMES].sort());
});
