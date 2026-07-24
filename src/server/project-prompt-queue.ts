import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { MAX_PROMPT_CHARACTERS } from "../shared/protocol.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

export const PROJECT_PROMPT_QUEUE_VERSION = 1;
export const MAX_PENDING_PROMPTS_PER_PROJECT = 256;
export const MAX_PENDING_PROMPTS_PER_CONVERSATION = 64;
export const MAX_PENDING_PROMPT_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_PENDING_PROMPT_ATTENTION_REASON_CHARACTERS = 1_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

const uuidSchema = (field: string) =>
  z.string().regex(UUID_PATTERN, `${field} must be a canonical UUID`);

const canonicalTimestampSchema = (field: string) =>
  z.string().refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }, `${field} must be a canonical ISO timestamp`);

const attentionReasonSchema = z.string()
  .min(1)
  .max(MAX_PENDING_PROMPT_ATTENTION_REASON_CHARACTERS)
  .refine((value) => value.trim().length > 0, "attention reason must not be blank");

const promptRecordSchema = z.object({
  version: z.literal(PROJECT_PROMPT_QUEUE_VERSION),
  promptId: uuidSchema("promptId"),
  conversationId: uuidSchema("conversationId"),
  text: z.string().max(MAX_PROMPT_CHARACTERS),
  createdAt: canonicalTimestampSchema("createdAt"),
  state: z.enum(["queued", "dispatching", "attention"]),
  runId: uuidSchema("runId").optional(),
  dispatchedAt: canonicalTimestampSchema("dispatchedAt").optional(),
  reason: attentionReasonSchema.optional(),
  attentionAt: canonicalTimestampSchema("attentionAt").optional(),
}).strict();

const promptInputSchema = z.object({
  promptId: uuidSchema("promptId"),
  conversationId: uuidSchema("conversationId"),
  text: z.string().max(MAX_PROMPT_CHARACTERS),
  createdAt: canonicalTimestampSchema("createdAt"),
}).strict();

const listOptionsSchema = z.object({
  conversationId: uuidSchema("conversationId").optional(),
}).strict();

export interface QueuedProjectPrompt {
  version: typeof PROJECT_PROMPT_QUEUE_VERSION;
  promptId: string;
  conversationId: string;
  text: string;
  createdAt: string;
  state: "queued";
}

export interface DispatchingProjectPrompt extends Omit<QueuedProjectPrompt, "state"> {
  state: "dispatching";
  runId: string;
  dispatchedAt: string;
}

export interface AttentionProjectPrompt extends Omit<QueuedProjectPrompt, "state"> {
  state: "attention";
  reason: string;
  attentionAt: string;
}

export type ProjectPromptRecord =
  | QueuedProjectPrompt
  | DispatchingProjectPrompt
  | AttentionProjectPrompt;

export interface ProjectPromptInput {
  promptId: string;
  conversationId: string;
  text: string;
  createdAt: string;
}

export interface PromptQueuePutResult {
  status: "created" | "existing";
  prompt: ProjectPromptRecord;
}

export interface PromptQueueListOptions {
  conversationId?: string;
}

interface StoredPrompt {
  prompt: ProjectPromptRecord;
  path: string;
  bytes: number;
  information: Stats;
}

interface PromptScan {
  prompts: StoredPrompt[];
  totalBytes: number;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code
  );
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function pathsAreIdentical(first: string, second: string): boolean {
  return pathIdentity(first) === pathIdentity(second);
}

function statsAreIdentical(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.isFile() === second.isFile()
  );
}

function clonePrompt(prompt: ProjectPromptRecord): ProjectPromptRecord {
  return { ...prompt };
}

function serializePrompt(prompt: ProjectPromptRecord): string {
  return `${JSON.stringify(prompt, null, 2)}\n`;
}

function immutablePayload(prompt: ProjectPromptRecord): ProjectPromptInput {
  return {
    promptId: prompt.promptId,
    conversationId: prompt.conversationId,
    text: prompt.text,
    createdAt: prompt.createdAt,
  };
}

