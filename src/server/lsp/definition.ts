import { constants } from "node:fs";
import { access, open, opendir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import picomatch from "picomatch";
import { z } from "zod";
import { LspError, type ResolvedLspServer } from "./contracts.js";
import { lspServerProfiles } from "./servers/index.js";

export interface LspServerProfile {
  readonly id: string;
  readonly adapterVersion: number;
  readonly command: readonly [string, ...string[]];
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  readonly rootMarkers: readonly (readonly string[])[];
  readonly initializationOptions: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly watchFiles: readonly string[];
  readonly adaptConnection?: ResolvedLspServer["adaptConnection"];
}

const text = z.string().min(1).max(4096).refine((value) => !value.includes("\0"));
const declarationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  enabled: z.boolean().optional(),
  workspace: text.refine(isAbsolute).optional(),
  command: z.array(text).min(1).max(64).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192).refine((value) => !value.includes("\0"))).optional(),
  extensionToLanguage: z.record(z.string().regex(/^\.[a-z0-9]+$/), text)
    .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 64).optional(),
  rootMarkers: z.array(z.array(z.string().min(1).max(256).refine((value) => !/[\\/\0]/.test(value)))
    .min(1).max(16)).min(1).max(8).optional(),
  root: text.optional(),
  initializationOptions: z.record(z.unknown()).optional(),
  settings: z.record(z.unknown()).optional(),
  watchFiles: z.array(z.string().min(1).max(1024)).max(64).optional(),
}).strict();
const configurationSchema = z.object({
  version: z.literal(1),
  servers: z.array(declarationSchema).max(32),
}).strict();
type Declaration = z.infer<typeof declarationSchema>;

const identity = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const contains = (root: string, path: string) => {
  const suffix = relative(identity(root), identity(path));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};

/** Canonical JSON both bounds nesting and makes key order irrelevant to identity. */
function snapshot(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new LspError("resource_limit", "LSP configuration nesting exceeds 32 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, depth + 1)));
  if (typeof value === "object" && value !== null) {
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => [
      key, snapshot((value as Record<string, unknown>)[key], depth + 1),
    ])));
  }
  throw new LspError("misconfigured", "LSP configuration must contain only finite JSON values");
}

async function readDeclarations(configPath: string): Promise<Declaration[]> {
  let handle;
  try {
    const info = await stat(configPath);
    if (!info.isFile()) throw new LspError("misconfigured", "LSP configuration must be a regular file");
    if (info.size > 64 * 1024) throw new LspError("resource_limit", "LSP configuration exceeds 64 KiB");
    handle = await open(configPath, "r");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw new LspError("resource_limit", "LSP configuration exceeds 64 KiB");
    const parsed = snapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))));
    const result = configurationSchema.safeParse(parsed);
    if (!result.success) throw new LspError("misconfigured", "Invalid LSP configuration: expected version 1 and valid server declarations");
    return result.data.servers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof LspError) throw error;
    throw new LspError("misconfigured", "Cannot read valid UTF-8 JSON LSP configuration", { cause: error });
  } finally {
    await handle?.close();
  }
}

async function selectDeclarations(declarations: Declaration[], cwd: string): Promise<Declaration[]> {
  const selected = new Map<string, { declaration: Declaration; scoped: boolean }>();
  for (const declaration of declarations) {
    const scoped = declaration.workspace !== undefined;
    if (scoped) {
      const workspace = await realpath(declaration.workspace!).catch(() => undefined);
      if (!workspace || identity(workspace) !== identity(cwd)) continue;
    }
    const previous = selected.get(declaration.id);
    if (previous?.scoped === scoped) throw new LspError("misconfigured", `Duplicate LSP declaration: ${declaration.id}`);
    if (!previous || scoped) selected.set(declaration.id, { declaration, scoped });
  }
  return [...selected.values()].map(({ declaration }) => declaration).filter((entry) => entry.enabled !== false);
}

async function findRoot(cwd: string, file: string, declaration: Declaration, markers: LspServerProfile["rootMarkers"]): Promise<string> {
  if (declaration.root !== undefined) {
    const root = await realpath(resolve(cwd, declaration.root));
    if (!contains(cwd, root) || !contains(root, file) || !(await stat(root)).isDirectory()) {
      throw new LspError("invalid_path", "LSP root must be a workspace directory containing the source file");
    }
    return root;
  }
  const ancestors: string[] = [];
  for (let directory = dirname(file); contains(cwd, directory); directory = dirname(directory)) {
    ancestors.push(directory);
    if (identity(directory) === identity(cwd)) break;
    if (ancestors.length >= 64) throw new LspError("resource_limit", "LSP root search exceeds 64 directories");
  }
  const entries = new Map<string, string[]>();
  for (const group of markers) {
    const matches = picomatch([...group], { dot: true, nocase: process.platform === "win32" });
    for (const directory of ancestors) {
      let names = entries.get(directory);
      if (!names) {
        names = [];
        let count = 0;
        for await (const entry of await opendir(directory)) {
          if (++count > 4096) throw new LspError("resource_limit", "LSP root directory exceeds 4096 entries; configure an explicit root");
          if (entry.isFile()) names.push(entry.name);
        }
        entries.set(directory, names);
      }
      const found = names.filter((name) => matches(name));
      if (found.length > 1) throw new LspError("ambiguous_server", `Multiple LSP root markers in ${directory}; select an independent root explicitly`);
      if (found.length === 1) return directory;
    }
  }
  throw new LspError("misconfigured", "No LSP root marker found within the workspace; configure an explicit root");
}

