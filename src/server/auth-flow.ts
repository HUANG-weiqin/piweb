import { randomUUID } from "node:crypto";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
} from "@earendil-works/pi-ai";
import type { AuthRequest, ServerEvent } from "../shared/protocol.js";

type Response = { requestId: string; value?: string; selectedId?: string; cancelled?: boolean };
type Pending = {
  resolve(value: string): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
  selectedIds?: ReadonlySet<string>;
};

function cancelledError(): Error {
  return new Error("Authentication cancelled");
}

function infoMessage(event: Extract<AuthEvent, { type: "info" }>): string {
  if (!event.links || event.links.length === 0) return event.message;
  const links = event.links.map((link) => `${link.label ?? link.url}: ${link.url}`);
  return `${event.message}\n${links.join("\n")}`;
}

export class AuthFlowBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;

  constructor(
    readonly id: string,
    private readonly emit: (event: ServerEvent) => void,
  ) {}

  readonly interaction: AuthInteraction & { signal: AbortSignal } = {
    signal: this.signal,
    prompt: (prompt) => this.request(prompt),
    notify: (event) => this.notify(event),
  };

  private request(prompt: AuthPrompt): Promise<string> {
    if (this.signal.aborted || prompt.signal?.aborted) {
      return Promise.reject(cancelledError());
    }
    const requestId = randomUUID();
    const request = this.toRequest(prompt);
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        signal: prompt.signal,
        selectedIds: prompt.type === "select"
          ? new Set(prompt.options.map((option) => option.id))
          : undefined,
      };
      const abort = () => {
        this.removePending(requestId, pending);
        reject(cancelledError());
      };
      pending.onAbort = abort;
      this.pending.set(requestId, pending);
      prompt.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.emit({
          type: "auth_request",
          authFlowId: this.id,
          requestId,
          request,
        });
      } catch (error) {
        this.removePending(requestId, pending);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private removePending(requestId: string, pending: Pending): void {
    if (this.pending.get(requestId) !== pending) return;
    this.pending.delete(requestId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.onAbort = undefined;
  }

  private toRequest(prompt: AuthPrompt): AuthRequest {
    switch (prompt.type) {
      case "text":
        return {
          kind: "prompt",
          message: prompt.message,
          placeholder: prompt.placeholder,
          secret: false,
        };
      case "secret":
        return {
          kind: "prompt",
          message: prompt.message,
          placeholder: prompt.placeholder,
          secret: true,
        };
      case "manual_code":
        return {
          kind: "manual",
          message: prompt.message,
          placeholder: prompt.placeholder,
        };
      case "select":
        return {
          kind: "select",
          message: prompt.message,
          options: prompt.options.map(({ id, label }) => ({ id, label })),
        };
    }
  }

  private notify(event: AuthEvent): void {
    if (this.signal.aborted) return;
    switch (event.type) {
      case "auth_url":
        this.emit({
          type: "auth_request",
          authFlowId: this.id,
          requestId: randomUUID(),
          request: {
            kind: "auth",
            url: event.url,
            instructions: event.instructions,
          },
        });
        return;
      case "device_code":
        this.emit({
          type: "auth_request",
          authFlowId: this.id,
          requestId: randomUUID(),
          request: {
            kind: "device",
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            expiresInSeconds: event.expiresInSeconds,
          },
        });
        return;
      case "progress":
        this.emit({ type: "auth_progress", authFlowId: this.id, message: event.message });
        return;
      case "info":
        this.emit({
          type: "auth_progress",
          authFlowId: this.id,
          message: infoMessage(event),
        });
        return;
    }
  }

  respond(response: Response): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.removePending(response.requestId, pending);
    if (response.cancelled) {
      pending.reject(cancelledError());
    } else if (pending.selectedIds) {
      if (!response.selectedId || !pending.selectedIds.has(response.selectedId)) {
        pending.reject(new Error("Invalid authentication selection"));
      } else {
        pending.resolve(response.selectedId);
      }
    } else if (response.selectedId !== undefined) {
      pending.reject(new Error("Invalid authentication response"));
    } else {
      pending.resolve(response.value ?? "");
    }
  }

  cancel(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    const error = cancelledError();
    for (const [requestId, pending] of this.pending) {
      this.removePending(requestId, pending);
      pending.reject(error);
    }
  }
}
