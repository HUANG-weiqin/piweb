import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  LSP_DEFAULT_RESULTS, LSP_MAX_RESULTS, LSP_MAX_RESULT_BYTES, LspError,
  type LspQuery, type LspQueryResponse, type LspQueryService,
} from "./contracts.js";
import { readWorkspaceFile } from "./read-workspace-file.js";

const pathParameter = Type.String({ minLength: 1, maxLength: 4096, description: "Existing source file inside this workspace; also selects the server and root." });
const limitParameter = Type.Optional(Type.Integer({ minimum: 1, maximum: LSP_MAX_RESULTS }));
const positionParameters = {
  path: pathParameter,
  line: Type.Integer({ minimum: 1 }),
  column: Type.Integer({ minimum: 1, description: "One-based UTF-16 code-unit column (not bytes or Unicode code points)." }),
  limit: limitParameter,
};
const symbolsParameters = Type.Object({
  path: pathParameter,
  scope: Type.String({ enum: ["document", "workspace"] }),
  query: Type.Optional(Type.String({ maxLength: 1024 })),
  limit: limitParameter,
}, { additionalProperties: false });
const definitionParameters = Type.Object(positionParameters, { additionalProperties: false });
const referencesParameters = Type.Object({
  ...positionParameters,
  includeDeclaration: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

type Position = { line: number; column: number };
type Range = { start: Position; end: Position };
type Item = {
  uri: string;
  path?: string;
  range?: Range;
  name?: string;
  kind?: number;
  containerName?: string;
  readStatus?: string;
  truncated?: true;
  disk?: { line: number; text: string; observation: "read_after_response" };
};
type Projection = {
  status: "ok";
  server: string;
  root: string;
  positionEncoding: "utf-16";
  items: Item[];
  truncated: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function clipped(value: string, max = 512): string {
  const result = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
}
function position(value: unknown): Position | undefined {
  const data = record(value);
  if (!data || !Number.isInteger(data.line) || !Number.isInteger(data.character)
    || (data.line as number) < 0 || (data.character as number) < 0
    || (data.line as number) > 0x7fffffff || (data.character as number) > 0x7fffffff) return undefined;
  return { line: (data.line as number) + 1, column: (data.character as number) + 1 };
}
function range(value: unknown): Range | undefined {
  const data = record(value);
  const start = position(data?.start);
  const end = position(data?.end);
  if (!start || !end || end.line < start.line || (end.line === start.line && end.column < start.column)) return undefined;
  return { start, end };
}

/** Walk only as far as the output limit, without recursively copying a symbol tree. */
function* items(value: unknown, query: LspQuery, sourceUri: string): Generator<Item> {
  if (value === null) return;
  const initial = Array.isArray(value) ? value : query.operation === "definition" && record(value) ? [value] : undefined;
  if (!initial) throw new LspError("unavailable", "Invalid LSP response shape");
  const stack: Array<{ values: unknown[]; index: number; parent?: string }> = [{ values: initial, index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.values.length) { stack.pop(); continue; }
    const node = record(frame.values[frame.index++]);
    if (!node) throw new LspError("unavailable", "Invalid LSP result item");
    let uri: unknown;
    let rawRange: unknown;
    if (query.operation === "symbols") {
      const location = record(node.location);
      uri = location?.uri ?? (query.scope === "document" ? sourceUri : undefined);
      rawRange = location ? location.range : node.selectionRange ?? node.range;
      if (typeof node.name !== "string" || !Number.isInteger(node.kind)) throw new LspError("unavailable", "Invalid LSP symbol");
    } else {
      uri = node.targetUri ?? node.uri;
      rawRange = node.targetSelectionRange ?? node.targetRange ?? node.range;
    }
    const locationRange = range(rawRange);
    if (typeof uri !== "string" || uri.length === 0
      || (!locationRange && !(query.operation === "symbols" && query.scope === "workspace" && rawRange === undefined))) {
      throw new LspError("unavailable", "Invalid LSP location");
    }
    if (uri.length > 4096) throw new LspError("resource_limit", "LSP result URI exceeds 4096 characters");
    const item: Item = { uri, ...(locationRange ? { range: locationRange } : {}) };
    if (query.operation === "symbols") {
      item.name = clipped(node.name as string);
      item.kind = node.kind as number;
      const parent = typeof node.containerName === "string" ? node.containerName : frame.parent;
      if (parent) item.containerName = clipped(parent);
      if (item.name !== node.name || (parent && item.containerName !== parent)) item.truncated = true;
    }
    yield item;
    if (query.operation === "symbols" && query.scope === "document" && node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new LspError("unavailable", "Invalid LSP symbol children");
      stack.push({ values: node.children, index: 0, parent: item.name });
    }
  }
}

function contains(root: string, path: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const suffix = relative(normalize(root), normalize(path));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function projectResponse(workspace: string, response: LspQueryResponse, query: LspQuery, signal: AbortSignal): Promise<Projection> {
  const projection: Projection = {
    status: "ok", server: response.server, root: response.root,
    positionEncoding: "utf-16", items: [], truncated: false,
  };
  const disk = new Map<string, string[] | undefined>();
  let diskBytes = 0;
  const addDiskObservation = async (item: Item) => {
    let url: URL;
    try { url = new URL(item.uri); } catch { item.readStatus = "invalid_uri"; return; }
    if (url.protocol !== "file:") { item.readStatus = "non_file_uri"; return; }
    if (url.hostname && url.hostname !== "localhost") { item.readStatus = "non_local_uri"; return; }
    try {
      const lexical = fileURLToPath(url);
      // Do not even stat an out-of-workspace server reference.
      if (!contains(workspace, lexical)) { item.readStatus = "outside_workspace"; return; }
      const path = await realpath(lexical);
      if (!contains(workspace, path)) { item.readStatus = "outside_workspace"; return; }
      item.path = relative(workspace, path).split(sep).join("/");
      if (!item.range) { item.readStatus = "position_unavailable"; return; }
      if (!disk.has(path)) {
        try {
          const buffer = await readWorkspaceFile(workspace, path,
            Math.min(2 * 1024 * 1024, 4 * 1024 * 1024 - diskBytes), (bytes) => { diskBytes += bytes; });
          disk.set(path, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer).split(/\r\n|\r|\n/));
        } catch (error) {
          if (!(error instanceof LspError) || error.code !== "resource_limit") throw error;
          disk.set(path, undefined);
        }
      }
      const lines = disk.get(path);
      if (lines === undefined) { item.readStatus = "resource_limit"; return; }
      const line = lines[item.range.start.line - 1];
      if (line === undefined) { item.readStatus = "position_unavailable"; return; }
      const text = clipped(line, 300);
      if (text !== line) item.truncated = true;
      item.disk = { line: item.range.start.line, text, observation: "read_after_response" };
      item.readStatus = "ok";
    } catch { item.readStatus = "unavailable"; }
  };
  const limit = query.limit ?? LSP_DEFAULT_RESULTS;
  for (const item of items(response.value, query, response.uri)) {
    if (signal.aborted) throw new LspError("cancelled", "LSP query cancelled");
    if (projection.items.length >= limit) { projection.truncated = true; break; }
    await addDiskObservation(item);
    projection.items.push(item);
    if (item.truncated) projection.truncated = true;
    if (Buffer.byteLength(JSON.stringify(projection), "utf8") > LSP_MAX_RESULT_BYTES - 32) {
      projection.items.pop();
      projection.truncated = true;
      break;
    }
  }
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > LSP_MAX_RESULT_BYTES) throw new LspError("resource_limit", "LSP result metadata exceeds the output budget");
  if (signal.aborted) throw new LspError("cancelled", "LSP query cancelled");
  return projection;
}

export function createLspTools(cwd: string, service: LspQueryService): ToolDefinition[] {
  // ProjectContext supplies its canonical identity; a later junction must not rebase it.
  const workspace = resolve(cwd);
  const execute = async (schema: unknown, name: string, operation: LspQuery["operation"], input: unknown, signal?: AbortSignal) => {
    if (!Check(schema as never, input)) throw new Error(`Invalid ${name} input`);
    try {
      if (!signal || signal.aborted) throw new LspError("cancelled", "LSP query requires a live run");
      const query = { ...input as object, operation } as LspQuery;
      const response = await service.query(query, signal);
      const details = await projectResponse(workspace, response, query, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    } catch (error) {
      const failure = error instanceof LspError ? error : new LspError("unavailable", "LSP query failed", { cause: error });
      // Throwing is the SDK's error contract; successful tool results have no isError field.
      throw new LspError(failure.code, `[${failure.code}] ${clipped(failure.message, 1024)}`, { cause: failure });
    }
  };
  const guidelines = [
    "Use an existing source file inside this workspace as the path anchor. Positions are one-based UTF-16 code units.",
    "Results are bounded server observations, not proof that indexing is complete. Disk snippets are independent reads after the response; verify source before editing.",
    "Unsupported, unavailable, cancelled and empty results differ. These tools never install servers, edit source, execute arbitrary LSP methods or read virtual/external source.",
  ];
  return [
    defineTool({
      name: "lsp_symbols", label: "LSP symbols",
      description: "Query document or workspace symbols through a configured local stdio language server. Disk is authoritative; workspace scope uses path as the server/root anchor. Returns bounded locations, not permanent symbol IDs.",
      promptGuidelines: guidelines,
      parameters: symbolsParameters,
      execute: (_id, input, signal) => execute(symbolsParameters, "lsp_symbols", "symbols", input, signal),
    }),
    defineTool({
      name: "lsp_definition", label: "LSP definition",
      description: "Find a source position's definition using a configured local language server. Line and column are one-based; column counts UTF-16 code units. Read-only, bounded results; no virtual or external source reads.",
      promptGuidelines: guidelines,
      parameters: definitionParameters,
      execute: (_id, input, signal) => execute(definitionParameters, "lsp_definition", "definition", input, signal),
    }),
    defineTool({
      name: "lsp_references", label: "LSP references",
      description: "Find references to a source position using a configured local language server. One-based UTF-16 line/column; includeDeclaration defaults false. Read-only, bounded results; unsupported is not an empty result.",
      promptGuidelines: guidelines,
      parameters: referencesParameters,
      execute: (_id, input, signal) => execute(referencesParameters, "lsp_references", "references", input, signal),
    }),
  ];
}
