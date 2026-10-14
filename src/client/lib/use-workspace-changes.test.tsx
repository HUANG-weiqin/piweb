// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCommand, ServerEvent } from "../../shared/protocol";
import { useWorkspaceChanges } from "./use-workspace-changes";

type RefreshCommand = Extract<ClientCommand, { type: "refresh_workspace_changes" }>;
const INITIAL = {
  sessionId: "88f3af1d-d21d-40a0-b3c3-0f27593f274a",
  projectId: "f25ee8d8-34f0-4c30-a045-b2a69f2e28bd",
  online: true,
};
const READY = {
  state: "ready" as const,
  branch: "main",
  files: [{ path: "src/a.ts", status: "modified" as const }],
  total: 1,
  truncated: false,
};
function receipt(command: RefreshCommand): Extract<ServerEvent, { type: "workspace_changes" }> {
  return { ...command, type: "workspace_changes", snapshot: READY };
}
function harness(send = vi.fn((_command: RefreshCommand) => true)) {
  const hook = renderHook((props) => useWorkspaceChanges({ ...props, send }), { initialProps: INITIAL });
  return { ...hook, send };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useWorkspaceChanges", () => {
  it("reads only while visible, coalesces requests and preserves the previous snapshot during refresh", () => {
    const { result, send, rerender } = harness();
    act(() => vi.advanceTimersByTime(60_000));
    expect(send).not.toHaveBeenCalled();
    act(() => result.current.onVisibilityChange(true));
    const first = send.mock.calls[0]![0];
    expect(first).toMatchObject({ type: "refresh_workspace_changes", sessionId: INITIAL.sessionId, projectId: INITIAL.projectId });
    expect(first).not.toHaveProperty("online");
    expect(result.current.loading).toBe(true);
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    expect(send).toHaveBeenCalledTimes(1);
    act(() => result.current.observe(receipt(first)));
    expect(result.current.snapshot).toEqual(READY);
    expect(result.current.loading).toBe(false);
    // Unrelated rerenders do not query Git (including streamed transcript updates).
    rerender({ ...INITIAL });
    expect(send).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(10_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot).toEqual(READY);
    expect(result.current.loading).toBe(true);
    act(() => result.current.observe(receipt(send.mock.calls[1]![0])));
    act(() => result.current.onVisibilityChange(false));
    act(() => vi.advanceTimersByTime(30_000));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("accepts only exact session, project and one-time command receipts", () => {
    const { result, send } = harness();
    act(() => result.current.onVisibilityChange(true));
    const command = send.mock.calls[0]![0];
    for (const key of ["sessionId", "projectId", "commandId"] as const) {
      act(() => result.current.observe({ ...receipt(command), [key]: crypto.randomUUID() } as ServerEvent));
      expect(result.current.loading).toBe(true);
      expect(result.current.snapshot).toBeUndefined();
    }
    act(() => result.current.observe({
      type: "error", scope: "command", operation: "refresh_workspace_changes",
      sessionId: command.sessionId, commandId: crypto.randomUUID(), message: "wrong read",
    }));
    expect(result.current.loading).toBe(true);
    act(() => result.current.observe(receipt(command)));
    expect(result.current.snapshot).toEqual(READY);
    act(() => result.current.observe({ ...receipt(command), snapshot: { state: "not_git" } }));
    expect(result.current.snapshot).toEqual(READY);
  });

  it("discards pending reads and previous results across a project or observation change", () => {
    const { result, send, rerender } = harness();
    act(() => result.current.onVisibilityChange(true));
    const old = send.mock.calls[0]![0];
    const next = { ...INITIAL, sessionId: crypto.randomUUID(), projectId: crypto.randomUUID() };
    rerender(next);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot).toBeUndefined();
    act(() => result.current.observe(receipt(old)));
    expect(result.current.snapshot).toBeUndefined();
    expect(result.current.loading).toBe(true);
    const current = send.mock.calls[1]![0];
    expect(current).toMatchObject({ sessionId: next.sessionId, projectId: next.projectId });
    act(() => result.current.observe(receipt(current)));
    expect(result.current.snapshot).toEqual(READY);
  });

  it("pauses in a hidden document and refreshes once on return", () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const { result, send } = harness();
    act(() => result.current.onVisibilityChange(true));
    act(() => result.current.observe(receipt(send.mock.calls[0]![0])));
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(30_000));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not query while offline and does not reuse a stale pending read on reconnect", () => {
    const { result, send, rerender } = harness();
    act(() => result.current.onVisibilityChange(true));
    const old = send.mock.calls[0]![0];
    rerender({ ...INITIAL, online: false });
    act(() => vi.advanceTimersByTime(30_000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot?.state).toBe("error");
    act(() => result.current.observe(receipt(old)));
    rerender(INITIAL);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].commandId).not.toBe(old.commandId);
    expect(result.current.loading).toBe(true);
  });

  it("reports transport rejection and a bounded timeout without claiming an empty worktree", () => {
    const rejected = harness(vi.fn((_command: RefreshCommand) => false));
    act(() => rejected.result.current.onVisibilityChange(true));
    expect(rejected.result.current.loading).toBe(false);
    expect(rejected.result.current.snapshot?.state).toBe("error");
    rejected.unmount();
    const waiting = harness();
    act(() => waiting.result.current.onVisibilityChange(true));
    act(() => waiting.result.current.onVisibilityChange(false));
    act(() => vi.advanceTimersByTime(10_000));
    expect(waiting.result.current.loading).toBe(false);
    expect(waiting.result.current.snapshot).toEqual({ state: "error", message: "读取工作区改动超时，请重试。" });
    expect(waiting.send).toHaveBeenCalledTimes(1);
  });

  it("registers a pending read before synchronous dispatch and clears timers on unmount", () => {
    let observe: ((event: ServerEvent) => void) | undefined;
    const send = vi.fn((command: RefreshCommand) => {
      observe?.(receipt(command));
      return true;
    });
    const { result, unmount } = harness(send);
    observe = result.current.observe;
    act(() => result.current.onVisibilityChange(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot).toEqual(READY);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
