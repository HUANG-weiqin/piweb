import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { SerialTaskQueue } from "./serial-task-queue.js";

const NOTEBOOK_VERSION = 1;
const NOTEBOOK_DIRECTORY = "notebooks";
const CONVERSATION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export const MAX_NOTE_TITLE_CHARS = 160;
export const MAX_NOTE_CONTENT_BYTES = 32 * 1024;
export const MAX_NOTE_COUNT = 128;
const MAX_NOTEBOOK_LIST_NOTES = 100;
const MAX_NOTEBOOK_GREP_MATCHES = 50;
export const MAX_NOTEBOOK_READ_TITLES = 8;
const MAX_NOTEBOOK_READ_BYTES = 64 * 1024;

const MAX_NOTEBOOK_FILE_BYTES = MAX_NOTE_COUNT * (
  MAX_NOTE_CONTENT_BYTES + MAX_NOTE_TITLE_CHARS + 256
);
const PREVIEW_CHARS = 160;
const SNIPPET_CHARS = 200;

export type NotebookStatus = "active" | "archived" | "all";

interface NotebookNote {
  title: string;
  content: string;
  archived: boolean;
  updatedAt: string;
}

export interface NotebookNoteMetadata {
  title: string;
  preview: string;
  archived: boolean;
  chars: number;
  lines: number;
  updatedAt: string;
}

export interface NotebookWriteInput {
  title: string;
  content?: string;
  archived?: boolean;
}

export interface NotebookListResult {
  status: NotebookStatus;
  notes: NotebookNoteMetadata[];
  truncated: boolean;
}

interface NotebookGrepMatch {
  title: string;
  archived: boolean;
  field: "title" | "content";
  line?: number;
  snippet: string;
  updatedAt: string;
}

export interface NotebookGrepResult {
  pattern: string;
  status: NotebookStatus;
  matches: NotebookGrepMatch[];
  truncated: boolean;
}

interface NotebookReadNote extends NotebookNoteMetadata {
  content: string;
  truncated: boolean;
}

export interface NotebookReadResult {
  notes: NotebookReadNote[];
  truncated: boolean;
}

interface NotebookFileV1 {
  version: typeof NOTEBOOK_VERSION;
  notes: NotebookNote[];
}

interface NotebookPaths {
  stateDir: string;
  notebookDir: string;
  file: string;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code
  );
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== ""
    && pathFromParent !== ".."
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent)
  );
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsAreIdentical(first: string, second: string): boolean {
  return pathIdentity(first) === pathIdentity(second);
}

function statsAreIdentical(first: Stats, second: Stats): boolean {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.isFile() === second.isFile();
}

async function assertCanonicalOwnedDirectory(
  expectedPath: string,
  label: string,
): Promise<void> {
  const lexicalPath = resolve(expectedPath);
  const information = await lstat(lexicalPath);
  if (information.isSymbolicLink()) {
    throw new Error(
      `${label} must not be a symbolic link or junction: ${lexicalPath}`,
    );
  }
  if (!information.isDirectory()) {
    throw new Error(`${label} is not a directory: ${lexicalPath}`);
  }

  const canonicalPath = await realpath(lexicalPath);
  if (!pathsAreIdentical(canonicalPath, lexicalPath)) {
    throw new Error(
      `${label} resolves outside its project-owned path: ${lexicalPath} -> ${canonicalPath}`,
    );
  }
}

function assertConversationId(conversationId: string): void {
  if (
    conversationId.length === 0
    || conversationId.length > 256
    || !CONVERSATION_ID_PATTERN.test(conversationId)
  ) {
    throw new Error("conversationId must be a valid Pi session id");
  }
}

function notebookPaths(stateDir: string, conversationId: string): NotebookPaths {
  assertConversationId(conversationId);
  const resolvedStateDir = resolve(stateDir);
  const notebookDir = join(resolvedStateDir, NOTEBOOK_DIRECTORY);
  const file = join(notebookDir, `${conversationId}.json`);
  if (!isPathInside(resolvedStateDir, notebookDir)) {
    throw new Error(`Notebook directory escapes project state: ${notebookDir}`);
  }
  if (!isPathInside(notebookDir, file)) {
    throw new Error(`Notebook file escapes notebook directory: ${file}`);
  }
  return { stateDir: resolvedStateDir, notebookDir, file };
}

function normalizeNotebookTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) throw new Error("Notebook title must not be empty");
  if (title.length > MAX_NOTE_TITLE_CHARS) {
    throw new Error(
      `Notebook title exceeds ${MAX_NOTE_TITLE_CHARS} characters`,
    );
  }
  if (/[\0\r\n]/.test(title)) {
    throw new Error("Notebook title must be a single line without NUL bytes");
  }
  return title;
}

function assertContentBudget(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_NOTE_CONTENT_BYTES) {
    throw new Error(
      `Notebook content exceeds ${MAX_NOTE_CONTENT_BYTES} UTF-8 bytes`,
    );
  }
}

function isCanonicalIsoDate(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function preview(content: string): string {
  const firstNonEmptyLine = content
    .split(/\r\n|\r|\n/)
    .find((line) => line.trim().length > 0)
    ?.trim() ?? "";
  const value = firstNonEmptyLine || content.replace(/\s+/g, " ").trim();
  return truncate(value, PREVIEW_CHARS);
}

function metadata(note: NotebookNote): NotebookNoteMetadata {
  return {
    title: note.title,
    preview: preview(note.content),
    archived: note.archived,
    chars: note.content.length,
    lines: lineCount(note.content),
    updatedAt: note.updatedAt,
  };
}

function statusIncludes(status: NotebookStatus, note: NotebookNote): boolean {
  if (status === "all") return true;
  if (status === "archived") return note.archived;
  return !note.archived;
}

function sortByUpdatedThenTitle<T extends { updatedAt: string; title: string }>(
  values: T[],
): T[] {
  return values.sort((first, second) => {
    const byUpdated = Date.parse(second.updatedAt) - Date.parse(first.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return first.title.localeCompare(second.title);
  });
}

function parseNotebookFile(raw: string, path: string): NotebookNote[] {
  if (Buffer.byteLength(raw, "utf8") > MAX_NOTEBOOK_FILE_BYTES) {
    throw new Error(`Notebook file exceeds its safety limit: ${path}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid notebook file at ${path}: invalid JSON`, {
      cause: error,
    });
  }

  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("notebook must be an object");
    }
    const record = value as Record<string, unknown>;
    const allowedKeys = new Set(["version", "notes"]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`unknown field ${JSON.stringify(key)}`);
      }
    }
    if (record.version !== NOTEBOOK_VERSION) {
      throw new Error(`version must be ${NOTEBOOK_VERSION}`);
    }
    if (!Array.isArray(record.notes)) {
      throw new Error("notes must be an array");
    }
    if (record.notes.length > MAX_NOTE_COUNT) {
      throw new Error(`notes exceeds ${MAX_NOTE_COUNT} entries`);
    }

    const seen = new Set<string>();
    const notes: NotebookNote[] = [];
    for (const [index, rawNote] of record.notes.entries()) {
      if (
        typeof rawNote !== "object"
        || rawNote === null
        || Array.isArray(rawNote)
      ) {
        throw new Error(`note ${index} must be an object`);
      }
      const note = rawNote as Record<string, unknown>;
      const noteKeys = new Set(["title", "content", "archived", "updatedAt"]);
      for (const key of Object.keys(note)) {
        if (!noteKeys.has(key)) {
          throw new Error(
            `note ${index} has unknown field ${JSON.stringify(key)}`,
          );
        }
      }
      if (typeof note.title !== "string") {
        throw new Error(`note ${index} title must be a string`);
      }
      const title = normalizeNotebookTitle(note.title);
      if (title !== note.title) {
        throw new Error(`note ${index} title is not normalized`);
      }
      if (seen.has(title)) {
        throw new Error(`duplicate notebook title: ${title}`);
      }
      seen.add(title);
      if (typeof note.content !== "string") {
        throw new Error(`note ${index} content must be a string`);
      }
      assertContentBudget(note.content);
      if (typeof note.archived !== "boolean") {
        throw new Error(`note ${index} archived must be a boolean`);
      }
      if (
        typeof note.updatedAt !== "string"
        || !isCanonicalIsoDate(note.updatedAt)
      ) {
        throw new Error(
          `note ${index} updatedAt must be a canonical ISO timestamp`,
        );
      }
      notes.push({
        title,
        content: note.content,
        archived: note.archived,
        updatedAt: note.updatedAt,
      });
    }
    return notes;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid notebook file at ${path}: ${detail}`, {
      cause: error,
    });
  }
}

async function assertNotebookDirectoryIfPresent(
  paths: NotebookPaths,
): Promise<boolean> {
  await assertCanonicalOwnedDirectory(paths.stateDir, "Project state directory");
  try {
    await assertCanonicalOwnedDirectory(
      paths.notebookDir,
      "Project notebook directory",
    );
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function ensureNotebookDirectory(paths: NotebookPaths): Promise<void> {
  await assertCanonicalOwnedDirectory(paths.stateDir, "Project state directory");
  await mkdir(paths.notebookDir, { recursive: true });
  await assertCanonicalOwnedDirectory(
    paths.notebookDir,
    "Project notebook directory",
  );
}

async function assertNotebookOwnedFile(
  directory: string,
  filePath: string,
  label: string,
): Promise<Stats> {
  const lexicalPath = resolve(filePath);
  if (!pathsAreIdentical(dirname(lexicalPath), directory)) {
    throw new Error(`${label} escapes notebook directory: ${filePath}`);
  }
  const information = await lstat(lexicalPath);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  const [root, file] = await Promise.all([
    realpath(directory),
    realpath(lexicalPath),
  ]);
  if (!isPathInside(root, file)) {
    throw new Error(`${label} escapes notebook directory: ${filePath}`);
  }
  return information;
}

async function assertNotebookFileIfPresent(
  paths: NotebookPaths,
): Promise<Stats | undefined> {
  const hasDirectory = await assertNotebookDirectoryIfPresent(paths);
  if (!hasDirectory) return;
  const quarantinePrefix = `.${basename(paths.file)}.`;
  const quarantine = (await readdir(paths.notebookDir)).find((name) =>
    name.startsWith(quarantinePrefix) && name.endsWith(".quarantine")
  );
  if (quarantine !== undefined) {
    throw new Error(
      `Notebook mutation quarantine requires recovery: ${join(paths.notebookDir, quarantine)}`,
    );
  }
  try {
    return await assertNotebookOwnedFile(
      paths.notebookDir,
      paths.file,
      "Notebook file",
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

interface LoadedNotebook {
  notes: NotebookNote[];
  information?: Stats;
}

async function loadNotebook(paths: NotebookPaths): Promise<LoadedNotebook> {
  const information = await assertNotebookFileIfPresent(paths);
  if (information === undefined) return { notes: [] };
  const handle = await open(paths.file, "r");
  try {
    const opened = await handle.stat();
    if (!statsAreIdentical(information, opened)) {
      throw new Error(`Notebook file changed while being read: ${paths.file}`);
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const afterRead = await handle.stat();
    const current = await assertNotebookFileIfPresent(paths);
    if (
      current === undefined
      || !statsAreIdentical(information, afterRead)
      || !statsAreIdentical(information, current)
    ) {
      throw new Error(`Notebook file changed while being read: ${paths.file}`);
    }
    return {
      notes: parseNotebookFile(raw, paths.file),
      information,
    };
  } finally {
    await handle.close();
  }
}

async function readNotes(paths: NotebookPaths): Promise<NotebookNote[]> {
  return (await loadNotebook(paths)).notes;
}

function temporaryNotebookPath(filePath: string): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

function quarantineNotebookPath(filePath: string): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.quarantine`,
  );
}