async function resolveExecutable(executable: string, root: string, env: Readonly<Record<string, string>>): Promise<string> {
  if (/\.(cmd|bat|ps1)$/i.test(executable) || (!isAbsolute(executable) && /[\\/]/.test(executable))) {
    throw new LspError("misconfigured", "LSP command requires an absolute executable or PATH name, not a shell script; use node plus an absolute JS entry point");
  }
  const extensions = process.platform === "win32" && !extname(executable) ? [".exe", ""] : [""];
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const directories = isAbsolute(executable) ? [""] : path.split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = isAbsolute(executable) ? executable + extension : resolve(root, directory.replace(/^"|"$/g, ""), executable + extension);
      try {
        const actual = await realpath(candidate);
        if (!(await stat(actual)).isFile()) continue;
        if (/\.(cmd|bat|ps1)$/i.test(actual)) continue;
        await access(actual, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return actual;
      } catch { /* Try the next explicit PATH entry; never invoke a shell. */ }
    }
  }
  throw new LspError("unavailable", `LSP executable is not available: ${executable}`);
}

/** Reads only user-owned configuration. No project config, registration tool or installer. */
export async function resolveLspServer(
  workspace: string,
  canonicalFile: string,
  configPath = join(getAgentDir(), "piweb", "lsp.json"),
): Promise<ResolvedLspServer> {
  try {
    const cwd = await realpath(workspace);
    const file = await realpath(canonicalFile);
    if (!contains(cwd, file) || !(await stat(file)).isFile()) throw new LspError("invalid_path", "LSP source must be a regular file inside the workspace");
    const declarations = await selectDeclarations(await readDeclarations(configPath), cwd);
    const candidates = declarations.map((declaration) => {
      const profile = lspServerProfiles.find((entry) => entry.id === declaration.id);
      const extensionToLanguage = declaration.extensionToLanguage ?? profile?.extensionToLanguage;
      if (!extensionToLanguage || !(declaration.command ?? profile?.command)
        || (!declaration.root && !(declaration.rootMarkers ?? profile?.rootMarkers))) {
        throw new LspError("misconfigured", `Incomplete custom LSP declaration: ${declaration.id}`);
      }
      return { declaration, profile, extensionToLanguage };
    }).filter(({ extensionToLanguage }) => Object.hasOwn(extensionToLanguage, extname(file).toLowerCase()));
    if (candidates.length === 0) throw new LspError("not_enabled", "No LSP server is enabled for this source in the user-level piweb/lsp.json");
    if (candidates.length !== 1) throw new LspError("ambiguous_server", "More than one LSP server matches this source; enable only one per workspace and extension");
    const { declaration, profile, extensionToLanguage } = candidates[0]!;
    const root = await findRoot(cwd, file, declaration, declaration.rootMarkers ?? profile?.rootMarkers ?? []);
    const env: Record<string, string> = {};
    for (const [key, value] of [...Object.entries(process.env), ...Object.entries(declaration.env ?? {})]) {
      if (value !== undefined) env[process.platform === "win32" ? key.toUpperCase() : key] = value;
    }
    const command = [...(declaration.command ?? profile!.command)] as [string, ...string[]];
    command[0] = await resolveExecutable(command[0], root, env);
    const resolved = snapshot({
      id: declaration.id, root, command, env, extensionToLanguage,
      initializationOptions: declaration.initializationOptions ?? profile?.initializationOptions ?? {},
      settings: declaration.settings ?? profile?.settings ?? {},
      watchFiles: declaration.watchFiles ?? profile?.watchFiles ?? [],
    }) as Omit<ResolvedLspServer, "fingerprint" | "adaptConnection">;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      ...resolved, root: identity(root), adapterVersion: profile?.adapterVersion ?? 1,
    })).digest("hex");
    return Object.freeze({
      ...resolved,
      fingerprint,
      ...(profile?.adaptConnection ? { adaptConnection: profile.adaptConnection } : {}),
    });
  } catch (error) {
    if (error instanceof LspError) throw error;
    throw new LspError("unavailable", "Cannot resolve the local LSP server", { cause: error });
  }
}