function payloadsEqual(
  first: ProjectPromptRecord,
  second: ProjectPromptRecord,
): boolean {
  return JSON.stringify(immutablePayload(first))
    === JSON.stringify(immutablePayload(second));
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const lexicalPath = resolve(path);
  const information = await lstat(lexicalPath);
  if (information.isSymbolicLink()) {
    throw new Error(
      `Prompt queue directory must not be a symbolic link or junction: ${lexicalPath}`,
    );
  }
  if (!information.isDirectory()) {
    throw new Error(`Prompt queue path is not a directory: ${lexicalPath}`);
  }
  const canonicalPath = await realpath(lexicalPath);
  if (!pathsAreIdentical(canonicalPath, lexicalPath)) {
    throw new Error(
      `Prompt queue directory resolves outside its project-owned path: ${lexicalPath} -> ${canonicalPath}`,
    );
  }
}

async function assertOwnedFile(
  directory: string,
  path: string,
): Promise<Stats> {
  const lexicalPath = resolve(path);
  if (!pathsAreIdentical(dirname(lexicalPath), directory)) {
    throw new Error(
      `Prompt queue entry is outside its project-owned directory: ${lexicalPath}`,
    );
  }
  const information = await lstat(lexicalPath);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(
      `Prompt queue entry must be a regular project-owned file: ${lexicalPath}`,
    );
  }
  const canonicalPath = await realpath(lexicalPath);
  if (!pathsAreIdentical(canonicalPath, lexicalPath)) {
    throw new Error(
      `Prompt queue entry resolves outside its project-owned path: ${lexicalPath} -> ${canonicalPath}`,
    );
  }
  return information;
}

/** Parses one strict v1 durable prompt record. */
export function parseProjectPromptRecord(value: unknown): ProjectPromptRecord {
  const raw = promptRecordSchema.parse(value);
  if (raw.text.trim().length === 0) {
    throw new Error("text must not be blank");
  }

  const hasDispatchFields = raw.runId !== undefined || raw.dispatchedAt !== undefined;
  const hasAttentionFields = raw.reason !== undefined || raw.attentionAt !== undefined;
  if (raw.state === "queued") {
    if (hasDispatchFields || hasAttentionFields) {
      throw new Error("queued prompts forbid dispatching and attention fields");
    }
    return {
      version: PROJECT_PROMPT_QUEUE_VERSION,
      promptId: raw.promptId,
      conversationId: raw.conversationId,
      text: raw.text,
      createdAt: raw.createdAt,
      state: "queued",
    };
  }
  if (raw.state === "dispatching") {
    if (raw.runId === undefined || raw.dispatchedAt === undefined) {
      throw new Error(
        "dispatching prompts require runId and dispatchedAt",
      );
    }
    if (hasAttentionFields) {
      throw new Error("dispatching prompts forbid attention fields");
    }
    return {
      version: PROJECT_PROMPT_QUEUE_VERSION,
      promptId: raw.promptId,
      conversationId: raw.conversationId,
      text: raw.text,
      createdAt: raw.createdAt,
      state: "dispatching",
      runId: raw.runId,
      dispatchedAt: raw.dispatchedAt,
    };
  }
  if (raw.reason === undefined || raw.attentionAt === undefined) {
    throw new Error("attention prompts require reason and attentionAt");
  }
  if (hasDispatchFields) {
    throw new Error("attention prompts forbid dispatching fields");
  }
  return {
    version: PROJECT_PROMPT_QUEUE_VERSION,
    promptId: raw.promptId,
    conversationId: raw.conversationId,
    text: raw.text,
    createdAt: raw.createdAt,
    state: "attention",
    reason: raw.reason,
    attentionAt: raw.attentionAt,
  };
}

/** Constructs a strict queued v1 prompt record from its immutable payload. */
export function createQueuedProjectPrompt(
  input: ProjectPromptInput,
): QueuedProjectPrompt {
  const payload = promptInputSchema.parse(input);
  return parseProjectPromptRecord({
    version: PROJECT_PROMPT_QUEUE_VERSION,
    ...payload,
    state: "queued",
  }) as QueuedProjectPrompt;
}

/**
 * Durable project-local queue for user prompts that have not yet been dispatched.
 * The caller supplies the already-owned `.piweb/pending-prompts` directory.
 */
export class ProjectPromptQueue {
  readonly directory: string;

  private readonly operations = new SerialTaskQueue();

  private constructor(directory: string) {
    this.directory = resolve(directory);
  }

