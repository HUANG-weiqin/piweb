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
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type NotebookMutationOperation = "create" | "replace" | "delete";
type NotebookArtifactStage = "tmp" | "quarantine";

interface NotebookArtifact {
  path: string;
  information: Stats;
  operation: NotebookMutationOperation;
  transactionId: string;
  stage: NotebookArtifactStage;
}

interface NotebookOperationQueue {
  queue: SerialTaskQueue;
  pending: number;
}

const notebookOperationQueues = new Map<string, NotebookOperationQueue>();

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

function notebookArtifactPrefix(paths: NotebookPaths): string {
  return `.${basename(paths.file)}.`;
}

function parseNotebookArtifact(
  paths: NotebookPaths,
  name: string,
): Omit<NotebookArtifact, "path" | "information"> | undefined {
  const prefix = notebookArtifactPrefix(paths);
  if (!name.startsWith(prefix)) return;
  const match = /^(create|replace|delete)\.([^.]+)\.(tmp|quarantine)$/.exec(
    name.slice(prefix.length),
  );
  if (match === null || !UUID_PATTERN.test(match[2]!)) {
    throw new Error(
      `Invalid legacy notebook mutation artifact: ${join(paths.notebookDir, name)}`,
    );
  }
  return {
    operation: match[1]! as NotebookMutationOperation,
    transactionId: match[2]!,
    stage: match[3]! as NotebookArtifactStage,
  };
}