async function writeNewNotebookFile(
  paths: NotebookPaths,
  serialized: string,
): Promise<void> {
  const temporaryPath = temporaryNotebookPath(paths.file);
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    const temporary = await assertNotebookOwnedFile(
      paths.notebookDir,
      temporaryPath,
      "Notebook temporary file",
    );
    await link(temporaryPath, paths.file);
    const published = await assertNotebookOwnedFile(
      paths.notebookDir,
      paths.file,
      "Notebook file",
    );
    if (!statsAreIdentical(temporary, published)) {
      throw new Error(`Notebook file changed while being published: ${paths.file}`);
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

interface QuarantinedNotebookFile {
  originalPath: string;
  quarantinePath: string;
  information: Stats;
}

async function restoreQuarantinedNotebookFile(
  paths: NotebookPaths,
  quarantined: QuarantinedNotebookFile,
): Promise<void> {
  const current = await assertNotebookOwnedFile(
    paths.notebookDir,
    quarantined.quarantinePath,
    "Notebook quarantine",
  );
  if (!statsAreIdentical(quarantined.information, current)) {
    throw new Error(
      `Notebook quarantine changed while it was being recovered: ${quarantined.quarantinePath}`,
    );
  }
  try {
    await link(quarantined.quarantinePath, quarantined.originalPath);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    const original = await assertNotebookOwnedFile(
      paths.notebookDir,
      quarantined.originalPath,
      "Notebook file",
    );
    if (!statsAreIdentical(current, original)) {
      throw new Error(
        `Notebook quarantine remains at ${quarantined.quarantinePath}`,
        { cause: error },
      );
    }
  }
  await unlink(quarantined.quarantinePath);
}

async function quarantineNotebookFile(
  paths: NotebookPaths,
  originalPath: string,
  expected: Stats,
): Promise<QuarantinedNotebookFile> {
  const quarantinePath = quarantineNotebookPath(originalPath);
  let moved: QuarantinedNotebookFile | undefined;
  try {
    await rename(originalPath, quarantinePath);
    const information = await assertNotebookOwnedFile(
      paths.notebookDir,
      quarantinePath,
      "Notebook quarantine",
    );
    moved = { originalPath, quarantinePath, information };
    if (!statsAreIdentical(expected, information)) {
      throw new Error(`Notebook file changed before mutation: ${originalPath}`);
    }
    return moved;
  } catch (error) {
    if (moved !== undefined) {
      try {
        await restoreQuarantinedNotebookFile(paths, moved);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `Notebook mutation failed and recovery could not be completed: ${originalPath}`,
        );
      }
    }
    throw error;
  }
}

async function replaceNotebookFile(
  paths: NotebookPaths,
  expected: Stats,
  serialized: string,
): Promise<void> {
  const quarantined = await quarantineNotebookFile(paths, paths.file, expected);
  let published = false;
  try {
    await writeNewNotebookFile(paths, serialized);
    published = true;
    await unlink(quarantined.quarantinePath);
  } catch (error) {
    if (!published) {
      try {
        await restoreQuarantinedNotebookFile(paths, quarantined);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `Notebook mutation failed and recovery could not be completed: ${paths.file}`,
        );
      }
    }
    throw error;
  }
}