  static async open(directory: string): Promise<ProjectPromptQueue> {
    const queue = new ProjectPromptQueue(directory);
    await assertOwnedDirectory(dirname(queue.directory));
    try {
      await mkdir(queue.directory);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await assertOwnedDirectory(queue.directory);
    await queue.scan();
    return queue;
  }

  put(input: ProjectPromptInput): Promise<PromptQueuePutResult> {
    return this.operations.run(async () => {
      const queued = createQueuedProjectPrompt(input);
      const scan = await this.scan();
      const existing = scan.prompts.find(
        ({ prompt }) => prompt.promptId === queued.promptId,
      );
      if (existing !== undefined) {
        if (!payloadsEqual(existing.prompt, queued)) {
          throw new Error(`Prompt queue conflict for promptId ${queued.promptId}`);
        }
        return { status: "existing", prompt: clonePrompt(existing.prompt) };
      }

      this.assertCapacityForCreate(scan, queued);
      const path = this.pathForPrompt(queued.promptId);
      try {
        await this.writeNewAtomically(path, serializePrompt(queued));
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const raced = await this.scan();
        const match = raced.prompts.find(
          ({ prompt }) => prompt.promptId === queued.promptId,
        );
        if (match === undefined || !payloadsEqual(match.prompt, queued)) {
          throw new Error(
            `Prompt queue conflict for promptId ${queued.promptId}`,
            { cause: error },
          );
        }
        return { status: "existing", prompt: clonePrompt(match.prompt) };
      }
      return { status: "created", prompt: clonePrompt(queued) };
    });
  }

  list(options: PromptQueueListOptions = {}): Promise<ProjectPromptRecord[]> {
    return this.operations.run(async () => {
      const filter = listOptionsSchema.parse(options);
      const scan = await this.scan();
      return scan.prompts
        .map(({ prompt }) => prompt)
        .filter((prompt) => (
          filter.conversationId === undefined
          || prompt.conversationId === filter.conversationId
        ))
        .sort((first, second) => {
          const byCreatedAt = Date.parse(first.createdAt) - Date.parse(second.createdAt);
          if (byCreatedAt !== 0) return byCreatedAt;
          return first.promptId.localeCompare(second.promptId);
        })
        .map(clonePrompt);
    });
  }

  /** Claims one exact queued prompt for a specific dispatch run. */
  markDispatching(
    promptId: string,
    conversationId: string,
    runId: string,
    dispatchedAt: string,
  ): Promise<DispatchingProjectPrompt> {
    return this.operations.run(async () => {
      uuidSchema("promptId").parse(promptId);
      uuidSchema("conversationId").parse(conversationId);
      uuidSchema("runId").parse(runId);
      canonicalTimestampSchema("dispatchedAt").parse(dispatchedAt);
      const stored = await this.requireExactPrompt(promptId, conversationId);
      if (stored.prompt.state !== "queued") {
        throw new Error(`Prompt is not queued: ${promptId}`);
      }
      const next = parseProjectPromptRecord({
        ...immutablePayload(stored.prompt),
        version: PROJECT_PROMPT_QUEUE_VERSION,
        state: "dispatching",
        runId,
        dispatchedAt,
      });
      await this.replaceStoredPrompt(stored, next);
      return clonePrompt(next) as DispatchingProjectPrompt;
    });
  }

  /**
   * Returns a claim to queued only after a known deterministic dispatch rejection.
   * The exact claim runId is required so a later dispatch cannot be rolled back.
   */
  requeueAfterDeterministicRejection(
    promptId: string,
    conversationId: string,
    runId: string,
  ): Promise<QueuedProjectPrompt> {
    return this.operations.run(async () => {
      uuidSchema("promptId").parse(promptId);
      uuidSchema("conversationId").parse(conversationId);
      uuidSchema("runId").parse(runId);
      const stored = await this.requireExactPrompt(promptId, conversationId);
      if (
        stored.prompt.state !== "dispatching"
        || stored.prompt.runId !== runId
      ) {
        throw new Error(`Prompt is not dispatching for runId ${runId}: ${promptId}`);
      }
      const next = createQueuedProjectPrompt(immutablePayload(stored.prompt));
      await this.replaceStoredPrompt(stored, next);
      return clonePrompt(next) as QueuedProjectPrompt;
    });
  }

  /** Records an uncertain dispatch failure for explicit host reconciliation. */
  markAttentionAfterUncertainFailure(
    promptId: string,
    conversationId: string,
    runId: string,
    reason: string,
    attentionAt: string,
  ): Promise<AttentionProjectPrompt> {
    return this.operations.run(async () => {
      uuidSchema("promptId").parse(promptId);
      uuidSchema("conversationId").parse(conversationId);
      uuidSchema("runId").parse(runId);
      attentionReasonSchema.parse(reason);
      canonicalTimestampSchema("attentionAt").parse(attentionAt);
      const stored = await this.requireExactPrompt(promptId, conversationId);
      if (
        stored.prompt.state !== "dispatching"
        || stored.prompt.runId !== runId
      ) {
        throw new Error(`Prompt is not dispatching for runId ${runId}: ${promptId}`);
      }
      const next = parseProjectPromptRecord({
        ...immutablePayload(stored.prompt),
        version: PROJECT_PROMPT_QUEUE_VERSION,
        state: "attention",
        reason,
        attentionAt,
      });
      await this.replaceStoredPrompt(stored, next);
      return clonePrompt(next) as AttentionProjectPrompt;
    });
  }

  /** Withdraws only an exact prompt that has not crossed the dispatch boundary. */
  withdrawQueued(promptId: string, conversationId: string): Promise<boolean> {
    return this.operations.run(async () => {
      uuidSchema("promptId").parse(promptId);
      uuidSchema("conversationId").parse(conversationId);
      const scan = await this.scan();
      const stored = scan.prompts.find(
        ({ prompt }) => prompt.promptId === promptId,
      );
      if (stored === undefined) return false;
      if (stored.prompt.conversationId !== conversationId) {
        throw new Error(`Prompt conversation identity does not match: ${promptId}`);
      }
      if (stored.prompt.state !== "queued") {
        throw new Error(`Only queued prompts can be withdrawn: ${promptId}`);
      }
      await this.assertStoredFileUnchanged(stored);
      await unlink(stored.path);
      return true;
    });
  }

  /**
   * Host-only cleanup after terminal dispatch reconciliation. Unlike withdrawal,
   * this deliberately permits removing an exact dispatching or attention record.
   * Queued records remain withdraw-only.
   */
  removeForHostCleanup(promptId: string, conversationId: string): Promise<boolean> {
    return this.operations.run(async () => {
      uuidSchema("promptId").parse(promptId);
      uuidSchema("conversationId").parse(conversationId);
      const scan = await this.scan();
      const stored = scan.prompts.find(
        ({ prompt }) => prompt.promptId === promptId,
      );
      if (stored === undefined) return false;
      if (stored.prompt.conversationId !== conversationId) {
        throw new Error(`Prompt conversation identity does not match: ${promptId}`);
      }
      if (stored.prompt.state === "queued") {
        throw new Error(`Queued prompts must be withdrawn, not host-cleaned: ${promptId}`);
      }
      await this.assertStoredFileUnchanged(stored);
      await unlink(stored.path);
      return true;
    });
  }

  private async requireExactPrompt(
    promptId: string,
    conversationId: string,
  ): Promise<StoredPrompt> {
    const scan = await this.scan();
    const stored = scan.prompts.find(({ prompt }) => prompt.promptId === promptId);
    if (stored === undefined) {
      throw new Error(`Prompt not found: ${promptId}`);
    }
    if (stored.prompt.conversationId !== conversationId) {
      throw new Error(`Prompt conversation identity does not match: ${promptId}`);
    }
    return stored;
  }

  private pathForPrompt(promptId: string): string {
    return join(this.directory, `${promptId}.json`);
  }

  private async scan(): Promise<PromptScan> {
    await assertOwnedDirectory(this.directory);
    const namesBefore = (await readdir(this.directory)).sort();
    if (namesBefore.length > MAX_PENDING_PROMPTS_PER_PROJECT) {
      throw new Error("Prompt queue project entry limit exceeded");
    }

    const prompts: StoredPrompt[] = [];
    const promptIds = new Set<string>();
    const conversationCounts = new Map<string, number>();
    let totalBytes = 0;
    for (const name of namesBefore) {
      const matched = PROMPT_FILE_PATTERN.exec(name);
      if (matched === null) {
        throw new Error(`Invalid prompt queue entry name: ${name}`);
      }
      const path = join(this.directory, name);
      const information = await assertOwnedFile(this.directory, path);
      totalBytes += information.size;
      if (totalBytes > MAX_PENDING_PROMPT_TOTAL_BYTES) {
        throw new Error(
          `Prompt queue total byte limit exceeded: ${MAX_PENDING_PROMPT_TOTAL_BYTES}`,
        );
      }
      const raw = await readFile(path, "utf8");
      const informationAfterRead = await lstat(path);
      if (!statsAreIdentical(information, informationAfterRead)) {
        throw new Error(`Prompt queue entry changed while scanning: ${path}`);
      }
      if (!raw.endsWith("\n")) {
        throw new Error(`Prompt queue entry must end with a newline: ${path}`);
      }

      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Prompt queue entry has invalid JSON: ${path}`, {
          cause: error,
        });
      }
      let prompt: ProjectPromptRecord;
      try {
        prompt = parseProjectPromptRecord(value);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid prompt queue record at ${path}: ${detail}`, {
          cause: error,
        });
      }
      if (prompt.promptId !== matched[1]) {
        throw new Error(
          `Prompt queue filename identity does not match promptId ${prompt.promptId}: ${path}`,
        );
      }
      if (promptIds.has(prompt.promptId)) {
        throw new Error(`Duplicate prompt queue identity: ${prompt.promptId}`);
      }
      promptIds.add(prompt.promptId);
      const conversationCount =
        (conversationCounts.get(prompt.conversationId) ?? 0) + 1;
      if (conversationCount > MAX_PENDING_PROMPTS_PER_CONVERSATION) {
        throw new Error(
          `Prompt queue conversation limit exceeded for ${prompt.conversationId}: ${MAX_PENDING_PROMPTS_PER_CONVERSATION}`,
        );
      }
      conversationCounts.set(prompt.conversationId, conversationCount);
      prompts.push({ prompt, path, bytes: information.size, information });
    }

