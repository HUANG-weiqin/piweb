import type { ServerCapabilities } from "vscode-languageserver-protocol";

/** Internal server-side contract; never part of the browser protocol. */
export interface ResolvedLspServer {
  readonly id: string;
  readonly root: string;
  /** An already resolved executable plus literal arguments. Never a shell command. */
  readonly command: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  readonly initializationOptions: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  /** Statically verified didChangeWatchedFiles patterns, relative to root. */
  readonly watchFiles: readonly string[];
  readonly fingerprint: string;
  /** Vetted built-in adapter only; never executable code from user/project configuration. */
  readonly adaptConnection?: (connection: LspConnection) => LspConnection;
}

export type LspRequestMethod =
  | "textDocument/documentSymbol"
  | "workspace/symbol"
  | "workspaceSymbol/resolve"
  | "textDocument/definition"
  | "textDocument/references";

export type LspNotificationMethod =
  | "textDocument/didOpen"
  | "textDocument/didChange"
  | "textDocument/didClose"
  | "textDocument/didSave"
  | "workspace/didChangeWatchedFiles";

export interface LspDocumentSelector {
  readonly uri: string;
  readonly languageId: string;
}

export interface LspConnection {
  readonly capabilities: ServerCapabilities;
  readonly alive: boolean;
  /** Includes abandoned requests whose server response has not arrived. */
  readonly pendingCount: number;
  supports(method: LspRequestMethod, document?: LspDocumentSelector): boolean;
  /** Event type is LSP FileChangeType: created=1, changed=2, deleted=3. */
  acceptsFileChanges(path: string, type: 1 | 2 | 3): boolean;
  request(method: LspRequestMethod, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: LspNotificationMethod, params: unknown): Promise<void>;
  dispose(): Promise<void>;
}

export type LspConnectionFactory = (server: ResolvedLspServer) => Promise<LspConnection>;

interface QueryBase {
  readonly path: string;
  readonly limit?: number;
}

export type LspQuery =
  | (QueryBase & {
      readonly operation: "symbols";
      readonly scope: "document" | "workspace";
      readonly query?: string;
    })
  | (QueryBase & {
      readonly operation: "definition" | "references";
      /** One-based; columns count UTF-16 code units. */
      readonly line: number;
      readonly column: number;
      readonly includeDeclaration?: boolean;
    });

export interface LspQueryResponse {
  readonly server: string;
  readonly root: string;
  readonly uri: string;
  /** Raw protocol data stays inside the server; tools project bounded results. */
  readonly value: unknown;
}

export interface LspQueryService {
  query(input: LspQuery, signal: AbortSignal): Promise<LspQueryResponse>;
}

export type LspFailureCode =
  | "unsupported"
  | "unavailable"
  | "misconfigured"
  | "timeout"
  | "cancelled"
  | "content_modified"
  | "resource_limit"
  | "invalid_path"
  | "ambiguous_server"
  | "untrusted"
  | "not_enabled";

export class LspError extends Error {
  constructor(readonly code: LspFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LspError";
  }
}

export const LSP_MAX_RESULTS = 100;
export const LSP_DEFAULT_RESULTS = 30;
export const LSP_MAX_RESULT_BYTES = 24 * 1024;
