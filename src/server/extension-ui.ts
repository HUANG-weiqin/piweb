import { randomUUID } from "node:crypto";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import {
  extensionUIRequestSchema,
  type ExtensionUIRequest,
  type ExtensionUIResponse,
  type ServerEvent,
} from "../shared/protocol.js";

export type PortableExtensionUI = Omit<
  Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify" | "editor">,
  "editor"
> & {
  editor(
    title: string,
    prefill?: string,
    options?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;
};

export interface ExtensionUIScope {
  sessionId: string;
  generation: number;
  signal?: AbortSignal;
}

interface AcceptedResponse {
  accepted: boolean;
  value?: unknown;
}

interface PendingDialog {
  sessionId: string;
  generation: number;
  requestId: string;
  defaultValue: unknown;
  accept(response: ExtensionUIResponse): AcceptedResponse;
  resolve(value: unknown): void;
  signals: Array<{ signal: AbortSignal; listener: () => void }>;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_TIMER_MS = 2_147_483_647;
const MAX_REQUESTS_PER_CONNECTION = 4_096;
const NOTIFICATION_MAX_CHARS = 20_000;

/**
 * Connection-scoped rendezvous for the portable subset of Pi extension UI.
 * Dialog responses bypass the session actor so an extension waiting inside a
 * prompt or session_start hook cannot deadlock its own answer.
 */
export class ExtensionUIBroker {
  private readonly pending = new Map<string, PendingDialog>();
  private readonly usedRequestIds = new Set<string>();

  constructor(
    private readonly emit: (event: ServerEvent) => void,
    private readonly createRequestId: () => string = randomUUID,
  ) {}

  context(scope: ExtensionUIScope): PortableExtensionUI {
    return {
      select: (title, options, dialogOptions) => {
        const optionSnapshot = [...options];
        return this.request(
          scope,
          { kind: "select", title, options: optionSnapshot },
          dialogOptions,
          undefined,
          (response) => {
            if (response.kind === "cancel") return { accepted: true, value: undefined };
            if (
              response.kind !== "select"
              || !optionSnapshot.includes(response.value)
            ) {
              return { accepted: false };
            }
            return { accepted: true, value: response.value };
          },
        );
      },
      confirm: (title, message, dialogOptions) => this.request(
        scope,
        { kind: "confirm", title, message },
        dialogOptions,
        false,
        (response) => {
          if (response.kind === "cancel") return { accepted: true, value: false };
          return response.kind === "confirm"
            ? { accepted: true, value: response.confirmed }
            : { accepted: false };
        },
      ),
      input: (title, placeholder, dialogOptions) => this.request(
        scope,
        { kind: "input", title, placeholder },
        dialogOptions,
        undefined,
        (response) => {
          if (response.kind === "cancel") return { accepted: true, value: undefined };
          return response.kind === "input"
            ? { accepted: true, value: response.value }
            : { accepted: false };
        },
      ),
      editor: (title, prefill, dialogOptions) => this.request(
        scope,
        { kind: "editor", title, prefill },
        dialogOptions,
        undefined,
        (response) => {
          if (response.kind === "cancel") return { accepted: true, value: undefined };
          return response.kind === "editor"
            ? { accepted: true, value: response.value }
            : { accepted: false };
        },
      ),
      notify: (message, level = "info") => {
        if (scope.signal?.aborted) return;
        if (
          typeof message !== "string"
          || message.length > NOTIFICATION_MAX_CHARS
          || (level !== "info" && level !== "warning" && level !== "error")
        ) {
          throw new Error("Extension notification is not representable on the workbench wire");
        }
        this.emit({
          type: "extension_ui_notification",
          sessionId: scope.sessionId,
          level,
          message,
        });
      },
    };
  }

  respond(input: {
    sessionId: string;
    requestId: string;
    response: ExtensionUIResponse;
  }): boolean {
    const pending = this.pending.get(input.requestId);
    if (!pending || pending.sessionId !== input.sessionId) return false;
    const accepted = pending.accept(input.response);
    if (!accepted.accepted) return false;
    this.settle(pending, accepted.value);
    return true;
  }

  cancelScope(sessionId: string, generation: number): void {
    for (const pending of [...this.pending.values()]) {
      if (
        pending.sessionId === sessionId
        && pending.generation === generation
      ) {
        this.settle(pending, pending.defaultValue);
      }
    }
  }

  cancelAll(): void {
    for (const pending of [...this.pending.values()]) {
      this.settle(pending, pending.defaultValue);
    }
  }

  private request<Result>(
    scope: ExtensionUIScope,
    unsafeRequest: ExtensionUIRequest,
    options: ExtensionUIDialogOptions | undefined,
    defaultValue: Result,
    accept: (response: ExtensionUIResponse) => AcceptedResponse,
  ): Promise<Result> {
    if (scope.signal?.aborted || options?.signal?.aborted) {
      return Promise.resolve(defaultValue);
    }

    let request: ExtensionUIRequest;
    try {
      request = extensionUIRequestSchema.parse(unsafeRequest);
    } catch (error) {
      return Promise.reject(new Error(
        "Extension dialog is not representable on the workbench wire",
        { cause: error },
      ));
    }

    const timeout = this.normalizeTimeout(options?.timeout);
    if (timeout === 0) return Promise.resolve(defaultValue);
    const requestId = this.nextRequestId();

    return new Promise<Result>((resolve, reject) => {
      const pending: PendingDialog = {
        sessionId: scope.sessionId,
        generation: scope.generation,
        requestId,
        defaultValue,
        accept,
        resolve: (value) => resolve(value as Result),
        signals: [],
      };
      const signals = new Set(
        [scope.signal, options?.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        ),
      );
      for (const signal of signals) {
        const listener = () => this.settle(pending, pending.defaultValue);
        pending.signals.push({ signal, listener });
        signal.addEventListener("abort", listener, { once: true });
      }
      if (timeout !== undefined) {
        pending.timer = setTimeout(
          () => this.settle(pending, pending.defaultValue),
          timeout,
        );
      }
      this.pending.set(requestId, pending);

      try {
        this.emit({
          type: "extension_ui_request",
          sessionId: scope.sessionId,
          requestId,
          request,
        });
      } catch (error) {
        this.remove(pending);
        reject(error);
      }
    });
  }

  private settle(pending: PendingDialog, value: unknown): void {
    if (this.pending.get(pending.requestId) !== pending) return;
    this.remove(pending);
    pending.resolve(value);
    try {
      this.emit({
        type: "extension_ui_closed",
        sessionId: pending.sessionId,
        requestId: pending.requestId,
      });
    } catch {
      // The dialog settlement is authoritative; its projection is best effort.
    }
  }

  private remove(pending: PendingDialog): void {
    this.pending.delete(pending.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    for (const { signal, listener } of pending.signals) {
      signal.removeEventListener("abort", listener);
    }
  }

  private normalizeTimeout(timeout: number | undefined): number | undefined {
    if (timeout === undefined || !Number.isFinite(timeout)) return undefined;
    if (timeout <= 0) return 0;
    return Math.min(timeout, MAX_TIMER_MS);
  }

  private nextRequestId(): string {
    if (this.usedRequestIds.size >= MAX_REQUESTS_PER_CONNECTION) {
      throw new Error("Extension UI request limit exceeded for this connection");
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const requestId = this.createRequestId();
      if (this.usedRequestIds.has(requestId)) continue;
      this.usedRequestIds.add(requestId);
      return requestId;
    }
    throw new Error("Could not allocate a unique extension UI request ID");
  }
}
