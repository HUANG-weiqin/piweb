import type { PiRuntimeLike } from "./pi-runtime.js";
import { MODEL_REFRESH_TIMEOUT_MS } from "./model-refresh.js";

interface ManualModelRefresh {
  controller: AbortController;
  completion: Promise<never>;
  cancel(reason: string): void;
  cancelled?: string;
  underlying?: Promise<void>;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface ManualModelRefreshCallbacks {
  enqueue(operation: () => Promise<void>): Promise<void>;
  validateLaunch(): void;
  isCurrent(): boolean;
  emitCommandComplete(): void;
}

/** One connection's detached manual model-refresh admission and drain barrier. */
export class ManualModelRefreshGate {
  private manualRefresh?: ManualModelRefresh;

  constructor(private readonly runtime: PiRuntimeLike) {}

  start(callbacks: ManualModelRefreshCallbacks): Promise<void> {
    if (this.manualRefresh) {
      return Promise.reject(new Error("A model refresh is already pending"));
    }

    const controller = new AbortController();
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<never>((_, reject) => {
      rejectCompletion = reject;
    });
    let refresh!: ManualModelRefresh;
    const cancel = (reason: string, timedOut = false) => {
      if (refresh.cancelled || refresh.timedOut) return;
      refresh.timedOut = timedOut;
      if (!timedOut) refresh.cancelled = reason;
      controller.abort();
      rejectCompletion(new Error(reason));
      // A timed-out queued launch has no SDK work to serialize, so a retry may
      // be admitted immediately. Once an underlying refresh exists, its slot
      // remains held until that promise really drains.
      if (refresh.underlying === undefined && this.manualRefresh === refresh) {
        this.manualRefresh = undefined;
      }
    };
    const timer = setTimeout(() => {
      cancel("Model refresh timed out; please retry", true);
    }, MODEL_REFRESH_TIMEOUT_MS);
    timer.unref?.();
    refresh = {
      controller,
      completion,
      timer,
      timedOut: false,
      cancel: (reason: string) => cancel(reason),
    };
    this.manualRefresh = refresh;
    return this.begin(callbacks, refresh);
  }

  private begin(
    callbacks: ManualModelRefreshCallbacks,
    refresh: ManualModelRefresh,
  ): Promise<void> {
    // The launch remains ordered behind earlier connection work, but its
    // network settlement deliberately leaves this view-transition lane.
    const launch = callbacks.enqueue(async () => {
      callbacks.validateLaunch();
      if (refresh.timedOut || refresh.cancelled) return;
      this.launch(refresh);
    });
    return this.observe(callbacks, launch, refresh);
  }

  private observe(
    callbacks: ManualModelRefreshCallbacks,
    launch: Promise<void>,
    refresh: ManualModelRefresh,
  ): Promise<void> {
    const releaseWhenDrained = () => {
      const underlying = refresh.underlying;
      if (underlying === undefined) {
        if (this.manualRefresh === refresh) this.manualRefresh = undefined;
        return;
      }
      void underlying.catch(() => undefined).then(() => {
        if (this.manualRefresh === refresh) this.manualRefresh = undefined;
      });
    };
    void launch.then(releaseWhenDrained, releaseWhenDrained);

    const terminal = launch.then(async () => {
      this.throwIfUnsettled(refresh);
      const underlying = refresh.underlying;
      if (underlying === undefined) return;
      try {
        await underlying;
      } catch (error) {
        this.throwIfUnsettled(refresh);
        throw error;
      }
      this.throwIfUnsettled(refresh);
      if (!callbacks.isCurrent()) {
        throw new Error("Model refresh cancelled by connection lifecycle");
      }
      callbacks.emitCommandComplete();
    });
    // Timeout/lifecycle cancellation can win the public race while the
    // detached terminal promise waits for an abort-ignoring SDK operation.
    void terminal.catch(() => undefined);
    return Promise.race([terminal, refresh.completion]).finally(() => {
      clearTimeout(refresh.timer);
    });
  }

  private throwIfUnsettled(refresh: ManualModelRefresh): void {
    if (refresh.timedOut) {
      throw new Error("Model refresh timed out; please retry");
    }
    if (refresh.cancelled) throw new Error(refresh.cancelled);
  }

  private launch(refresh: ManualModelRefresh): void {
    if (process.env.PI_OFFLINE !== undefined) {
      throw new Error("Model refresh is unavailable while offline");
    }
    this.throwIfUnsettled(refresh);
    const underlying = this.runtime.refreshConfiguration({
      allowNetwork: true,
      force: true,
      signal: refresh.controller.signal,
    });
    refresh.underlying = underlying;
    // The caller may settle on timeout/cancellation while SDK refresh keeps
    // running. Always observe its eventual rejection.
    void underlying.catch(() => undefined);
  }

  async waitBarrier(): Promise<void> {
    const underlying = this.manualRefresh?.underlying;
    if (underlying === undefined) return;
    await underlying.catch(() => undefined);
  }

  cancel(reason: string): void {
    this.manualRefresh?.cancel(reason);
  }
}
