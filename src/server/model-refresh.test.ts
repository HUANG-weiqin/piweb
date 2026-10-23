import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRuntimeLike } from "./pi-runtime.js";
import {
  MODEL_REFRESH_INTERVAL_MS,
  MODEL_REFRESH_TIMEOUT_MS,
  ModelCatalogAutoRefresh,
} from "./model-refresh.js";

type RefreshOptions = Parameters<PiRuntimeLike["refreshConfiguration"]>[0];

function fakeRuntime(
  refreshConfiguration: PiRuntimeLike["refreshConfiguration"],
): Pick<PiRuntimeLike, "refreshConfiguration"> {
  return { refreshConfiguration };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ModelCatalogAutoRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("forces one refresh immediately on start", async () => {
    vi.useFakeTimers();
    const refreshConfiguration = vi.fn(async () => undefined);
    const refresher = new ModelCatalogAutoRefresh(fakeRuntime(refreshConfiguration), vi.fn());

    refresher.start();

    expect(refreshConfiguration).toHaveBeenCalledOnce();
    expect(refreshConfiguration).toHaveBeenCalledWith({
      allowNetwork: true,
      force: true,
      signal: expect.any(AbortSignal),
    });
    await refresher.drain();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS - 1);
    expect(refreshConfiguration).toHaveBeenCalledOnce();
    refresher.stop();
  });

  it("checks freshness periodically without forcing a download", async () => {
    vi.useFakeTimers();
    const refreshConfiguration = vi.fn(async () => undefined);
    const refresher = new ModelCatalogAutoRefresh(fakeRuntime(refreshConfiguration), vi.fn());

    refresher.start();
    await refresher.drain();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS);
    await refresher.drain();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS);
    await refresher.drain();

    expect(refreshConfiguration).toHaveBeenCalledTimes(3);
    expect(refreshConfiguration.mock.calls[1]?.[0]).toMatchObject({
      allowNetwork: true,
      force: false,
    });
    expect(refreshConfiguration.mock.calls[2]?.[0]).toMatchObject({
      allowNetwork: true,
      force: false,
    });
    refresher.stop();
  });

  it("forces a network refresh after a credential change, even before start", async () => {
    vi.useFakeTimers();
    const refreshConfiguration = vi.fn(async () => undefined);
    const refresher = new ModelCatalogAutoRefresh(fakeRuntime(refreshConfiguration), vi.fn());

    refresher.credentialChanged();
    await refresher.drain();

    expect(refreshConfiguration).toHaveBeenCalledOnce();
    expect(refreshConfiguration).toHaveBeenCalledWith({
      allowNetwork: true,
      force: true,
      signal: expect.any(AbortSignal),
    });
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS * 2);
    expect(refreshConfiguration).toHaveBeenCalledOnce();
  });

  it("keeps one refresh in flight and coalesces later requests into one forced rerun", async () => {
    vi.useFakeTimers();
    const gates = [deferred(), deferred()];
    const calls: RefreshOptions[] = [];
    const refreshConfiguration = vi.fn((options?: RefreshOptions) => {
      calls.push(options);
      return gates[calls.length - 1]?.promise ?? Promise.resolve();
    });
    const refresher = new ModelCatalogAutoRefresh(fakeRuntime(refreshConfiguration), vi.fn());

    refresher.start();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS);
    refresher.credentialChanged();
    refresher.credentialChanged();
    expect(calls).toHaveLength(1);

    gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ allowNetwork: true, force: true });

    gates[1]!.resolve();
    await refresher.drain();
    expect(calls).toHaveLength(2);
    refresher.stop();
  });

  it("does nothing while offline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_OFFLINE", "1");
    const refreshConfiguration = vi.fn(async () => undefined);
    const refresher = new ModelCatalogAutoRefresh(fakeRuntime(refreshConfiguration), vi.fn());

    refresher.start();
    refresher.credentialChanged();
    await refresher.drain();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS * 2);

    expect(refreshConfiguration).not.toHaveBeenCalled();
    refresher.stop();
  });

  it("reports ordinary failures without letting diagnostics stop later refreshes", async () => {
    vi.useFakeTimers();
    const error = new Error("provider unavailable");
    const refreshConfiguration = vi.fn(async () => {
      throw error;
    });
    const onError = vi.fn(() => {
      throw new Error("diagnostic failed");
    });
    const refresher = new ModelCatalogAutoRefresh(fakeRuntime(refreshConfiguration), onError);

    refresher.start();
    await expect(refresher.drain()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);

    refresher.credentialChanged();
    await refresher.drain();
    expect(refreshConfiguration).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    refresher.stop();
  });

  it("aborts timed-out refreshes and reports a safe error", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const refreshConfiguration = vi.fn((options?: RefreshOptions) => (
      new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      })
    ));
    const refresher = new ModelCatalogAutoRefresh(
      fakeRuntime(refreshConfiguration),
      (error) => errors.push(error),
    );

    refresher.credentialChanged();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_TIMEOUT_MS);
    await refresher.drain();

    expect(refreshConfiguration.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "Automatic model refresh timed out" });
  });

  it("stops permanently: aborts the in-flight refresh, drains cleanup, and reports nothing", async () => {
    vi.useFakeTimers();
    const cleanup = deferred();
    let aborted = false;
    const refreshConfiguration = vi.fn((options?: RefreshOptions) => {
      options?.signal?.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      return cleanup.promise;
    });
    const onError = vi.fn();
    const refresher = new ModelCatalogAutoRefresh(fakeRuntime(refreshConfiguration), onError);

    refresher.start();
    refresher.credentialChanged();
    refresher.stop();
    expect(aborted).toBe(true);

    let drained = false;
    const drain = refresher.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    cleanup.resolve();
    await drain;
    refresher.start();
    refresher.credentialChanged();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_INTERVAL_MS * 2);
    await refresher.drain();

    expect(refreshConfiguration).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
