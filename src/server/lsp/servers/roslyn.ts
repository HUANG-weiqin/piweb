import { LspError, type LspConnection } from "../contracts.js";
import type { LspServerProfile } from "../definition.js";

/**
 * Roslyn 5.12 navigation prefers frozen partial semantics, which can retain old
 * dependency locations even after didOpen/didChange. A references request at the
 * same position prepares full semantics before definition. Both RPCs retain the
 * caller's signal, wire limits and shared connection; this is not a retry.
 * Upstream: 3aeb96c9ecc56a5ee483558f9e648e33e7bfe756,
 * src/Features/Core/Portable/Navigation/AbstractNavigableItemsService.cs.
 */
function adaptConnection(connection: LspConnection): LspConnection {
  let synchronizationRevision = 0;
  return {
    get capabilities() { return connection.capabilities; },
    get alive() { return connection.alive; },
    get pendingCount() { return connection.pendingCount; },
    supports: (method, document) => connection.supports(method, document) &&
      (method !== "textDocument/definition" || connection.supports("textDocument/references", document)),
    acceptsFileChanges: (path, type) => connection.acceptsFileChanges(path, type),
    notify: (method, params) => {
      synchronizationRevision += 1;
      return connection.notify(method, params);
    },
    dispose: () => connection.dispose(),
    async request(method, params, signal) {
      if (method === "textDocument/definition") {
        const preparedRevision = synchronizationRevision;
        const position = params as { textDocument: unknown; position: unknown };
        await connection.request("textDocument/references", {
          textDocument: position.textDocument,
          position: position.position,
          context: { includeDeclaration: true },
        }, signal);
        if (signal?.aborted) throw new LspError("cancelled", "Roslyn definition was cancelled during semantic preparation");
        if (preparedRevision !== synchronizationRevision) {
          throw new LspError("content_modified", "Roslyn documents changed during semantic preparation");
        }
      }
      return connection.request(method, params, signal);
    },
  };
}

/** Official Roslyn language server; installation is a user-owned prerequisite. */
export const roslyn: LspServerProfile = {
  id: "roslyn",
  adapterVersion: 2,
  adaptConnection,
  command: ["roslyn-language-server", "--stdio", "--autoLoadProjects"],
  extensionToLanguage: { ".cs": "csharp" },
  rootMarkers: [["*.sln", "*.slnx"], ["*.csproj"]],
  initializationOptions: {},
  settings: {},
  watchFiles: [],
};
