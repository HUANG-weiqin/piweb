import type { PortableExtensionUI } from "./extension-ui.js";

interface RoutedDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

interface PendingExtensionUIRoute {
  defaultValue: unknown;
  invoke(delegate: PortableExtensionUI): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  invoked: boolean;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ConversationExtensionUIRouter {
  private readonly delegates = new Map<symbol, PortableExtensionUI>();
  private readonly pending = new Set<PendingExtensionUIRoute>();
  private closed = false;

  readonly ui: PortableExtensionUI = {
    select: (title, options, dialogOptions) => this.route(
      undefined,
      dialogOptions,
      (delegate, routedOptions) =>
        delegate.select(title, options, routedOptions),
    ),
    confirm: (title, message, dialogOptions) => this.route(
      false,
      dialogOptions,
      (delegate, routedOptions) =>
        delegate.confirm(title, message, routedOptions),
    ),
    input: (title, placeholder, dialogOptions) => this.route(
      undefined,
      dialogOptions,
      (delegate, routedOptions) =>
        delegate.input(title, placeholder, routedOptions),
    ),
    editor: (title, prefill, dialogOptions) => this.route(
      undefined,
      dialogOptions,
      (delegate, routedOptions) =>
        delegate.editor(title, prefill, routedOptions),
    ),
    notify: (message, level) => {
      if (this.closed) return;
      const delegate = this.current();
      if (!delegate) {
        this.onUnavailable();
        return;
      }
      delegate.notify(message, level);
    },
  };

  constructor(private readonly onUnavailable: () => void) {}

  attach(delegate: PortableExtensionUI): () => void {
    if (this.closed) return () => undefined;
    const token = Symbol("conversation-extension-ui");
    this.delegates.set(token, delegate);
    this.flush(delegate);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.delegates.delete(token);
    };
  }

  clear(): void {
    this.closed = true;
    this.delegates.clear();
    for (const request of [...this.pending]) {
      this.settle(request, request.defaultValue);
    }
  }

  private current(): PortableExtensionUI | undefined {
    return [...this.delegates.values()].at(-1);
  }

  private route<Result>(
    defaultValue: Result,
    options: RoutedDialogOptions | undefined,
    invoke: (
      delegate: PortableExtensionUI,
      options: RoutedDialogOptions | undefined,
    ) => Promise<Result>,
  ): Promise<Result> {
    if (this.closed) return Promise.resolve(defaultValue);
    if (
      options?.signal?.aborted
      || (
        options?.timeout !== undefined
        && Number.isFinite(options.timeout)
        && options.timeout <= 0
      )
    ) {
      return Promise.resolve(defaultValue);
    }
    return new Promise<Result>((resolve, reject) => {
      const startedAt = Date.now();
      const request: PendingExtensionUIRoute = {
        defaultValue,
        invoke: (nextDelegate) => {
          const remaining = options?.timeout === undefined
            ? undefined
            : Math.max(0, options.timeout - (Date.now() - startedAt));
          return invoke(nextDelegate, {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(remaining === undefined ? {} : { timeout: remaining }),
          });
        },
        resolve: (value) => resolve(value as Result),
        reject,
        invoked: false,
        ...(options?.signal === undefined
          ? {}
          : { signal: options.signal }),
      };
      if (request.signal) {
        request.abortListener = () => {
          this.settle(request, request.defaultValue);
        };
        request.signal.addEventListener(
          "abort",
          request.abortListener,
          { once: true },
        );
      }
      if (
        options?.timeout !== undefined
        && Number.isFinite(options.timeout)
        && options.timeout > 0
      ) {
        request.timer = setTimeout(
          () => this.settle(request, request.defaultValue),
          Math.min(options.timeout, 2_147_483_647),
        );
      }
      this.pending.add(request);
      if (request.signal?.aborted) {
        this.settle(request, request.defaultValue);
        return;
      }
      const delegate = this.current();
      if (delegate) {
        this.invoke(request, delegate);
      } else {
        this.onUnavailable();
      }
    });
  }

  private flush(delegate: PortableExtensionUI): void {
    for (const request of [...this.pending]) {
      this.invoke(request, delegate);
    }
  }

  private invoke(
    request: PendingExtensionUIRoute,
    delegate: PortableExtensionUI,
  ): void {
    if (!this.pending.has(request) || request.invoked) return;
    request.invoked = true;
    let operation: Promise<unknown>;
    try {
      operation = request.invoke(delegate);
    } catch (error) {
      this.fail(request, error);
      return;
    }
    void operation.then(
      (value) => this.settle(request, value),
      (error) => this.fail(request, error),
    );
  }

  private settle(request: PendingExtensionUIRoute, value: unknown): void {
    if (!this.pending.has(request)) return;
    this.remove(request);
    request.resolve(value);
  }

  private fail(request: PendingExtensionUIRoute, error: unknown): void {
    if (!this.pending.has(request)) return;
    this.remove(request);
    request.reject(error);
  }

  private remove(request: PendingExtensionUIRoute): void {
    this.pending.delete(request);
    if (request.timer) clearTimeout(request.timer);
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener("abort", request.abortListener);
    }
  }
}
