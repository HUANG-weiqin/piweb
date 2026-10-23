import type { PiRuntimeLike } from "./pi-runtime.js";

export const MODEL_REFRESH_TIMEOUT_MS = 15_000;
/**
 * Periodic freshness check. It does not force a download: Pi's remote catalog
 * keeps its own freshness window, so this mostly retries failed or skipped
 * refreshes and picks up newly published models on a long-running server.
 */
export const MODEL_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function timeoutError(): Error {
  return new Error("Automatic model refresh timed out");
}

function offline(): boolean {
  return process.env.PI_OFFLINE !== undefined;
}

/**
 * Background model-catalog refresh owned by the server process: one forced
 * refresh at startup, a forced refresh after every written credential change,
 * and a periodic non-forced freshness check. At most one refresh is in flight;
 * requests arriving meanwhile coalesce into a single rerun. Failures are only
 * diagnostics; manual refresh stays available for an explicit result.
 */
export class ModelCatalogAutoRefresh {
  private readonly lifecycle = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: { force: boolean } | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly runtime: Pick<PiRuntimeLike, "refreshConfiguration">,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (offline() || this.lifecycle.signal.aborted || this.timer !== undefined) return;
    this.request(true);
    this.timer = setInterval(() => this.request(false), MODEL_REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** A credential was written: fetch catalogs now instead of waiting for the next check. */
  credentialChanged(): void {
    this.request(true);
  }

  /** Permanently stops scheduling and aborts the in-flight refresh. */
  stop(): void {
    this.lifecycle.abort();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  /** Resolves once no refresh is in flight. */
  async drain(): Promise<void> {
    while (this.running !== undefined) await this.running;
  }

  private request(force: boolean): void {
    if (offline() || this.lifecycle.signal.aborted) return;
    this.pending = { force: force || this.pending?.force === true };
    this.kick();
  }

  private kick(): void {
    if (this.running !== undefined) return;
    this.running = this.pump().finally(() => {
      this.running = undefined;
      // A request may land after the loop's last check but before this cleanup.
      if (this.pending !== undefined) this.kick();
    });
  }

  private async pump(): Promise<void> {
    while (this.pending !== undefined && !this.lifecycle.signal.aborted) {
      const { force } = this.pending;
      this.pending = undefined;
      await this.refreshOnce(force);
    }
  }

  private async refreshOnce(force: boolean): Promise<void> {
    const controller = new AbortController();
    const onLifecycleAbort = () => controller.abort();
    this.lifecycle.signal.addEventListener("abort", onLifecycleAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MODEL_REFRESH_TIMEOUT_MS);
    timer.unref?.();

    try {
      await this.runtime.refreshConfiguration({
        allowNetwork: true,
        force,
        signal: controller.signal,
      });
      if (timedOut) throw timeoutError();
    } catch (error) {
      if (this.lifecycle.signal.aborted) return;
      try {
        this.onError(timedOut ? timeoutError() : error);
      } catch {
        // Diagnostics must not stop later refreshes.
      }
    } finally {
      clearTimeout(timer);
      this.lifecycle.signal.removeEventListener("abort", onLifecycleAbort);
    }
  }
}