async function deleteNotebookFile(
  paths: NotebookPaths,
  filePath: string,
  expected: Stats,
): Promise<void> {
  const quarantined = await quarantineNotebookFile(paths, filePath, expected);
  let removed = false;
  try {
    await unlink(quarantined.quarantinePath);
    removed = true;
    try {
      await lstat(filePath);
      throw new Error(`Notebook file reappeared while it was being deleted: ${filePath}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  } catch (error) {
    if (!removed) {
      try {
        await restoreQuarantinedNotebookFile(paths, quarantined);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `Notebook mutation failed and recovery could not be completed: ${filePath}`,
        );
      }
    }
    throw error;
  }
}

async function writeNotes(
  paths: NotebookPaths,
  previous: Stats | undefined,
  notes: readonly NotebookNote[],
): Promise<void> {
  const file: NotebookFileV1 = {
    version: NOTEBOOK_VERSION,
    notes: [...notes].sort((first, second) =>
      first.title.localeCompare(second.title)
    ),
  };
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_NOTEBOOK_FILE_BYTES) {
    throw new Error(`Notebook file exceeds its safety limit: ${paths.file}`);
  }

  await ensureNotebookDirectory(paths);
  if (previous === undefined) {
    await writeNewNotebookFile(paths, serialized);
  } else {
    await replaceNotebookFile(paths, previous, serialized);
  }
}

function readSnippet(
  value: string,
  matchIndex: number,
  patternLength: number,
): string {
  const contextChars = Math.max(
    0,
    Math.floor((SNIPPET_CHARS - patternLength) / 2),
  );
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(value.length, start + SNIPPET_CHARS);
  const snippet = value.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < value.length ? "…" : ""}`;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    result += char;
  }
  return result;
}

function formatMetadataLine(note: NotebookNoteMetadata): string {
  const state = note.archived ? "archived" : "active";
  return [
    `- ${note.title} (${state}, ${note.chars} chars,`,
    `${note.lines} lines, updated ${note.updatedAt})`,
  ].join(" ");
}

function formatList(result: NotebookListResult): string {
  if (result.notes.length === 0) {
    return `No ${result.status} notebook notes.`;
  }
  const lines = result.notes.map((note) => [
    formatMetadataLine(note),
    note.preview ? `  ${note.preview}` : undefined,
  ].filter(Boolean).join("\n"));
  if (result.truncated) {
    lines.push("Notebook list truncated; use notebook_grep to narrow results.");
  }
  return lines.join("\n");
}

function formatGrep(result: NotebookGrepResult): string {
  if (result.matches.length === 0) {
    return `No notebook matches for ${JSON.stringify(result.pattern)}.`;
  }
  const lines = result.matches.map((match) => {
    const location = match.field === "title"
      ? `${match.title}:title`
      : `${match.title}:${match.line}`;
    return `${location}: ${match.snippet}`;
  });
  if (result.truncated) {
    lines.push("Notebook grep truncated; use a narrower pattern.");
  }
  return lines.join("\n");
}

function formatRead(result: NotebookReadResult): string {
  const sections = result.notes.map((note) => [
    `# ${note.title}`,
    `Status: ${note.archived ? "archived" : "active"}`,
    `Updated: ${note.updatedAt}`,
    "",
    note.content,
    note.truncated ? "\n[This note was truncated by notebook_read.]" : "",
  ].join("\n"));
  if (result.truncated) {
    sections.push("[notebook_read output truncated; read fewer titles.]");
  }
  return sections.join("\n\n");
}

export class ConversationNotebook {
  private readonly paths: NotebookPaths;
  private readonly queue = new SerialTaskQueue();

  constructor(stateDir: string, conversationId: string) {
    this.paths = notebookPaths(stateDir, conversationId);
  }

  write(input: NotebookWriteInput): Promise<NotebookNoteMetadata> {
    return this.queue.run(async () => {
      const title = normalizeNotebookTitle(input.title);
      const content = input.content;
      if (content !== undefined) assertContentBudget(content);
      if (content === undefined && input.archived === undefined) {
        throw new Error(
          "notebook_write requires content or an archived state change",
        );
      }

      const loaded = await loadNotebook(this.paths);
      const notes = loaded.notes;
      const index = notes.findIndex((note) => note.title === title);
      const updatedAt = new Date().toISOString();
      let next: NotebookNote;
      if (index === -1) {
        if (content === undefined) {
          throw new Error("New notebook notes require content");
        }
        if (notes.length >= MAX_NOTE_COUNT) {
          throw new Error(`Notebook exceeds ${MAX_NOTE_COUNT} notes`);
        }
        next = {
          title,
          content,
          archived: input.archived ?? false,
          updatedAt,
        };
        notes.push(next);
      } else {
        next = {
          ...notes[index]!,
          ...(content === undefined ? {} : { content }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
          updatedAt,
        };
        notes[index] = next;
      }
      await writeNotes(this.paths, loaded.information, notes);
      return metadata(next);
    });
  }

  list(statusInput?: NotebookStatus): Promise<NotebookListResult> {
    return this.queue.run(async () => {
      const status = statusInput ?? "active";
      const notes = sortByUpdatedThenTitle(
        (await readNotes(this.paths))
          .filter((note) => statusIncludes(status, note))
          .map(metadata),
      );
      const truncated = notes.length > MAX_NOTEBOOK_LIST_NOTES;
      return {
        status,
        notes: notes.slice(0, MAX_NOTEBOOK_LIST_NOTES),
        truncated,
      };
    });
  }

  grep(
    pattern: string,
    statusInput?: NotebookStatus,
  ): Promise<NotebookGrepResult> {
    return this.queue.run(async () => {
      if (pattern.length === 0) {
        throw new Error("Notebook grep pattern is required");
      }
      const status = statusInput ?? "active";
      const needle = pattern.toLowerCase();
      const matches: NotebookGrepMatch[] = [];
      let truncated = false;
      const pushMatch = (match: NotebookGrepMatch): void => {
        if (matches.length >= MAX_NOTEBOOK_GREP_MATCHES) {
          truncated = true;
          return;
        }
        matches.push(match);
      };

      const notes = sortByUpdatedThenTitle(
        (await readNotes(this.paths)).filter((note) =>
          statusIncludes(status, note)
        ),
      );
      for (const note of notes) {
        if (truncated) break;
        const titleIndex = note.title.toLowerCase().indexOf(needle);
        if (titleIndex !== -1) {
          pushMatch({
            title: note.title,
            archived: note.archived,
            field: "title",
            snippet: readSnippet(note.title, titleIndex, pattern.length),
            updatedAt: note.updatedAt,
          });
        }
        const lines = note.content.split(/\r\n|\r|\n/);
        for (const [index, line] of lines.entries()) {
          if (truncated) break;
          const matchIndex = line.toLowerCase().indexOf(needle);
          if (matchIndex === -1) continue;
          pushMatch({
            title: note.title,
            archived: note.archived,
            field: "content",
            line: index + 1,
            snippet: readSnippet(line, matchIndex, pattern.length),
            updatedAt: note.updatedAt,
          });
        }
      }

      return { pattern, status, matches, truncated };
    });
  }

  read(titles: readonly string[]): Promise<NotebookReadResult> {
    return this.queue.run(async () => {
      if (titles.length === 0) throw new Error("notebook_read requires titles");
      if (titles.length > MAX_NOTEBOOK_READ_TITLES) {
        throw new Error(
          `notebook_read accepts at most ${MAX_NOTEBOOK_READ_TITLES} titles`,
        );
      }
      const normalizedTitles = titles.map(normalizeNotebookTitle);
      if (new Set(normalizedTitles).size !== normalizedTitles.length) {
        throw new Error("notebook_read titles must be unique");
      }

      const notesByTitle = new Map(
        (await readNotes(this.paths)).map((note) => [note.title, note]),
      );
      const missing = normalizedTitles.filter((title) =>
        !notesByTitle.has(title)
      );
      if (missing.length > 0) {
        throw new Error(`Notebook note not found: ${missing.join(", ")}`);
      }

      let remainingBytes = MAX_NOTEBOOK_READ_BYTES;
      let truncated = false;
      const notes: NotebookReadNote[] = [];
      for (const title of normalizedTitles) {
        const note = notesByTitle.get(title)!;
        const content = takeUtf8Prefix(note.content, remainingBytes);
        const noteTruncated = content !== note.content;
        if (noteTruncated) truncated = true;
        remainingBytes -= Buffer.byteLength(content, "utf8");
        notes.push({
          ...metadata(note),
          content,
          truncated: noteTruncated,
        });
        if (remainingBytes <= 0) {
          truncated = true;
          break;
        }
      }
      return { notes, truncated };
    });
  }
}

export async function deleteConversationNotebook(
  stateDir: string,
  conversationId: string,
): Promise<void> {
  const paths = notebookPaths(stateDir, conversationId);
  const hasDirectory = await assertNotebookDirectoryIfPresent(paths);
  if (!hasDirectory) return;

  const file = await assertNotebookFileIfPresent(paths);
  const temporaryPrefix = `.${basename(paths.file)}.`;
  const entries = await readdir(paths.notebookDir, { withFileTypes: true });
  const staleTemporaryFiles: Array<{ path: string; information: Stats }> = [];
  for (const entry of entries) {
    if (
      !entry.name.startsWith(temporaryPrefix)
      || !entry.name.endsWith(".tmp")
    ) continue;
    const temporaryPath = join(paths.notebookDir, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        `Notebook temporary entry must be a regular file: ${temporaryPath}`,
      );
    }
    staleTemporaryFiles.push({
      path: temporaryPath,
      information: await assertNotebookOwnedFile(
        paths.notebookDir,
        temporaryPath,
        "Notebook temporary entry",
      ),
    });
  }

  if (file !== undefined) {
    await deleteNotebookFile(paths, paths.file, file);
  }
  for (const stale of staleTemporaryFiles) {
    await deleteNotebookFile(paths, stale.path, stale.information);
  }
}

export const notebookResultText = {
  write(note: NotebookNoteMetadata): string {
    return [
      `Notebook note ${JSON.stringify(note.title)} saved.`,
      `Status: ${note.archived ? "archived" : "active"}`,
      `Size: ${note.chars} chars, ${note.lines} lines`,
      `Updated: ${note.updatedAt}`,
    ].join("\n");
  },
  list: formatList,
  grep: formatGrep,
  read: formatRead,
};
