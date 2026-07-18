import { describe, expect, it, vi } from "vitest";
import type { ToolMode } from "../shared/protocol.js";
import { ProjectRunCoordinator } from "./project-run-coordinator.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ProjectRunCoordinator", () => {
  it("blocks new runs and waits for old runs before acknowledging read-only", async () => {
    const coordinator = new ProjectRunCoordinator();
    const cwd = "E:\\work";
    const cancel = vi.fn();
    const setToolMode = vi.fn(async () => undefined);
    const lease = coordinator.registerRun(cwd, cancel);
    if (!lease) throw new Error("run was not registered");

    const transition = coordinator.transitionToolMode(
      { cwd, setToolMode },
      "read_only",
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(coordinator.isRestrictionPending(cwd)).toBe(true);
    expect(coordinator.registerRun(cwd, () => undefined)).toBeUndefined();
    expect(setToolMode).not.toHaveBeenCalled();

    lease.release();
    await transition;

    expect(setToolMode).toHaveBeenCalledWith("read_only");
    expect(coordinator.isRestrictionPending(cwd)).toBe(false);
  });

  it("serializes project mode changes while a restriction is settling", async () => {
    const coordinator = new ProjectRunCoordinator();
    const cwd = "E:\\work";
    const readOnlyStarted = deferred();
    const releaseReadOnly = deferred();
    const calls: string[] = [];
    const project = {
      cwd,
      setToolMode: async (mode: ToolMode) => {
        calls.push(mode);
        if (mode === "read_only") {
          readOnlyStarted.resolve();
          await releaseReadOnly.promise;
        }
      },
    };

    const readOnly = coordinator.transitionToolMode(project, "read_only");
    const fullAccess = coordinator.transitionToolMode(project, "full_access");
    await readOnlyStarted.promise;

    expect(calls).toEqual(["read_only"]);
    releaseReadOnly.resolve();
    await Promise.all([readOnly, fullAccess]);

    expect(calls).toEqual(["read_only", "full_access"]);
  });

  it("installs a read-only barrier even behind a queued full-access change", async () => {
    const coordinator = new ProjectRunCoordinator();
    const cwd = "E:\\work";
    const fullAccessStarted = deferred();
    const releaseFullAccess = deferred();
    const readOnlyStarted = deferred();
    const releaseReadOnly = deferred();
    const project = {
      cwd,
      toolMode: "read_only" as const,
      setToolMode: async (mode: ToolMode) => {
        if (mode === "full_access") {
          fullAccessStarted.resolve();
          await releaseFullAccess.promise;
        } else {
          readOnlyStarted.resolve();
          await releaseReadOnly.promise;
        }
      },
    };

    const fullAccess = coordinator.transitionToolMode(project, "full_access");
    await fullAccessStarted.promise;
    const readOnly = coordinator.transitionToolMode(project, "read_only");

    expect(coordinator.isRestrictionPending(cwd)).toBe(true);
    expect(coordinator.registerRun(cwd, () => undefined)).toBeUndefined();

    releaseFullAccess.resolve();
    await readOnlyStarted.promise;
    expect(coordinator.isRestrictionPending(cwd)).toBe(true);
    expect(coordinator.registerRun(cwd, () => undefined)).toBeUndefined();

    releaseReadOnly.resolve();
    await Promise.all([fullAccess, readOnly]);
    expect(coordinator.isRestrictionPending(cwd)).toBe(false);
    coordinator.registerRun(cwd, () => undefined)?.release();
  });
});
