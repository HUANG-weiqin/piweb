import type { LspServerProfile } from "../definition.js";

/** Community TypeScript Language Server; installation remains user-owned. */
export const typescript: LspServerProfile = {
  id: "typescript",
  adapterVersion: 1,
  command: ["typescript-language-server", "--stdio"],
  extensionToLanguage: {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
  },
  rootMarkers: [["tsconfig.json", "jsconfig.json"], ["package.json"]],
  initializationOptions: {},
  settings: {},
  // TLS 4.3.3 does not register or handle didChangeWatchedFiles.
  watchFiles: [],
};