async function listNotebookArtifacts(
  paths: NotebookPaths,
): Promise<NotebookArtifact[]> {
  if (!await assertNotebookDirectoryIfPresent(paths)) return [];
  const artifacts: NotebookArtifact[] = [];
  for (const entry of await readdir(paths.notebookDir, { withFileTypes: true })) {
    const parsed = parseNotebookArtifact(paths, entry.name);
    if (parsed === undefined) continue;
    const path = join(paths.notebookDir, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Notebook mutation artifact must be a regular file: ${path}`);
    }
    artifacts.push({
      ...parsed,
      path,
      information: await assertNotebookOwnedFile(
        paths.notebookDir,
        path,
        "Notebook mutation artifact",
      ),
    });
  }
  return artifacts;
}

async function notebookOwnedFileIfPresent(
  paths: NotebookPaths,
  filePath: string,
  label: string,
): Promise<Stats | undefined> {
  try {
    return await assertNotebookOwnedFile(paths.notebookDir, filePath, label);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

async function assertNotebookFileIfPresent(
  paths: NotebookPaths,
): Promise<Stats | undefined> {
  if (!await assertNotebookDirectoryIfPresent(paths)) return;
  const artifacts = await listNotebookArtifacts(paths);
  if (artifacts.length > 0) {
    throw new Error(
      `Notebook mutation artifacts require recovery: ${artifacts[0]!.path}`,
    );
  }
  return notebookOwnedFileIfPresent(paths, paths.file, "Notebook file");
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

function notebookArtifactPath(
  filePath: string,
  operation: NotebookMutationOperation,
  transactionId: string,
  stage: NotebookArtifactStage,
): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${operation}.${transactionId}.${stage}`,
  );
}

async function assertNotebookArtifactCurrent(
  paths: NotebookPaths,
  artifact: NotebookArtifact,
): Promise<Stats> {
  const current = await assertNotebookOwnedFile(
    paths.notebookDir,
    artifact.path,
    "Notebook mutation artifact",
  );
  if (!statsAreIdentical(artifact.information, current)) {
    throw new Error(`Notebook mutation artifact changed: ${artifact.path}`);
  }
  return current;
}

async function unlinkNotebookArtifact(
  paths: NotebookPaths,
  artifact: NotebookArtifact,
): Promise<void> {
  await assertNotebookArtifactCurrent(paths, artifact);
  await unlink(artifact.path);
}

async function restoreNotebookQuarantine(
  paths: NotebookPaths,
  quarantine: NotebookArtifact,
): Promise<void> {
  const current = await assertNotebookArtifactCurrent(paths, quarantine);
  try {
    await link(quarantine.path, paths.file);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  const restored = await assertNotebookOwnedFile(
    paths.notebookDir,
    paths.file,
    "Notebook file",
  );
  if (!statsAreIdentical(current, restored)) {
    throw new Error(`Notebook recovery target changed: ${paths.file}`);
  }
}

async function recoverCreateArtifact(
  paths: NotebookPaths,
  temporary: NotebookArtifact,
): Promise<void> {
  const current = await notebookOwnedFileIfPresent(
    paths,
    paths.file,
    "Notebook file",
  );
  if (
    current !== undefined
    && !statsAreIdentical(temporary.information, current)
  ) {
    throw new Error(
      `Notebook create artifact conflicts with published file: ${paths.file}`,
    );
  }
  await unlinkNotebookArtifact(paths, temporary);
}

async function recoverReplaceArtifacts(
  paths: NotebookPaths,
  temporary: NotebookArtifact | undefined,
  quarantine: NotebookArtifact | undefined,
): Promise<void> {
  if (temporary === undefined) {
    throw new Error("Notebook replace quarantine has no matching temporary");
  }
  const current = await notebookOwnedFileIfPresent(
    paths,
    paths.file,
    "Notebook file",
  );
  if (quarantine === undefined) {
    if (current === undefined) {
      throw new Error(
        `Notebook replace temporary has no original file: ${paths.file}`,
      );
    }
    await unlinkNotebookArtifact(paths, temporary);
    return;
  }

  const temporaryCurrent = await assertNotebookArtifactCurrent(paths, temporary);
  const quarantineCurrent = await assertNotebookArtifactCurrent(paths, quarantine);
  if (statsAreIdentical(temporaryCurrent, quarantineCurrent)) {
    throw new Error(
      `Notebook replace artifacts share an inode: ${paths.file}`,
    );
  }
  if (current === undefined) {
    await restoreNotebookQuarantine(paths, quarantine);
  } else if (
    !statsAreIdentical(temporaryCurrent, current)
    && !statsAreIdentical(quarantineCurrent, current)
  ) {
    throw new Error(
      `Notebook replace artifacts conflict with published file: ${paths.file}`,
    );
  }
  await unlinkNotebookArtifact(paths, quarantine);
  await unlinkNotebookArtifact(paths, temporary);
}

async function recoverDeleteArtifacts(
  paths: NotebookPaths,
  temporary: NotebookArtifact | undefined,
  quarantine: NotebookArtifact | undefined,
): Promise<void> {
  const current = await notebookOwnedFileIfPresent(
    paths,
    paths.file,
    "Notebook file",
  );
  if (temporary === undefined) {
    throw new Error("Notebook delete quarantine has no matching temporary");
  }
  const temporaryCurrent = await assertNotebookArtifactCurrent(paths, temporary);
  if (quarantine === undefined) {
    if (current === undefined) {
      throw new Error(
        `Notebook delete temporary has no quarantine evidence: ${paths.file}`,
      );
    }
    if (!statsAreIdentical(temporaryCurrent, current)) {
      throw new Error(
        `Notebook delete temporary conflicts with original file: ${paths.file}`,
      );
    }
    await unlinkNotebookArtifact(paths, temporary);
    return;
  }

  const quarantineCurrent = await assertNotebookArtifactCurrent(paths, quarantine);
  if (
    current !== undefined
    || !statsAreIdentical(temporaryCurrent, quarantineCurrent)
  ) {
    throw new Error(
      `Notebook delete artifacts conflict with expected file: ${paths.file}`,
    );
  }
  await unlinkNotebookArtifact(paths, temporary);
  await unlinkNotebookArtifact(paths, quarantine);
}

async function recoverNotebookArtifacts(paths: NotebookPaths): Promise<void> {
  const artifacts = await listNotebookArtifacts(paths);
  if (artifacts.length === 0) return;

  const groups = new Map<string, NotebookArtifact[]>();
  for (const artifact of artifacts) {
    const key = `${artifact.operation}\0${artifact.transactionId}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [artifact]);
    else group.push(artifact);
  }
  if (groups.size !== 1) {
    throw new Error("Notebook recovery found multiple mutation transactions");
  }
  const group = [...groups.values()][0]!;
  const operation = group[0]!.operation;
  const temporary = group.filter(({ stage }) => stage === "tmp");
  const quarantine = group.filter(({ stage }) => stage === "quarantine");
  if (temporary.length > 1 || quarantine.length > 1) {
    throw new Error("Notebook recovery found duplicate mutation artifacts");
  }

  if (operation === "create") {
    if (temporary.length !== 1 || quarantine.length !== 0) {
      throw new Error("Invalid notebook create mutation artifacts");
    }
    await recoverCreateArtifact(paths, temporary[0]!);
  } else if (operation === "replace") {
    await recoverReplaceArtifacts(paths, temporary[0], quarantine[0]);
  } else {
    await recoverDeleteArtifacts(paths, temporary[0], quarantine[0]);
  }
  if ((await listNotebookArtifacts(paths)).length !== 0) {
    throw new Error("Notebook recovery could not clear mutation artifacts");
  }
}

function runNotebookOperation<T>(
  paths: NotebookPaths,
  operation: () => Promise<T> | T,
): Promise<T> {
  const key = pathIdentity(paths.file);
  let entry = notebookOperationQueues.get(key);
  if (entry === undefined) {
    entry = { queue: new SerialTaskQueue(), pending: 0 };
    notebookOperationQueues.set(key, entry);
  }
  entry.pending++;
  return entry.queue.run(async () => {
    await recoverNotebookArtifacts(paths);
    try {
      return await operation();
    } catch (error) {
      try {
        await recoverNotebookArtifacts(paths);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `Notebook operation failed and recovery could not be completed: ${paths.file}`,
        );
      }
      throw error;
    }
  }).finally(() => {
    entry!.pending--;
    if (entry!.pending === 0) notebookOperationQueues.delete(key);
  });
}

interface StagedNotebookFile extends NotebookArtifact {
  stage: "tmp";
}

class NotebookQuarantineProofError extends Error {
  constructor(
    operation: NotebookMutationOperation,
    cause: unknown,
  ) {
    super(`Notebook ${operation} quarantine could not be proven`, { cause });
  }
}

async function stageNotebookFile(
  paths: NotebookPaths,
  serialized: string,
  operation: "create" | "replace",
): Promise<StagedNotebookFile> {
  const transactionId = randomUUID();
  const path = notebookArtifactPath(paths.file, operation, transactionId, "tmp");
  await writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
  return {
    path,
    information: await assertNotebookOwnedFile(
      paths.notebookDir,
      path,
      "Notebook temporary file",
    ),
    operation,
    transactionId,
    stage: "tmp",
  };
}

async function stageDeleteGuard(
  paths: NotebookPaths,
  expected: Stats,
): Promise<NotebookArtifact> {
  const transactionId = randomUUID();
  const path = notebookArtifactPath(paths.file, "delete", transactionId, "tmp");
  await link(paths.file, path);
  const [temporary, current] = await Promise.all([
    assertNotebookOwnedFile(paths.notebookDir, path, "Notebook delete temporary"),
    assertNotebookOwnedFile(paths.notebookDir, paths.file, "Notebook file"),
  ]);
  if (
    !statsAreIdentical(expected, temporary)
    || !statsAreIdentical(expected, current)
  ) {
    throw new Error(`Notebook file changed before mutation: ${paths.file}`);
  }
  return {
    path,
    information: temporary,
    operation: "delete",
    transactionId,
    stage: "tmp",
  };
}

async function quarantineNotebookFile(
  paths: NotebookPaths,
  expected: Stats,
  operation: "replace" | "delete",
  transactionId: string,
): Promise<NotebookArtifact> {
  const path = notebookArtifactPath(
    paths.file,
    operation,
    transactionId,
    "quarantine",
  );
  await rename(paths.file, path);
  let information: Stats;
  try {
    information = await assertNotebookOwnedFile(
      paths.notebookDir,
      path,
      "Notebook quarantine",
    );
  } catch (error) {
    throw new NotebookQuarantineProofError(operation, error);
  }
  const quarantine: NotebookArtifact = {
    path,
    information,
    operation,
    transactionId,
    stage: "quarantine",
  };
  if (!statsAreIdentical(expected, information)) {
    throw new Error(`Notebook file changed before mutation: ${paths.file}`);
  }
  return quarantine;
}

async function recoverPublishedNotebook(
  paths: NotebookPaths,
  staged: StagedNotebookFile,
  error: unknown,
): Promise<void> {
  try {
    await recoverNotebookArtifacts(paths);
    const current = await notebookOwnedFileIfPresent(
      paths,
      paths.file,
      "Notebook file",
    );
    if (
      current === undefined
      || !statsAreIdentical(staged.information, current)
    ) {
      throw new Error(`Notebook publication could not be proven: ${paths.file}`);
    }
  } catch (recoveryError) {
    throw new AggregateError(
      [error, recoveryError],
      `Notebook committed mutation could not be completed: ${paths.file}`,
    );
  }
}

async function publishStagedNotebookFile(
  paths: NotebookPaths,
  staged: StagedNotebookFile,
): Promise<void> {
  await link(staged.path, paths.file);
  try {
    const [temporary, published] = await Promise.all([
      assertNotebookArtifactCurrent(paths, staged),
      assertNotebookOwnedFile(paths.notebookDir, paths.file, "Notebook file"),
    ]);
    if (!statsAreIdentical(temporary, published)) {
      throw new Error(`Notebook file changed while being published: ${paths.file}`);
    }
  } catch (error) {
    await recoverPublishedNotebook(paths, staged, error);
  }
}

async function cleanPublishedNotebookArtifacts(
  paths: NotebookPaths,
  staged: StagedNotebookFile,
  artifacts: readonly NotebookArtifact[],
): Promise<void> {
  try {
    for (const artifact of artifacts) {
      await unlinkNotebookArtifact(paths, artifact);
    }
  } catch (error) {
    await recoverPublishedNotebook(paths, staged, error);
  }
}

async function writeNewNotebookFile(
  paths: NotebookPaths,
  serialized: string,
): Promise<void> {
  const staged = await stageNotebookFile(paths, serialized, "create");
  await publishStagedNotebookFile(paths, staged);
  await cleanPublishedNotebookArtifacts(paths, staged, [staged]);
}

async function replaceNotebookFile(
  paths: NotebookPaths,
  expected: Stats,
  serialized: string,
): Promise<void> {
  const staged = await stageNotebookFile(paths, serialized, "replace");
  const quarantined = await quarantineNotebookFile(
    paths,
    expected,
    "replace",
    staged.transactionId,
  );
  await publishStagedNotebookFile(paths, staged);
  await cleanPublishedNotebookArtifacts(paths, staged, [quarantined, staged]);
}

async function recoverDeletedNotebook(
  paths: NotebookPaths,
  error: unknown,
): Promise<void> {
  try {
    await recoverNotebookArtifacts(paths);
    if (await notebookOwnedFileIfPresent(paths, paths.file, "Notebook file") !== undefined) {
      throw new Error(`Notebook file reappeared while being deleted: ${paths.file}`);
    }
  } catch (recoveryError) {
    throw new AggregateError(
      [error, recoveryError],
      `Notebook committed deletion could not be completed: ${paths.file}`,
    );
  }
}

async function recoverDeleteQuarantineCleanup(
  paths: NotebookPaths,
  temporary: NotebookArtifact,
  quarantine: NotebookArtifact,
  error: unknown,
): Promise<void> {
  try {
    const current = await notebookOwnedFileIfPresent(
      paths,
      quarantine.path,
      "Notebook deletion quarantine",
    );
    if (current === undefined) {
      await recoverDeletedNotebook(paths, error);
      return;
    }
    if (!statsAreIdentical(quarantine.information, current)) {
      throw new Error(`Notebook deletion quarantine changed: ${quarantine.path}`);
    }
    const existingTemporary = await notebookOwnedFileIfPresent(
      paths,
      temporary.path,
      "Notebook delete temporary",
    );
    if (existingTemporary !== undefined) {
      throw new Error(`Notebook delete temporary changed: ${temporary.path}`);
    }
    const provisionalTransactionId = randomUUID();
    const provisionalPath = notebookArtifactPath(
      paths.file,
      "delete",
      provisionalTransactionId,
      "tmp",
    );
    await link(quarantine.path, provisionalPath);
    const [provisional] = await Promise.all([
      assertNotebookOwnedFile(
        paths.notebookDir,
        provisionalPath,
        "Notebook provisional delete temporary",
      ),
      assertNotebookArtifactCurrent(paths, quarantine),
    ]);
    if (!statsAreIdentical(quarantine.information, provisional)) {
      throw new Error(`Notebook deletion quarantine changed: ${quarantine.path}`);
    }
    await link(provisionalPath, temporary.path);
    const [restoredTemporary, , restoredProvisional] = await Promise.all([
      assertNotebookOwnedFile(
        paths.notebookDir,
        temporary.path,
        "Notebook delete temporary",
      ),
      assertNotebookArtifactCurrent(paths, quarantine),
      assertNotebookOwnedFile(
        paths.notebookDir,
        provisionalPath,
        "Notebook provisional delete temporary",
      ),
    ]);
    if (
      !statsAreIdentical(quarantine.information, restoredTemporary)
      || !statsAreIdentical(quarantine.information, restoredProvisional)
    ) {
      throw new Error(`Notebook delete temporary changed: ${temporary.path}`);
    }
    const provisionalArtifact: NotebookArtifact = {
      path: provisionalPath,
      information: provisional,
      operation: "delete",
      transactionId: provisionalTransactionId,
      stage: "tmp",
    };
    try {
      await unlinkNotebookArtifact(paths, provisionalArtifact);
    } catch (cleanupError) {
      if (await notebookOwnedFileIfPresent(
        paths,
        provisionalPath,
        "Notebook provisional delete temporary",
      ) === undefined) {
        await link(temporary.path, provisionalPath);
        const restoredProvisional = await assertNotebookOwnedFile(
          paths.notebookDir,
          provisionalPath,
          "Notebook provisional delete temporary",
        );
        if (!statsAreIdentical(quarantine.information, restoredProvisional)) {
          throw new Error(`Notebook provisional delete temporary changed: ${provisionalPath}`);
        }
      }
      throw cleanupError;
    }
    await recoverDeletedNotebook(paths, error);
  } catch (recoveryError) {
    throw new AggregateError(
      [error, recoveryError],
      `Notebook committed deletion could not be completed: ${paths.file}`,
    );
  }
}

async function deleteNotebookFile(
  paths: NotebookPaths,
  expected: Stats,
): Promise<void> {
  const temporary = await stageDeleteGuard(paths, expected);
  let quarantined: NotebookArtifact;
  try {
    quarantined = await quarantineNotebookFile(
      paths,
      expected,
      "delete",
      temporary.transactionId,
    );
  } catch (error) {
    if (!(error instanceof NotebookQuarantineProofError)) throw error;
    await recoverDeletedNotebook(paths, error);
    return;
  }
  try {
    await unlinkNotebookArtifact(paths, temporary);
  } catch (error) {
    await recoverDeletedNotebook(paths, error);
    return;
  }
  try {
    await unlinkNotebookArtifact(paths, quarantined);
  } catch (error) {
    await recoverDeleteQuarantineCleanup(paths, temporary, quarantined, error);
    return;
  }
  if (await notebookOwnedFileIfPresent(paths, paths.file, "Notebook file") !== undefined) {
    throw new Error(`Notebook file reappeared while being deleted: ${paths.file}`);
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

  constructor(stateDir: string, conversationId: string) {
    this.paths = notebookPaths(stateDir, conversationId);
  }

  write(input: NotebookWriteInput): Promise<NotebookNoteMetadata> {
    return runNotebookOperation(this.paths, async () => {
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
    return runNotebookOperation(this.paths, async () => {
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
    return runNotebookOperation(this.paths, async () => {
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
    return runNotebookOperation(this.paths, async () => {
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

export function deleteConversationNotebook(
  stateDir: string,
  conversationId: string,
): Promise<void> {
  const paths = notebookPaths(stateDir, conversationId);
  return runNotebookOperation(paths, async () => {
    if (!await assertNotebookDirectoryIfPresent(paths)) return;
    const file = await assertNotebookFileIfPresent(paths);
    if (file !== undefined) await deleteNotebookFile(paths, file);
  });
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
