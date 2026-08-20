import type { PiRuntimeLike } from "./pi-runtime.js";

export const MODEL_REFRESH_TIMEOUT_MS = 15_000;
export const MODEL_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1_000;

type Timer = ReturnType<typeof setTimeout>;

function isOffline(): boolean {
  return process.env.PI_OFFLINE !== undefined;
}

function timeoutError(): Error {
  return new Error("Automatic model refresh timed out");
}

export class ModelRefreshScheduler {
  private timer?: Timer;
  private controller?: AbortController;
  private current?: Promise<void>;
  private started = false;
  private disposed = false;

  constructor(
    private readonly runtime: PiRuntimeLike,
    private readonly onError: (error: unknown) => void,
    private readonly timeoutMs = MODEL_REFRESH_TIMEOUT_MS,
    private readonly intervalMs = MODEL_REFRESH_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (!isOffline()) void this.runRefresh();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.current;
      return;
    }
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.current;
  }

  private scheduleNext(): void {
    if (this.disposed || isOffline()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runRefresh();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async runRefresh(): Promise<void> {
    if (this.disposed || isOffline() || this.current) return;
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timeout.unref?.();

    let current!: Promise<void>;
    current = (async () => {
      try {
        await this.runtime.refreshConfiguration({
          allowNetwork: true,
          force: false,
          signal: controller.signal,
        });
        if (timedOut) throw timeoutError();
      } catch (error) {
        if (!this.disposed) {
          try {
            this.onError(timedOut ? timeoutError() : error);
          } catch {
            // Scheduler diagnostics must not stop future refreshes.
          }
        }
      } finally {
        clearTimeout(timeout);
        if (this.controller === controller) this.controller = undefined;
        if (this.current === current) this.current = undefined;
        this.scheduleNext();
      }
    })();
    this.current = current;
    await current;
  }
}
