// The detached manager's RPC routing. Both prompt-response cases used to hang the caller for the
// full 20-minute turn budget (no settle ever comes), and an aborted settle was relayed as if the
// manager had replied.

import { describe, expect, test } from "bun:test";

import { type Pending, RESULT_MARK, routeRpcEvent, type RpcStep, verdictId } from "./lib.ts";

const req = (result?: Record<string, unknown>): Pending => ({ id: "req-1", result });
const fetchText: RpcStep = { do: "send", command: { type: "get_last_assistant_text", id: verdictId("req-1") } };

describe("agent_settled", () => {
  test("an aborted settle with no result yet finishes as an aborted error", () => {
    expect(routeRpcEvent({ type: "agent_settled", aborted: true }, req())).toEqual({
      do: "finish",
      out: { id: "req-1", kind: "error", reason: "aborted", detail: expect.any(String) },
    });
  });

  test("an aborted settle after the result landed still fetches the text and emits the result", () => {
    const current = req({ status: "ok" });
    expect(routeRpcEvent({ type: "agent_settled", aborted: true }, current)).toEqual(fetchText);
    expect(routeRpcEvent({ type: "response", id: verdictId("req-1"), data: { text: " done " } }, current)).toEqual({
      do: "finish",
      out: { id: "req-1", kind: "result", result: { status: "ok" }, text: "done" },
    });
  });

  test("a clean settle, or one from pre-1.1 pi without the field, fetches the reply text", () => {
    expect(routeRpcEvent({ type: "agent_settled", aborted: false }, req())).toEqual(fetchText);
    expect(routeRpcEvent({ type: "agent_settled" }, req())).toEqual(fetchText);
    expect(routeRpcEvent({ type: "response", id: verdictId("req-1"), data: { text: "which subdomain?" } }, req())).toEqual({
      do: "finish",
      out: { id: "req-1", kind: "reply", text: "which subdomain?" },
    });
  });

  test("a late settle with no request in flight is dropped", () => {
    expect(routeRpcEvent({ type: "agent_settled", aborted: true }, null)).toEqual({ do: "none" });
    expect(routeRpcEvent({ type: "agent_settled", aborted: false }, null)).toEqual({ do: "none" });
  });
});

describe("the prompt's own response", () => {
  test("a rejected prompt finishes as an error carrying pi's message", () => {
    const msg = { type: "response", command: "prompt", id: "req-1", success: false, error: "Agent is already processing" };
    expect(routeRpcEvent(msg, req())).toEqual({
      do: "finish",
      out: { id: "req-1", kind: "error", reason: "prompt_rejected", detail: "Agent is already processing" },
    });
  });

  test("a handled prompt resolves as a reply at once, since no run (and no settle) follows", () => {
    const msg = { type: "response", command: "prompt", id: "req-1", success: true, data: { disposition: "handled" } };
    expect(routeRpcEvent(msg, req())).toMatchObject({ do: "finish", out: { id: "req-1", kind: "reply" } });
  });

  test("a started or queued prompt keeps waiting for the settle", () => {
    for (const disposition of ["started", "queued"]) {
      const msg = { type: "response", command: "prompt", id: "req-1", success: true, data: { disposition } };
      expect(routeRpcEvent(msg, req())).toEqual({ do: "none" });
    }
  });

  test("a response to some other request is ignored", () => {
    const msg = { type: "response", command: "prompt", id: "req-0", success: false, error: "stale" };
    expect(routeRpcEvent(msg, req())).toEqual({ do: "none" });
  });
});

test("notify markers: READY always, RESULT only while a request is in flight", () => {
  const notify = (message: string) => ({ type: "extension_ui_request", method: "notify", message });
  expect(routeRpcEvent(notify("PIDEPLOY_READY manager up"), null)).toEqual({ do: "ready" });
  expect(routeRpcEvent(notify(`${RESULT_MARK} {"status":"ok"}`), req())).toEqual({ do: "result", result: { status: "ok" } });
  expect(routeRpcEvent(notify(`${RESULT_MARK} {"status":"ok"}`), null)).toEqual({ do: "none" });
});
