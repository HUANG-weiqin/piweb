import { randomUUID } from "node:crypto";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { AuthRequest, ServerEvent } from "../shared/protocol.js";

type Response = { requestId: string; value?: string; selectedId?: string; cancelled?: boolean };
type Pending = { resolve(value: string | undefined): void; reject(error: Error): void };

export class AuthFlowBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly controller = new AbortController();

  constructor(private readonly emit: (event: ServerEvent) => void) {}

  private request(request: AuthRequest): Promise<string | undefined> {
    const requestId = randomUUID();
    this.emit({ type: "auth_request", requestId, request });
    return new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
  }

  readonly callbacks: OAuthLoginCallbacks = {
    onAuth: (info) => this.emit({ type: "auth_request", requestId: randomUUID(), request: { kind: "auth", ...info } }),
    onDeviceCode: (info) => this.emit({
      type: "auth_request",
      requestId: randomUUID(),
      request: { kind: "device", userCode: info.userCode, verificationUri: info.verificationUri, expiresInSeconds: info.expiresInSeconds },
    }),
    onPrompt: async (prompt) => (await this.request({ kind: "prompt", ...prompt })) ?? "",
    onProgress: (message) => this.emit({ type: "auth_progress", message }),
    onManualCodeInput: async () => (await this.request({ kind: "manual", message: "粘贴授权回调地址或验证码" })) ?? "",
    onSelect: async (prompt) => this.request({ kind: "select", ...prompt }),
    signal: this.controller.signal,
  };

  respond(response: Response): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.cancelled) pending.reject(new Error("Authentication cancelled"));
    else pending.resolve(response.selectedId ?? response.value);
  }

  cancel(): void {
    this.controller.abort();
    for (const pending of this.pending.values()) pending.reject(new Error("Authentication cancelled"));
    this.pending.clear();
  }
}
