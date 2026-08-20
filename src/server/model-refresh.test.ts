import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRuntimeLike } from "./pi-runtime.js";
import {
  MODEL_REFRESH_TIMEOUT_MS,
  refreshModelCatalogOnStartup,
} from "./model-refresh.js";

function fakeRuntime(
  refreshConfiguration: PiRuntimeLike["refreshConfiguration"],
): PiRuntimeLike {
  return { refreshConfiguration } as unknown as PiRuntimeLike;
}

describe("refreshModelCatalogOnStartup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("starts immediately, only once, and forces the refresh", async () => {
    vi.useFakeTimers();
    const refreshConfiguration = vi.fn(async () => undefined);
    const lifecycle = new AbortController();

    const task = refreshModelCatalogOnStartup(
      fakeRuntime(refreshConfiguration),
      lifecycle.signal,
      vi.fn(),
    );

    expect(refreshConfiguration).toHaveBeenCalledOnce();
    expect(refreshConfiguration).toHaveBeenCalledWith({
      allowNetwork: true,
      force: true,
      signal: expect.any(AbortSignal),
    });
    await task;
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_TIMEOUT_MS * 2);
    expect(refreshConfiguration).toHaveBeenCalledOnce();
  });

  it("does nothing while offline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_OFFLINE", "1");
    const refreshConfiguration = vi.fn(async () => undefined);

    const task = refreshModelCatalogOnStartup(
      fakeRuntime(refreshConfiguration),
      new AbortController().signal,
      vi.fn(),
    );

    await task;
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_TIMEOUT_MS * 2);
    expect(refreshConfiguration).not.toHaveBeenCalled();
  });

  it("reports ordinary failures without letting diagnostics fail the task", async () => {
    vi.useFakeTimers();
    const error = new Error("provider unavailable");
    const refreshConfiguration = vi.fn(async () => {
      throw error;
    });
    const onError = vi.fn(() => {
      throw new Error("diagnostic failed");
    });

    await expect(refreshModelCatalogOnStartup(
      fakeRuntime(refreshConfiguration),
      new AbortController().signal,
      onError,
    )).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("aborts timed-out refreshes and reports a safe error", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const refreshConfiguration = vi.fn((options?: { signal?: AbortSignal }) => (
      new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      })
    ));

    const task = refreshModelCatalogOnStartup(
      fakeRuntime(refreshConfiguration),
      new AbortController().signal,
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_TIMEOUT_MS);
    await task;

    expect(refreshConfiguration.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "Automatic model refresh timed out" });
  });

  it("aborts on lifecycle shutdown, awaits cleanup, and reports nothing", async () => {
    vi.useFakeTimers();
    const lifecycle = new AbortController();
    let cleanupResolve!: () => void;
    let aborted = false;
    const refreshConfiguration = vi.fn((options?: { signal?: AbortSignal }) => (
      new Promise<void>((resolve) => {
        cleanupResolve = resolve;
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
      })
    ));
    const onError = vi.fn();

    const task = refreshModelCatalogOnStartup(
      fakeRuntime(refreshConfiguration),
      lifecycle.signal,
      onError,
    );
    lifecycle.abort();

    expect(aborted).toBe(true);
    let settled = false;
    void task.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    cleanupResolve();
    await task;
    expect(onError).not.toHaveBeenCalled();
  });

  it("does nothing when the lifecycle is already aborted", async () => {
    vi.useFakeTimers();
    const lifecycle = new AbortController();
    lifecycle.abort();
    const refreshConfiguration = vi.fn(async () => undefined);

    await refreshModelCatalogOnStartup(
      fakeRuntime(refreshConfiguration),
      lifecycle.signal,
      vi.fn(),
    );

    expect(refreshConfiguration).not.toHaveBeenCalled();
  });
});
