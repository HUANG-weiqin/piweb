import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRuntimeLike } from "./pi-runtime.js";
import {
  MODEL_REFRESH_INTERVAL_MS,
  MODEL_REFRESH_TIMEOUT_MS,
  ModelRefreshScheduler,
} from "./model-refresh-scheduler.js";

function fakeRuntime(
  refreshConfiguration: PiRuntimeLike["refreshConfiguration"],
): PiRuntimeLike {
  return { refreshConfiguration } as unknown as PiRuntimeLike;
}

describe("ModelRefreshScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("refreshes immediately, then waits for the interval without overlap", async () => {
    vi.useFakeTimers();
    expect(MODEL_REFRESH_INTERVAL_MS).toBe(4 * 60 * 60 * 1_000);
    let resolveRefresh!: () => void;
    const refreshConfiguration = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    const scheduler = new ModelRefreshScheduler(
      fakeRuntime(refreshConfiguration),
      vi.fn(),
      MODEL_REFRESH_TIMEOUT_MS * 2,
      100,
    );

    scheduler.start();
    expect(refreshConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      allowNetwork: true,
      force: false,
      signal: expect.any(AbortSignal),
    }));
    await vi.advanceTimersByTimeAsync(100);
    expect(refreshConfiguration).toHaveBeenCalledOnce();

    resolveRefresh();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(99);
    expect(refreshConfiguration).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshConfiguration).toHaveBeenCalledTimes(2);
    resolveRefresh();
    await scheduler.dispose();
  });

  it("aborts a timed-out refresh and reports a safe diagnostic", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const refreshConfiguration = vi.fn((options?: { signal?: AbortSignal }) => (
      new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      })
    ));
    const scheduler = new ModelRefreshScheduler(
      fakeRuntime(refreshConfiguration),
      (error) => errors.push(error),
      MODEL_REFRESH_TIMEOUT_MS,
      MODEL_REFRESH_INTERVAL_MS,
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_TIMEOUT_MS);
    expect(refreshConfiguration.mock.calls[0]?.[0]?.signal.aborted).toBe(true);
    expect(errors).toEqual([new Error("Automatic model refresh timed out")]);

    await scheduler.dispose();
  });

  it("continues on the interval after an ordinary refresh rejection", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let attempts = 0;
    const refreshConfiguration = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("provider unavailable");
    });
    const scheduler = new ModelRefreshScheduler(
      fakeRuntime(refreshConfiguration),
      (error) => errors.push(error),
      MODEL_REFRESH_TIMEOUT_MS,
      100,
    );

    scheduler.start();
    await Promise.resolve();
    expect(errors).toEqual([new Error("provider unavailable")]);
    await vi.advanceTimersByTimeAsync(99);
    expect(refreshConfiguration).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshConfiguration).toHaveBeenCalledTimes(2);
    await scheduler.dispose();
  });

  it("does nothing while offline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_OFFLINE", "1");
    const refreshConfiguration = vi.fn(async () => undefined);
    const scheduler = new ModelRefreshScheduler(fakeRuntime(refreshConfiguration), vi.fn());

    scheduler.start();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS * 2);
    expect(refreshConfiguration).not.toHaveBeenCalled();
    await scheduler.dispose();
  });

  it("aborts and awaits asynchronous cleanup on disposal", async () => {
    vi.useFakeTimers();
    let aborted = false;
    let cleanupResolve!: () => void;
    const refreshConfiguration = vi.fn((options?: { signal?: AbortSignal }) => (
      new Promise<void>((resolve) => {
        cleanupResolve = resolve;
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
      })
    ));
    const scheduler = new ModelRefreshScheduler(fakeRuntime(refreshConfiguration), vi.fn());

    scheduler.start();
    let disposed = false;
    const disposing = scheduler.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(disposed).toBe(false);
    cleanupResolve();
    await disposing;
    expect(disposed).toBe(true);
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS);
    expect(refreshConfiguration).toHaveBeenCalledOnce();
  });
});