    const namesAfter = (await readdir(this.directory)).sort();
    if (
      namesAfter.length !== namesBefore.length
      || namesAfter.some((name, index) => name !== namesBefore[index])
    ) {
      throw new Error("Prompt queue directory changed while scanning");
    }
    await assertOwnedDirectory(this.directory);
    return { prompts, totalBytes };
  }

  private assertCapacityForCreate(
    scan: PromptScan,
    prompt: QueuedProjectPrompt,
  ): void {
    if (scan.prompts.length >= MAX_PENDING_PROMPTS_PER_PROJECT) {
      throw new Error(
        `Prompt queue project limit exceeded: ${MAX_PENDING_PROMPTS_PER_PROJECT}`,
      );
    }
    const conversationCount = scan.prompts.filter(
      ({ prompt: existing }) => existing.conversationId === prompt.conversationId,
    ).length;
    if (conversationCount >= MAX_PENDING_PROMPTS_PER_CONVERSATION) {
      throw new Error(
        `Prompt queue conversation limit exceeded for ${prompt.conversationId}: ${MAX_PENDING_PROMPTS_PER_CONVERSATION}`,
      );
    }
    if (
      scan.totalBytes + Buffer.byteLength(serializePrompt(prompt), "utf8")
      > MAX_PENDING_PROMPT_TOTAL_BYTES
    ) {
      throw new Error(
        `Prompt queue total byte limit exceeded: ${MAX_PENDING_PROMPT_TOTAL_BYTES}`,
      );
    }
  }

  private async replaceStoredPrompt(
    stored: StoredPrompt,
    next: ProjectPromptRecord,
  ): Promise<void> {
    const nextBytes = Buffer.byteLength(serializePrompt(next), "utf8");
    const scan = await this.scan();
    if (scan.totalBytes - stored.bytes + nextBytes > MAX_PENDING_PROMPT_TOTAL_BYTES) {
      throw new Error(
        `Prompt queue total byte limit exceeded: ${MAX_PENDING_PROMPT_TOTAL_BYTES}`,
      );
    }
    await this.assertStoredFileUnchanged(stored);
    await this.replaceAtomically(stored.path, serializePrompt(next));
  }

  private async writeNewAtomically(
    targetPath: string,
    content: string,
  ): Promise<void> {
    const temporaryPath = this.temporaryPath(targetPath);
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
      await link(temporaryPath, targetPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async replaceAtomically(
    targetPath: string,
    content: string,
  ): Promise<void> {
    const temporaryPath = this.temporaryPath(targetPath);
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private temporaryPath(targetPath: string): string {
    return join(
      dirname(this.directory),
      `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
  }

  private async assertStoredFileUnchanged(stored: StoredPrompt): Promise<void> {
    const current = await assertOwnedFile(this.directory, stored.path);
    if (!statsAreIdentical(stored.information, current)) {
      throw new Error(`Prompt queue entry changed before mutation: ${stored.path}`);
    }
  }
}
