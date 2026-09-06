import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_META_CUSTOM_TYPE,
  createConversationMessageEntry,
  createMessageDeliveryReceiptEntry,
  createRunSettlementEntry,
  createTemporaryReturnReceiptEntry,
  type ConversationMeta,
} from "./conversation-meta.js";
import { ConversationNotebook } from "./conversation-notebook.js";
import { ProjectStore, ProjectStoreRegistry } from "./project-store.js";

const temporaryDirectories: string[] = [];

interface ProjectStoreIntegrityInternals {
  listSafeSessionFiles(allowedQuarantinePath?: string): Promise<unknown>;
  clearLastConversationIf(conversationId: string): Promise<void>;
  renameSessionFile(source: string, destination: string): Promise<void>;
  unlinkSessionFile(path: string): Promise<void>;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createDirectoryLink(
  target: string,
  path: string,
): Promise<void> {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sessionInformation(
  path: string,
  id: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    path,
    id,
    cwd: "",
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T00:00:00.000Z"),
    messageCount: 0,
    firstMessage: "",
    allMessagesText: "",
    ...overrides,
  };
}

async function writeSessionHeader(
  path: string,
  id: string,
  cwd: string,
  version = 3,
): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    type: "session",
    version,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  })}\n`);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("ProjectStore", () => {
  it("creates a stable project manifest and reopens it", async () => {
    const cwd = await createTemporaryDirectory("piweb-project-");
    const first = await ProjectStore.open(cwd, "read_only");
    const conversationId = randomUUID();

    await first.setLastConversation(conversationId);

    const reopened = await ProjectStore.open(cwd, "full_access");
    expect(reopened.id).toBe(first.id);
    expect(reopened.cwd).toBe(await realpath(cwd));
    expect(reopened.stateDir).toBe(join(reopened.cwd, ".piweb"));
    expect(reopened.sessionDir).toBe(join(reopened.stateDir, "sessions"));
    expect(reopened.toolMode).toBe("read_only");
    expect(reopened.lastConversationId).toBe(conversationId);
  });

  it("migrates the removed workspace mode to full access on disk", async () => {
    const cwd = await createTemporaryDirectory("piweb-legacy-project-mode-");
    const stateDirectory = join(cwd, ".piweb");
    const manifestPath = join(stateDirectory, "project.json");
    const projectId = randomUUID();
    const lastConversationId = randomUUID();
    await mkdir(stateDirectory);
    await writeFile(manifestPath, `${JSON.stringify({
      version: 1,
      projectId,
      createdAt: "2026-07-18T12:00:00.000Z",
      toolMode: "workspace_write",
      lastConversationId,
    }, null, 2)}\n`);

    const store = await ProjectStore.open(cwd, "read_only");

    expect(store).toMatchObject({
      id: projectId,
      toolMode: "full_access",
      lastConversationId,
    });
    await expect(readFile(manifestPath, "utf8")).resolves.not.toContain(
      "workspace_write",
    );
    await expect(readFile(manifestPath, "utf8")).resolves.toContain(
      '"toolMode": "full_access"',
    );
  });

  it("fails closed without replacing an invalid manifest", async () => {
    const cwd = await createTemporaryDirectory("piweb-invalid-project-");
    const stateDirectory = join(cwd, ".piweb");
    const manifestPath = join(stateDirectory, "project.json");
    const invalidManifest = '{"version":1,"projectId":"not-a-uuid"}\n';
    await mkdir(stateDirectory);
    await writeFile(manifestPath, invalidManifest);

    await expect(ProjectStore.open(cwd, "full_access")).rejects.toThrow(
      "Invalid project manifest",
    );
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(invalidManifest);
  });

  it("rejects a linked project state directory before writing outside the project", async () => {
    const cwd = await createTemporaryDirectory("piweb-linked-state-");
    const outside = await createTemporaryDirectory("piweb-linked-state-target-");
    await createDirectoryLink(outside, join(cwd, ".piweb"));

    await expect(ProjectStore.open(cwd, "full_access")).rejects.toThrow(
      "Project state directory",
    );
    await expect(
      readFile(join(outside, "project.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a linked session directory before creating host persistence through it", async () => {
    const cwd = await createTemporaryDirectory("piweb-linked-sessions-");
    const outside = await createTemporaryDirectory(
      "piweb-linked-sessions-target-",
    );
    const stateDirectory = join(cwd, ".piweb");
    await mkdir(stateDirectory);
    await createDirectoryLink(outside, join(stateDirectory, "sessions"));

    await expect(ProjectStore.open(cwd, "full_access")).rejects.toThrow(
      "Project session directory",
    );
    await expect(readdir(outside)).resolves.toEqual([]);
    await expect(
      readFile(join(stateDirectory, "project.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("durably serializes recent conversation changes and notifies subscribers", async () => {
    const cwd = await createTemporaryDirectory("piweb-project-recent-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.setLastConversation(conversationId);
    await store.setLastConversation(conversationId);
    unsubscribe();
    await store.setLastConversation(undefined);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith();
    await expect(ProjectStore.open(cwd, "read_only")).resolves.toMatchObject({
      toolMode: "full_access",
      lastConversationId: undefined,
    });
  });

  it("seeds a new project with full-access mode", async () => {
    const cwd = await createTemporaryDirectory("piweb-project-full-access-");

    await expect(ProjectStore.open(cwd, "full_access")).resolves.toMatchObject({
      toolMode: "full_access",
    });
  });

  it("persists and lists a conversation before it has an assistant message", async () => {
    const cwd = await createTemporaryDirectory("piweb-empty-conversation-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();

    const conversation = await store.createConversation(conversationId);
    expect(conversation.getSessionId()).toBe(conversationId);
    const sessionFile = conversation.getSessionFile();
    expect(sessionFile).toBeDefined();
    const persisted = await readFile(sessionFile!, "utf8");
    expect(persisted.trim().split(/\r?\n/)).toEqual([
      JSON.stringify(conversation.getHeader()),
    ]);

    const summaries = await store.refreshConversations();
    expect(summaries).toEqual([
      expect.objectContaining({
        id: conversation.getSessionId(),
        preview: "",
        messageCount: 0,
      }),
    ]);
    expect(store.lastConversationId).toBe(conversation.getSessionId());

    const reopened = await store.openConversation(conversation.getSessionId());
    expect(reopened.getEntries()).toEqual([]);
    expect(reopened.getCwd()).toBe(store.cwd);
  });

  it("validates metadata and normally opens deeply nested custom entry data", async () => {
    const cwd = await createTemporaryDirectory("piweb-deep-session-entry-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const sessionFile = conversation.getSessionFile()!;
    const depth = 2_500;
    const nested = `${'{"next":'.repeat(depth)}null${"}".repeat(depth)}`;
    await writeFile(sessionFile, [
      JSON.stringify(conversation.getHeader()),
      `{"type":"custom","id":"00000001","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","customType":"extension-state","data":${nested}}`,
      "",
    ].join("\n"));

    const metadata = await store.inspectConversation(
      conversation.getSessionId(),
    );
    expect(metadata).not.toHaveProperty("entries");
    const reopened = await store.openConversation(
      conversation.getSessionId(),
      { updateRecent: false },
    );
    expect(reopened.getEntries()).toHaveLength(1);
  });

  it("does not strand a conversation file when the initial SDK open fails", async () => {
    const cwd = await createTemporaryDirectory("piweb-create-open-failure-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();
    const before = await readdir(store.sessionDir);
    const open = vi.spyOn(SessionManager, "open").mockImplementationOnce(() => {
      throw new Error("SDK refused the initial session");
    });

    await expect(store.createConversation(conversationId))
      .rejects.toThrow("SDK refused the initial session");

    open.mockRestore();
    expect(await readdir(store.sessionDir)).toEqual(before);
    expect(store.listConversations()).toEqual([]);
  });

  it("creates the header and immutable role metadata in one initial file", async () => {
    const cwd = await createTemporaryDirectory("piweb-meta-conversation-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();
    const meta: ConversationMeta = {
      role: {
        id: "971080c4-e889-4860-a10f-26fdaffaee32",
        revision: 3,
        name: "Reviewer",
        description: "Reviews lifecycle code",
        systemPrompt: "Review carefully.",
        model: { provider: "provider", id: "model" },
      },
      lifecycle: { kind: "normal" },
      createdBy: { kind: "user" },
    };

    const conversation = await store.createConversation(
      conversationId,
      meta,
    );
    const sessionFile = conversation.getSessionFile();
    if (!sessionFile) throw new Error("conversation did not expose its session file");
    const persisted = (await readFile(sessionFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toEqual(conversation.getHeader());
    expect(persisted[1]).toMatchObject({
      type: "custom",
      parentId: null,
      customType: CONVERSATION_META_CUSTOM_TYPE,
      data: meta,
    });
    expect(conversation.getEntries()).toHaveLength(1);
  });

  it("can create a background conversation without changing durable recent", async () => {
    const cwd = await createTemporaryDirectory(
      "piweb-background-conversation-",
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const foreground = await store.createConversation();
    const background = await store.createConversation(
      randomUUID(),
      undefined,
      { updateRecent: false },
    );

    expect(background.getSessionId()).not.toBe(foreground.getSessionId());
    expect(store.lastConversationId).toBe(foreground.getSessionId());
    await expect(ProjectStore.open(cwd, "read_only")).resolves.toMatchObject({
      lastConversationId: foreground.getSessionId(),
    });
    expect(store.listConversations().map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        foreground.getSessionId(),
        background.getSessionId(),
      ]),
    );
  });

  it("deletes exactly one persisted conversation and clears a stale recent pointer", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-conversation-");
    const store = await ProjectStore.open(cwd, "full_access");
    const retained = await store.createConversation();
    const deleted = await store.createConversation();
    const deletedPath = deleted.getSessionFile();
    if (!deletedPath) throw new Error("conversation did not expose its session file");

    await store.setLastConversation(deleted.getSessionId());
    await store.deleteConversation(deleted.getSessionId());

    await expect(readFile(deletedPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(store.lastConversationId).toBeUndefined();
    expect(store.listConversations().map(({ id }) => id)).toEqual([
      retained.getSessionId(),
    ]);
    await expect(
      store.openConversation(deleted.getSessionId()),
    ).rejects.toThrow("Conversation not found");

    await expect(
      store.deleteConversation(deleted.getSessionId()),
    ).resolves.toBeUndefined();
  });

  it("recovers an abandoned deletion quarantine before the first refresh", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-crash-recovery-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const conversationId = conversation.getSessionId();
    const sessionFile = conversation.getSessionFile()!;
    const originalRaw = await readFile(sessionFile, "utf8");
    const quarantinePath = join(
      store.sessionDir,
      `.${basename(sessionFile)}.${randomUUID()}.delete-quarantine`,
    );
    await rename(sessionFile, quarantinePath);

    const reopened = await ProjectStore.open(cwd, "full_access");

    await expect(readFile(sessionFile, "utf8")).resolves.toBe(originalRaw);
    await expect(readFile(quarantinePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(reopened.refreshConversations()).resolves.toEqual([
      expect.objectContaining({ id: conversationId }),
    ]);
  });

  it("blocks catalogs on an inactive quarantine until a delete retry recovers it", async () => {
    const cwd = await createTemporaryDirectory(
      "piweb-delete-same-process-recovery-",
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const conversationId = conversation.getSessionId();
    const sessionFile = conversation.getSessionFile()!;
    const quarantinePath = join(
      store.sessionDir,
      `.${basename(sessionFile)}.${randomUUID()}.delete-quarantine`,
    );
    await rename(sessionFile, quarantinePath);

    await expect(store.refreshConversations()).rejects.toThrow(
      "Abandoned conversation deletion quarantine requires recovery",
    );
    await expect(readFile(quarantinePath, "utf8")).resolves.toContain(
      conversationId,
    );

    await store.deleteConversation(conversationId);

    await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(quarantinePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(store.listConversations().map(({ id }) => id)).not.toContain(
      conversationId,
    );
  });

  it("finishes recovery when a prior hard link committed before quarantine unlink", async () => {
    const cwd = await createTemporaryDirectory(
      "piweb-delete-crash-after-recovery-link-",
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const conversationId = conversation.getSessionId();
    const sessionFile = conversation.getSessionFile()!;
    const originalRaw = await readFile(sessionFile, "utf8");
    const quarantinePath = join(
      store.sessionDir,
      `.${basename(sessionFile)}.${randomUUID()}.delete-quarantine`,
    );
    await rename(sessionFile, quarantinePath);
    await link(quarantinePath, sessionFile);

    const reopened = await ProjectStore.open(cwd, "full_access");

    await expect(readFile(sessionFile, "utf8")).resolves.toBe(originalRaw);
    await expect(readFile(quarantinePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(store.sessionDir)).filter((name) =>
      name.endsWith(".delete-recovery.jsonl")
    )).toEqual([]);
    await expect(reopened.refreshConversations()).resolves.toEqual([
      expect.objectContaining({ id: conversationId }),
    ]);
  });

  it("fails closed without moving a corrupt validly named quarantine", async () => {
    const cwd = await createTemporaryDirectory(
      "piweb-corrupt-delete-quarantine-",
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const originalPath = join(store.sessionDir, "corrupt-conversation.jsonl");
    const quarantinePath = join(
      store.sessionDir,
      `.corrupt-conversation.jsonl.${randomUUID()}.delete-quarantine`,
    );
    const corruptRaw = '{"type":"session"\n';
    await writeFile(quarantinePath, corruptRaw);

    await expect(ProjectStore.open(cwd, "full_access")).rejects.toThrow(
      "invalid JSON",
    );

    await expect(readFile(quarantinePath, "utf8")).resolves.toBe(corruptRaw);
    await expect(readFile(originalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a colliding abandoned quarantine before catalog fails closed", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-crash-collision-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const conversationId = conversation.getSessionId();
    const sessionFile = conversation.getSessionFile()!;
    const originalRaw = await readFile(sessionFile, "utf8");
    const quarantinePath = join(
      store.sessionDir,
      `.${basename(sessionFile)}.${randomUUID()}.delete-quarantine`,
    );
    await rename(sessionFile, quarantinePath);
    await writeFile(sessionFile, originalRaw);

    const reopened = await ProjectStore.open(cwd, "full_access");

    await expect(readFile(sessionFile, "utf8")).resolves.toBe(originalRaw);
    await expect(readFile(quarantinePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const recoveryFiles = (await readdir(store.sessionDir)).filter((name) =>
      name.endsWith(".delete-recovery.jsonl")
    );
    expect(recoveryFiles).toHaveLength(1);
    await expect(
      readFile(join(store.sessionDir, recoveryFiles[0]!), "utf8"),
    ).resolves.toBe(originalRaw);
    await expect(reopened.refreshConversations()).rejects.toThrow(
      `Duplicate conversation identity ${conversationId}`,
    );
  });

  it("fails closed on malformed and non-file deletion quarantines", async () => {
    const cwd = await createTemporaryDirectory("piweb-invalid-delete-quarantine-");
    const store = await ProjectStore.open(cwd, "full_access");
    const malformedPath = join(
      store.sessionDir,
      ".conversation.jsonl.not-a-uuid.delete-quarantine",
    );
    await writeSessionHeader(malformedPath, randomUUID(), store.cwd);

    await expect(ProjectStore.open(cwd, "full_access")).rejects.toThrow(
      "Invalid conversation deletion quarantine filename",
    );
    await expect(readFile(malformedPath, "utf8")).resolves.toContain(
      '"type":"session"',
    );

    await rm(malformedPath);
    const directoryPath = join(
      store.sessionDir,
      `.conversation.jsonl.${randomUUID()}.delete-quarantine`,
    );
    await mkdir(directoryPath);
    await expect(ProjectStore.open(cwd, "full_access")).rejects.toThrow(
      "must be a regular project-owned file",
    );

    await rm(directoryPath, { recursive: true });
    const outside = await createTemporaryDirectory(
      "piweb-delete-quarantine-link-target-",
    );
    await createDirectoryLink(outside, directoryPath);
    await expect(ProjectStore.open(cwd, "full_access")).rejects.toThrow(
      "must be a regular project-owned file",
    );
  });

  it("deletes a conversation-scoped notebook sidecar with its conversation", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-notebook-");
    const store = await ProjectStore.open(cwd, "full_access");
    const retained = await store.createConversation();
    const deleted = await store.createConversation();
    await new ConversationNotebook(
      store.stateDir,
      retained.getSessionId(),
    ).write({ title: "Retained", content: "keep me" });
    await new ConversationNotebook(
      store.stateDir,
      deleted.getSessionId(),
    ).write({ title: "Deleted", content: "remove me" });
    const staleTemporaryPath = join(
      store.stateDir,
      "notebooks",
      `.${deleted.getSessionId()}.json.123.tmp`,
    );
    await writeFile(staleTemporaryPath, "stale temp", "utf8");

    await store.deleteConversation(deleted.getSessionId());

    await expect(readFile(
      join(store.stateDir, "notebooks", `${deleted.getSessionId()}.json`),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(staleTemporaryPath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(
      join(store.stateDir, "notebooks", `${retained.getSessionId()}.json`),
      "utf8",
    )).resolves.toContain("keep me");
  });

  it("fails before deleting the transcript when its notebook path is not a file", async () => {
    const cwd = await createTemporaryDirectory("piweb-invalid-notebook-delete-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const conversationId = conversation.getSessionId();
    const sessionFile = conversation.getSessionFile();
    if (!sessionFile) throw new Error("conversation did not expose its session file");
    await new ConversationNotebook(store.stateDir, conversationId).write({
      title: "Existing note",
      content: "must not authorize a recursive delete",
    });
    const notebookPath = join(
      store.stateDir,
      "notebooks",
      `${conversationId}.json`,
    );
    await rm(notebookPath);
    await mkdir(notebookPath);
    await writeFile(join(notebookPath, "unexpected.txt"), "keep", "utf8");
    await store.setLastConversation(conversationId);

    await expect(store.deleteConversation(conversationId))
      .rejects.toThrow(/notebook file.*regular file/i);

    await expect(readFile(sessionFile, "utf8")).resolves.toContain(
      `\"id\":\"${conversationId}\"`,
    );
    expect(store.lastConversationId).toBe(conversationId);
    expect(store.listConversations().map(({ id }) => id)).toContain(
      conversationId,
    );
    await expect(readFile(
      join(notebookPath, "unexpected.txt"),
      "utf8",
    )).resolves.toBe("keep");
  });

  it("restores a path replacement swapped in at the quarantine rename boundary", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-replacement-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const conversationId = conversation.getSessionId();
    const sessionFile = conversation.getSessionFile()!;
    const displacedPath = join(store.sessionDir, ".displaced-original.tmp");
    const replacementPath = join(store.sessionDir, ".replacement.tmp");
    await writeSessionHeader(replacementPath, conversationId, store.cwd);
    const replacementRaw = await readFile(replacementPath, "utf8");
    const internals = store as unknown as ProjectStoreIntegrityInternals;
    const originalRenameSessionFile = internals.renameSessionFile.bind(store);
    vi.spyOn(internals, "renameSessionFile").mockImplementationOnce(
      async (source, destination) => {
        await rename(source, displacedPath);
        await rename(replacementPath, source);
        await originalRenameSessionFile(source, destination);
      },
    );

    await expect(store.deleteConversation(conversationId)).rejects.toThrow(
      "changed while it was being read",
    );

    await expect(readFile(sessionFile, "utf8")).resolves.toBe(replacementRaw);
    await expect(readFile(displacedPath, "utf8")).resolves.toContain(
      conversationId,
    );
  });

  it("preserves quarantine as recovery JSONL when the original path is occupied", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-recovery-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const conversationId = conversation.getSessionId();
    const sessionFile = conversation.getSessionFile()!;
    const corruptRaw = '{"type":"session"\n';
    const internals = store as unknown as ProjectStoreIntegrityInternals;
    const originalRenameSessionFile = internals.renameSessionFile.bind(store);
    vi.spyOn(internals, "renameSessionFile").mockImplementationOnce(
      async (source, destination) => {
        await originalRenameSessionFile(source, destination);
        await writeFile(source, corruptRaw);
      },
    );

    await expect(store.deleteConversation(conversationId)).rejects.toThrow(
      "invalid JSON",
    );

    await expect(readFile(sessionFile, "utf8")).resolves.toBe(corruptRaw);
    const recoveryFiles = (await readdir(store.sessionDir)).filter((name) =>
      name.endsWith(".delete-recovery.jsonl")
    );
    expect(recoveryFiles).toHaveLength(1);
    await expect(
      readFile(join(store.sessionDir, recoveryFiles[0]!), "utf8"),
    ).resolves.toContain(conversationId);
  });

  it("projects an unrelated conversation added at quarantine unlink", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-unlink-add-");
    const store = await ProjectStore.open(cwd, "full_access");
    const deleted = await store.createConversation();
    const retained = await store.createConversation();
    const addedId = randomUUID();
    const addedPath = join(store.sessionDir, "added-at-unlink.jsonl");
    const internals = store as unknown as ProjectStoreIntegrityInternals;
    const originalUnlinkSessionFile = internals.unlinkSessionFile.bind(store);
    vi.spyOn(internals, "unlinkSessionFile").mockImplementationOnce(
      async (path) => {
        await writeSessionHeader(addedPath, addedId, store.cwd);
        await originalUnlinkSessionFile(path);
      },
    );

    await store.deleteConversation(deleted.getSessionId());

    expect(store.listConversations().map(({ id }) => id)).toEqual(
      expect.arrayContaining([retained.getSessionId(), addedId]),
    );
    expect(store.listConversations().map(({ id }) => id)).not.toContain(
      deleted.getSessionId(),
    );
  });

  it("projects retained conversations from the catalog generation that deletion proved", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-generation-");
    const store = await ProjectStore.open(cwd, "full_access");
    const deleted = await store.createConversation();
    const retained = await store.createConversation();
    const addedId = randomUUID();
    const addedPath = join(store.sessionDir, "added-during-proof.jsonl");
    const listAll = vi.spyOn(SessionManager, "listAll");
    const internals = store as unknown as ProjectStoreIntegrityInternals;
    const originalListSafeSessionFiles =
      internals.listSafeSessionFiles.bind(store);
    let fingerprintEnumerations = 0;
    vi.spyOn(internals, "listSafeSessionFiles").mockImplementation(
      async (allowedQuarantinePath) => {
        fingerprintEnumerations += 1;
        if (fingerprintEnumerations === 2) {
          await writeSessionHeader(addedPath, addedId, store.cwd);
        }
        return originalListSafeSessionFiles(allowedQuarantinePath);
      },
    );

    await store.deleteConversation(deleted.getSessionId());

    expect(listAll).toHaveBeenCalledTimes(2);
    expect(store.listConversations().map(({ id }) => id)).toEqual(
      expect.arrayContaining([retained.getSessionId(), addedId]),
    );
    expect(store.listConversations().map(({ id }) => id)).not.toContain(
      deleted.getSessionId(),
    );
  });

  it("publishes a conversation added after the first post-quarantine proof", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-post-proof-add-");
    const store = await ProjectStore.open(cwd, "full_access");
    const deleted = await store.createConversation();
    const retained = await store.createConversation();
    const addedId = randomUUID();
    const addedPath = join(store.sessionDir, "added-after-proof.jsonl");
    const internals = store as unknown as ProjectStoreIntegrityInternals;
    const originalClearLastConversation =
      internals.clearLastConversationIf.bind(store);
    vi.spyOn(internals, "clearLastConversationIf").mockImplementationOnce(
      async (id) => {
        await originalClearLastConversation(id);
        await writeSessionHeader(addedPath, addedId, store.cwd);
      },
    );

    await store.deleteConversation(deleted.getSessionId());

    expect(store.listConversations().map(({ id }) => id)).toEqual(
      expect.arrayContaining([retained.getSessionId(), addedId]),
    );
  });

  it("restores quarantine when an unrelated file becomes corrupt after proof", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-post-proof-corrupt-");
    const store = await ProjectStore.open(cwd, "full_access");
    const deleted = await store.createConversation();
    const retained = await store.createConversation();
    const deletedPath = deleted.getSessionFile()!;
    const corruptPath = join(store.sessionDir, "corrupt-after-proof.jsonl");
    const internals = store as unknown as ProjectStoreIntegrityInternals;
    const originalClearLastConversation =
      internals.clearLastConversationIf.bind(store);
    vi.spyOn(internals, "clearLastConversationIf").mockImplementationOnce(
      async (id) => {
        await originalClearLastConversation(id);
        await writeFile(corruptPath, '{"type":"session"\n');
      },
    );

    await expect(
      store.deleteConversation(deleted.getSessionId()),
    ).rejects.toThrow("invalid JSON");

    await expect(readFile(deletedPath, "utf8")).resolves.toContain(
      deleted.getSessionId(),
    );
    await expect(readFile(corruptPath, "utf8")).resolves.toBe(
      '{"type":"session"\n',
    );
    expect(store.listConversations().map(({ id }) => id)).toEqual(
      expect.arrayContaining([deleted.getSessionId(), retained.getSessionId()]),
    );
  });

  it("physically truncates the selected message and every later entry", async () => {
    const cwd = await createTemporaryDirectory("piweb-truncate-conversation-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const retainedId = conversation.appendMessage({
      role: "user",
      content: "retained",
      timestamp: 1,
    });
    const selectedId = conversation.appendMessage({
      role: "user",
      content: "selected",
      timestamp: 2,
    });
    conversation.appendMessage({
      role: "user",
      content: "later",
      timestamp: 3,
    });
    const sessionFile = conversation.getSessionFile()!;

    await expect(store.truncateConversation(
      conversation.getSessionId(),
      selectedId,
    )).resolves.toBe(sessionFile);

    const persisted = (await readFile(sessionFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { id?: string });
    expect(persisted.map(({ id }) => id)).toEqual([
      conversation.getHeader()?.id,
      retainedId,
    ]);
    const reopened = await store.openConversation(
      conversation.getSessionId(),
      { updateRecent: false },
    );
    expect(reopened.getEntries().map(({ id }) => id)).toEqual([retainedId]);
  });

  it("rewinds context while preserving delivery receipts and their exact run settlements", async () => {
    const cwd = await createTemporaryDirectory("piweb-truncate-receipt-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const conversationId = conversation.getSessionId();
    const retainedId = conversation.appendMessage({
      role: "user",
      content: "retained",
      timestamp: 1,
    });
    const selectedId = conversation.appendMessage({
      role: "user",
      content: "rewind from here",
      timestamp: 2,
    });
    const messageId = randomUUID();
    const cardId = randomUUID();
    const sourceConversationId = randomUUID();
    const sourceRunId = randomUUID();
    const targetRunId = randomUUID();
    const incoming = createConversationMessageEntry({
      content: "incoming marker that must be rewound",
      display: true,
      details: {
        messageId,
        cardId,
        sentAt: "2026-01-01T00:01:00.000Z",
        kind: "message",
        body: "incoming marker that must be rewound",
        fromSnapshot: {
          conversationId: sourceConversationId,
          role: { id: "default", name: "Sender" },
        },
        toSnapshot: {
          conversationId,
          role: { id: "default", name: "Recipient" },
        },
      },
    });
    conversation.appendCustomMessageEntry(
      incoming.customType,
      incoming.content,
      incoming.display,
      incoming.details,
    );
    const receipt = createMessageDeliveryReceiptEntry({
      messageId,
      cardId,
      fromConversationId: sourceConversationId,
      toConversationId: conversationId,
      sourceRunId,
      targetRunId,
      kind: "message",
      sentAt: incoming.details.sentAt,
      payloadFingerprint: "a".repeat(64),
      temporaryReturnAssignment: {
        initialRunId: sourceRunId,
        callerRunId: targetRunId,
        assignedAt: "2026-01-01T00:01:30.000Z",
      },
      deliveredAt: "2026-01-01T00:02:00.000Z",
    });
    const receiptId = conversation.appendCustomEntry(
      receipt.customType,
      receipt.data,
    );
    const temporaryReceiptIdentity = {
      temporaryConversationId: sourceConversationId,
      initialRunId: sourceRunId,
      messageId,
      callerRunId: targetRunId,
      claimedAt: receipt.data.temporaryReturnAssignment!.assignedAt,
    };
    const claimedTemporaryReceipt = createTemporaryReturnReceiptEntry({
      ...temporaryReceiptIdentity,
      state: "claimed",
    });
    const claimedTemporaryReceiptId = conversation.appendCustomEntry(
      claimedTemporaryReceipt.customType,
      claimedTemporaryReceipt.data,
    );
    const settledTemporaryReceipt = createTemporaryReturnReceiptEntry({
      ...temporaryReceiptIdentity,
      state: "settled",
      settlement: {
        runId: sourceRunId,
        outcome: "completed",
        finalText: "returned",
        settledAt: "2026-01-01T00:02:30.000Z",
        reportedAt: "2026-01-01T00:02:31.000Z",
        returnMessageId: messageId,
      },
    });
    const settledTemporaryReceiptId = conversation.appendCustomEntry(
      settledTemporaryReceipt.customType,
      settledTemporaryReceipt.data,
    );
    conversation.appendCustomEntry("test.unrelated", { keep: false });
    const referencedSettlement = createRunSettlementEntry({
      runId: targetRunId,
      outcome: "completed",
      finalText: "done",
      settledAt: "2026-01-01T00:03:00.000Z",
    });
    const referencedSettlementId = conversation.appendCustomEntry(
      referencedSettlement.customType,
      referencedSettlement.data,
    );
    const unrelatedSettlement = createRunSettlementEntry({
      runId: randomUUID(),
      outcome: "completed",
      finalText: "unrelated",
      settledAt: "2026-01-01T00:04:00.000Z",
    });
    conversation.appendCustomEntry(
      unrelatedSettlement.customType,
      unrelatedSettlement.data,
    );
    const sessionFile = conversation.getSessionFile()!;
    const before = (await readFile(sessionFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    await store.truncateConversation(conversationId, selectedId);

    const persisted = (await readFile(sessionFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(persisted.map(({ id }) => id)).toEqual([
      conversation.getHeader()?.id,
      retainedId,
      receiptId,
      claimedTemporaryReceiptId,
      settledTemporaryReceiptId,
      referencedSettlementId,
    ]);
    expect(persisted.find(({ id }) => id === receiptId)).toEqual({
      ...before.find(({ id }) => id === receiptId),
      parentId: retainedId,
    });
    expect(
      persisted.find(({ id }) => id === claimedTemporaryReceiptId),
    ).toEqual({
      ...before.find(({ id }) => id === claimedTemporaryReceiptId),
      parentId: receiptId,
    });
    expect(
      persisted.find(({ id }) => id === settledTemporaryReceiptId),
    ).toEqual({
      ...before.find(({ id }) => id === settledTemporaryReceiptId),
      parentId: claimedTemporaryReceiptId,
    });
    expect(persisted.find(({ id }) => id === referencedSettlementId)).toEqual({
      ...before.find(({ id }) => id === referencedSettlementId),
      parentId: settledTemporaryReceiptId,
    });

    const inspection = await store.inspectConversation(conversationId);
    expect(inspection.deliveredMessageIds).toEqual([]);
    expect(inspection.messageDeliveryReceipts).toEqual([receipt.data]);
    expect(inspection.runSettlements).toEqual([referencedSettlement.data]);
    const reopened = await store.openConversation(conversationId, {
      updateRecent: false,
    });
    expect(reopened.buildSessionContext().messages).toEqual([
      expect.objectContaining({ role: "user", content: "retained" }),
    ]);
  });

  it("fails closed without rewriting when the truncation anchor is not a message", async () => {
    const cwd = await createTemporaryDirectory(
      "piweb-invalid-truncate-anchor-",
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const customId = conversation.appendCustomEntry("test.anchor", {
      value: true,
    });
    const sessionFile = conversation.getSessionFile()!;
    const before = await readFile(sessionFile, "utf8");

    await expect(store.truncateConversation(
      conversation.getSessionId(),
      customId,
    )).rejects.toThrow(/message/i);
    await expect(readFile(sessionFile, "utf8")).resolves.toBe(before);
  });

  it("serializes deletion behind an older refresh and only clears the matching recent pointer", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-refresh-race-");
    const store = await ProjectStore.open(cwd, "full_access");
    const retained = await store.createConversation();
    const deleted = await store.createConversation();
    await store.setLastConversation(deleted.getSessionId());
    retained.appendSessionInfo("force a fresh integrity scan");
    const information = await SessionManager.listAll(store.sessionDir);
    const delayedScan = createDeferred<SessionInfo[]>();
    const listAll = vi
      .spyOn(SessionManager, "listAll")
      .mockImplementationOnce(() => delayedScan.promise);

    const refresh = store.refreshConversations();
    await vi.waitFor(() => expect(listAll).toHaveBeenCalledTimes(1));
    const deletion = store.deleteConversation(deleted.getSessionId());
    await store.setLastConversation(retained.getSessionId());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(listAll).toHaveBeenCalledTimes(1);

    delayedScan.resolve(information);
    await Promise.all([refresh, deletion]);

    expect(listAll).toHaveBeenCalledTimes(2);
    expect(store.lastConversationId).toBe(retained.getSessionId());
    expect(store.listConversations().map(({ id }) => id)).toEqual([
      retained.getSessionId(),
    ]);
  });

  it("fails closed before Pi scans a linked JSONL session entry", async () => {
    const cwd = await createTemporaryDirectory("piweb-linked-entry-");
    const outside = await createTemporaryDirectory("piweb-linked-entry-target-");
    const store = await ProjectStore.open(cwd, "full_access");
    await createDirectoryLink(outside, join(store.sessionDir, "escape.jsonl"));
    const listAll = vi.spyOn(SessionManager, "listAll");

    await expect(store.refreshConversations()).rejects.toThrow(
      "regular project-owned file",
    );
    expect(listAll).not.toHaveBeenCalled();
  });

  it("creates, lists, reopens, and reads renamed conversation information", async () => {
    const cwd = await createTemporaryDirectory("piweb-conversation-info-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();

    conversation.appendSessionInfo("  Build the parser  ");
    conversation.appendMessage({
      role: "user",
      content: "Please build the parser",
      timestamp: 10,
    });

    const summaries = await store.refreshConversations();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: conversation.getSessionId(),
      name: "Build the parser",
      preview: "Please build the parser",
      messageCount: 1,
    });
    expect(summaries[0]?.createdAt).toEqual(expect.any(String));
    expect(summaries[0]?.updatedAt).toEqual(expect.any(String));

    summaries[0]!.name = "mutated outside the store";
    expect(store.listConversations()[0]?.name).toBe("Build the parser");

    const reopened = await store.openConversation(conversation.getSessionId());
    expect(reopened.getSessionId()).toBe(conversation.getSessionId());
    expect(reopened.getSessionName()).toBe("Build the parser");
    expect(reopened.getEntries()).toHaveLength(2);
    await expect(store.openConversation("missing")).rejects.toThrow(
      "Conversation not found",
    );
  });

  it("serializes queued refreshes and reuses one unchanged verified scan", async () => {
    const cwd = await createTemporaryDirectory("piweb-refresh-queue-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    conversation.appendSessionInfo("fresh scan");
    const information = await SessionManager.listAll(store.sessionDir);
    const delayedScan = createDeferred<SessionInfo[]>();
    const listAll = vi
      .spyOn(SessionManager, "listAll")
      .mockImplementationOnce(() => delayedScan.promise);

    const firstRefresh = store.refreshConversations();
    await vi.waitFor(() => expect(listAll).toHaveBeenCalledTimes(1));
    const secondRefresh = store.refreshConversations();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(listAll).toHaveBeenCalledTimes(1);

    delayedScan.resolve(information);
    const [first, second] = await Promise.all([firstRefresh, secondRefresh]);

    expect(listAll).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({ name: "fresh scan" }),
    ]);
  });

  it("reuses one verified catalog across unchanged refresh, open, and inspect", async () => {
    const cwd = await createTemporaryDirectory("piweb-verified-catalog-reuse-");
    const store = await ProjectStore.open(cwd, "full_access");
    const listAll = vi.spyOn(SessionManager, "listAll");
    const conversation = await store.createConversation();

    await store.refreshConversations();
    await store.openConversation(conversation.getSessionId(), {
      updateRecent: false,
    });
    await store.inspectConversation(conversation.getSessionId());

    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it("bulk-inspects targets with one catalog scan and one final directory proof", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-bulk-inspect-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversations = [
      await store.createConversation(),
      await store.createConversation(),
      await store.createConversation(),
    ];
    conversations[0]!.appendSessionInfo("force a fresh integrity scan");
    const listAll = vi.spyOn(SessionManager, "listAll");
    const internals = store as unknown as ProjectStoreIntegrityInternals;
    const listSafeSessionFiles = vi.spyOn(internals, "listSafeSessionFiles");

    const inspections = await store.inspectConversations(
      conversations.map((conversation) => conversation.getSessionId()),
    );

    expect(inspections.size).toBe(3);
    for (const inspection of inspections.values()) {
      expect(inspection).not.toHaveProperty("entries");
    }
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(listSafeSessionFiles).toHaveBeenCalledTimes(3);
  });

  it("deep-copies SDK catalog values before unchanged reuse", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-copy-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();
    const sessionFile = join(store.sessionDir, "copied.jsonl");
    await writeSessionHeader(sessionFile, conversationId, store.cwd);
    const sdkInformation = sessionInformation(sessionFile, conversationId, {
      name: "original",
    });
    const listAll = vi.spyOn(SessionManager, "listAll")
      .mockResolvedValueOnce([sdkInformation]);

    await expect(store.refreshConversations()).resolves.toEqual([
      expect.objectContaining({ name: "original" }),
    ]);
    sdkInformation.name = "mutated outside";
    sdkInformation.created.setTime(0);
    sdkInformation.modified.setTime(0);
    await expect(store.refreshConversations()).resolves.toEqual([
      expect.objectContaining({
        name: "original",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it("rescans after add and remove change the session fingerprint set", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-add-remove-");
    const store = await ProjectStore.open(cwd, "full_access");
    await store.createConversation();
    const listAll = vi.spyOn(SessionManager, "listAll");
    const addedId = randomUUID();
    const addedPath = join(store.sessionDir, "added.jsonl");

    await writeSessionHeader(addedPath, addedId, store.cwd);
    await expect(store.refreshConversations()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: addedId })]),
    );
    await rm(addedPath);
    await expect(store.refreshConversations()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: addedId })]),
    );

    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("rescans after same-path replacement and in-place changes", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-file-change-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const sessionFile = conversation.getSessionFile()!;
    const original = await readFile(sessionFile, "utf8");
    const replacement = join(store.sessionDir, ".replacement.tmp");
    const listAll = vi.spyOn(SessionManager, "listAll");

    await writeFile(replacement, original);
    await rm(sessionFile);
    await rename(replacement, sessionFile);
    await store.refreshConversations();

    const reopened = await store.openConversation(conversation.getSessionId(), {
      updateRecent: false,
    });
    reopened.appendSessionInfo("changed in place");
    await expect(store.refreshConversations()).resolves.toEqual([
      expect.objectContaining({ name: "changed in place" }),
    ]);

    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("exhausts the proof budget when every SDK scan changes the fingerprint set", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-scan-race-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    conversation.appendSessionInfo("force a fresh integrity scan");
    const originalListAll = SessionManager.listAll.bind(SessionManager);
    let lateFile = 0;
    const listAll = vi.spyOn(SessionManager, "listAll")
      .mockImplementation(async (sessionDir) => {
        const information = await originalListAll(sessionDir);
        const latePath = join(store.sessionDir, `late-${lateFile++}.jsonl`);
        await writeSessionHeader(latePath, randomUUID(), store.cwd);
        return information;
      });

    await expect(store.refreshConversations()).rejects.toThrow(
      "changed while it was being scanned",
    );
    expect(listAll).toHaveBeenCalledTimes(8);
  });

  it("reproves the complete catalog after one transient SDK scan mutation", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-scan-retry-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    conversation.appendSessionInfo("force a fresh integrity scan");
    const originalListAll = SessionManager.listAll.bind(SessionManager);
    const lateId = randomUUID();
    const latePath = join(store.sessionDir, "late.jsonl");
    const listAll = vi.spyOn(SessionManager, "listAll")
      .mockImplementationOnce(async (sessionDir) => {
        const information = await originalListAll(sessionDir);
        await writeSessionHeader(latePath, lateId, store.cwd);
        return information;
      });

    await expect(store.refreshConversations()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: lateId })]),
    );
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("does not reprove a target after an unrelated body append", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-read-race-");
    const store = await ProjectStore.open(cwd, "full_access");
    const target = await store.createConversation();
    const unrelated = await store.createConversation();
    const listAll = vi.spyOn(SessionManager, "listAll");
    const internals = store as unknown as ProjectStoreIntegrityInternals;
    const originalListSafeSessionFiles =
      internals.listSafeSessionFiles.bind(store);
    let fingerprintEnumerations = 0;
    vi.spyOn(internals, "listSafeSessionFiles").mockImplementation(
      async (allowedQuarantinePath) => {
        fingerprintEnumerations += 1;
        if (fingerprintEnumerations === 2) {
          unrelated.appendSessionInfo("changed during target read");
        }
        return originalListSafeSessionFiles(allowedQuarantinePath);
      },
    );

    await expect(
      store.inspectConversation(target.getSessionId()),
    ).resolves.toEqual(expect.objectContaining({
      conversationId: target.getSessionId(),
    }));
    expect(fingerprintEnumerations).toBeGreaterThan(2);
    expect(listAll).not.toHaveBeenCalled();
  });

  it("opens a healthy target without reading an unrelated malformed body", async () => {
    const cwd = await createTemporaryDirectory("piweb-local-target-proof-");
    const store = await ProjectStore.open(cwd, "full_access");
    const target = await store.createConversation();
    const corruptPath = join(store.sessionDir, "corrupt-body.jsonl");
    await writeSessionHeader(corruptPath, randomUUID(), store.cwd);
    await writeFile(
      corruptPath,
      `${await readFile(corruptPath, "utf8")}{"type":"message"\n`,
    );
    const listAll = vi.spyOn(SessionManager, "listAll");

    const reopened = await store.openConversation(target.getSessionId(), {
      updateRecent: false,
    });

    expect(reopened.getSessionId()).toBe(target.getSessionId());
    expect(listAll).not.toHaveBeenCalled();
  });

  it("rejects a duplicate target header even when its body is malformed", async () => {
    const cwd = await createTemporaryDirectory("piweb-local-header-collision-");
    const store = await ProjectStore.open(cwd, "full_access");
    const target = await store.createConversation();
    const unaffected = await store.createConversation();
    const duplicatePath = join(store.sessionDir, "duplicate-header.jsonl");
    await writeSessionHeader(duplicatePath, target.getSessionId(), store.cwd);
    await writeFile(
      duplicatePath,
      `${await readFile(duplicatePath, "utf8")}{"type":"message"\n`,
    );

    await expect(
      store.openConversation(target.getSessionId(), { updateRecent: false }),
    ).rejects.toThrow(`Duplicate conversation identity ${target.getSessionId()}`);
    await expect(
      store.openConversation(unaffected.getSessionId(), {
        updateRecent: false,
      }),
    ).resolves.toMatchObject({
      getSessionId: expect.any(Function),
    });
  });

  it("persists a disposable path-keyed catalog and rebuilds past corruption", async () => {
    const cwd = await createTemporaryDirectory("piweb-observation-catalog-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const catalogPath = join(store.stateDir, "conversation-catalog.json");

    await expect(readFile(catalogPath, "utf8")).resolves.toEqual(
      expect.stringContaining(`"conversationId": "${conversation.getSessionId()}"`),
    );
    const cached = await ProjectStore.open(cwd, "full_access");
    expect(cached.listConversations()).toEqual([
      expect.objectContaining({ id: conversation.getSessionId() }),
    ]);

    await writeFile(catalogPath, "not JSON\n");
    const reopened = await ProjectStore.open(cwd, "full_access");

    await expect(
      reopened.openConversation(conversation.getSessionId(), {
        updateRecent: false,
      }),
    ).resolves.toMatchObject({ getSessionId: expect.any(Function) });
  });

  it("records an invalid body as a local catalog observation", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-scrub-invalid-");
    const store = await ProjectStore.open(cwd, "full_access");
    await store.createConversation();
    const corruptId = randomUUID();
    const corruptPath = join(store.sessionDir, "corrupt-body.jsonl");
    await writeSessionHeader(corruptPath, corruptId, store.cwd);
    await writeFile(
      corruptPath,
      `${await readFile(corruptPath, "utf8")}{"type":"message"\n`,
    );

    await expect(store.scrubOneCatalogObservation()).resolves.toBe(true);
    const catalog = JSON.parse(
      await readFile(join(store.stateDir, "conversation-catalog.json"), "utf8"),
    ) as {
      coverage: { kind: string };
      observations: Array<{
        relativePath: string;
        header: { kind: string; conversationId?: string };
        body: { kind: string };
      }>;
    };

    expect(catalog.coverage).toEqual({ kind: "complete", generation: expect.any(String) });
    expect(catalog.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: "corrupt-body.jsonl",
        header: { kind: "claims", conversationId: corruptId },
        body: { kind: "invalid" },
      }),
    ]));
  });

  it("invalidates the catalog when SDK open migrates the target file", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-sdk-migration-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();
    const sessionFile = join(store.sessionDir, "legacy.jsonl");
    await writeFile(sessionFile, [
      JSON.stringify({
        type: "session",
        version: 1,
        id: conversationId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: store.cwd,
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "legacy", timestamp: 1 },
      }),
      "",
    ].join("\n"));
    const listAll = vi.spyOn(SessionManager, "listAll");

    await store.refreshConversations();
    await store.openConversation(conversationId, { updateRecent: false });
    await store.refreshConversations();

    expect(listAll).toHaveBeenCalledTimes(2);
    await expect(readFile(sessionFile, "utf8")).resolves.toContain(
      '"version":3',
    );
  });

  it("rejects a current-version file changed by SDK open", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-sdk-current-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const originalOpen = SessionManager.open.bind(SessionManager);
    vi.spyOn(SessionManager, "open").mockImplementationOnce(
      (path, sessionDir, cwdOverride) => {
        const opened = originalOpen(path, sessionDir, cwdOverride);
        opened.appendSessionInfo("changed during open");
        return opened;
      },
    );

    await expect(
      store.openConversation(conversation.getSessionId(), {
        updateRecent: false,
      }),
    ).rejects.toThrow("changed while it was being read");
  });

  it("opens despite an unrelated conclusively invalid header added during SDK open", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-sdk-unrelated-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const malformedPath = join(store.sessionDir, "malformed-during-open.jsonl");
    const originalOpen = SessionManager.open.bind(SessionManager);
    vi.spyOn(SessionManager, "open").mockImplementationOnce(
      (path, sessionDir, cwdOverride) => {
        const opened = originalOpen(path, sessionDir, cwdOverride);
        writeFileSync(malformedPath, '{"type":"session"\n');
        return opened;
      },
    );

    await expect(
      store.openConversation(conversation.getSessionId(), {
        updateRecent: false,
      }),
    ).resolves.toMatchObject({
      getSessionId: expect.any(Function),
    });
    await expect(readFile(malformedPath, "utf8")).resolves.toBe(
      '{"type":"session"\n',
    );
  });

  it("rejects an invalid replacement inserted during legacy SDK migration", async () => {
    const cwd = await createTemporaryDirectory("piweb-catalog-sdk-replace-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();
    const sessionFile = join(store.sessionDir, "legacy.jsonl");
    const invalidReplacement = join(store.sessionDir, ".invalid.tmp");
    const invalidRaw = '{"type":"session"\n';
    await writeSessionHeader(sessionFile, conversationId, store.cwd, 1);
    await writeFile(invalidReplacement, invalidRaw);
    await store.refreshConversations();
    const originalOpen = SessionManager.open.bind(SessionManager);
    vi.spyOn(SessionManager, "open").mockImplementationOnce(
      (path, sessionDir, cwdOverride) => {
        const conversation = originalOpen(path, sessionDir, cwdOverride);
        rmSync(path);
        renameSync(invalidReplacement, path);
        return conversation;
      },
    );

    await expect(
      store.openConversation(conversationId, { updateRecent: false }),
    ).rejects.toThrow("changed while it was being read");
    await expect(readFile(sessionFile, "utf8")).resolves.toBe(invalidRaw);
  });

  it("rejects a partial JSONL tail before Pi can rewrite the session", async () => {
    const cwd = await createTemporaryDirectory("piweb-partial-session-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const sessionFile = conversation.getSessionFile()!;
    const original = await readFile(sessionFile, "utf8");
    const partial = `${original}{"type":"message"`;
    await writeFile(sessionFile, partial);
    const open = vi.spyOn(SessionManager, "open");

    await expect(
      store.openConversation(conversation.getSessionId()),
    ).rejects.toThrow("end with a newline");
    expect(open).not.toHaveBeenCalled();
    await expect(readFile(sessionFile, "utf8")).resolves.toBe(partial);
  });

  it("rejects malformed JSONL entries before Pi can discard them", async () => {
    const cwd = await createTemporaryDirectory("piweb-malformed-session-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const sessionFile = conversation.getSessionFile()!;
    const original = await readFile(sessionFile, "utf8");
    const malformed = `${original}{"type":"message"\n`;
    await writeFile(sessionFile, malformed);
    const open = vi.spyOn(SessionManager, "open");

    await expect(
      store.openConversation(conversation.getSessionId()),
    ).rejects.toThrow("invalid JSON on line 2");
    expect(open).not.toHaveBeenCalled();
    await expect(readFile(sessionFile, "utf8")).resolves.toBe(malformed);
  });

  it("fails closed when Pi's index silently omits a corrupt recent conversation", async () => {
    const cwd = await createTemporaryDirectory("piweb-omitted-session-");
    const store = await ProjectStore.open(cwd, "full_access");
    const recent = await store.createConversation();
    const fallback = await store.createConversation();
    const recentFile = recent.getSessionFile()!;
    await writeFile(recentFile, '{"type":"session"\n');
    await store.setLastConversation(recent.getSessionId());

    await expect(SessionManager.listAll(store.sessionDir)).resolves.toEqual([
      expect.objectContaining({ id: fallback.getSessionId() }),
    ]);
    await expect(store.refreshConversations()).rejects.toThrow(
      "invalid JSON on line 1",
    );
    expect(store.lastConversationId).toBe(recent.getSessionId());
  });

  it("fails closed when a JSON number produces an invalid Pi summary date", async () => {
    const cwd = await createTemporaryDirectory("piweb-non-finite-session-");
    const store = await ProjectStore.open(cwd, "full_access");
    const recent = await store.createConversation();
    const fallback = await store.createConversation();
    const recentFile = recent.getSessionFile()!;
    const header = await readFile(recentFile, "utf8");
    await writeFile(
      recentFile,
      `${header}{"type":"message","id":"deadbeef","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"recent","timestamp":1e999}}\n`,
    );
    await store.setLastConversation(recent.getSessionId());

    const information = await SessionManager.listAll(store.sessionDir);
    expect(information).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: recent.getSessionId(),
        modified: expect.any(Date),
      }),
      expect.objectContaining({ id: fallback.getSessionId() }),
    ]));
    expect(
      information.find(({ id }) => id === recent.getSessionId())?.modified.getTime(),
    ).toBeNaN();
    await expect(store.refreshConversations()).rejects.toThrow(
      "non-finite JSON number",
    );
    expect(store.lastConversationId).toBe(recent.getSessionId());
  });

  it("rejects an invalid SDK summary instead of filtering out a conversation", async () => {
    const cwd = await createTemporaryDirectory("piweb-invalid-summary-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const sessionFile = conversation.getSessionFile()!;
    conversation.appendSessionInfo("force a fresh integrity scan");
    vi.spyOn(SessionManager, "listAll").mockResolvedValueOnce([
      sessionInformation(sessionFile, conversation.getSessionId(), {
        modified: new Date(Number.NaN),
      }),
    ]);

    await expect(store.refreshConversations()).rejects.toThrow(
      "invalid session dates",
    );
    expect(store.listConversations()).toEqual([
      expect.objectContaining({ id: conversation.getSessionId() }),
    ]);
  });

  it("rejects a structurally invalid Pi entry instead of restoring empty history", async () => {
    const cwd = await createTemporaryDirectory("piweb-invalid-entry-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const sessionFile = conversation.getSessionFile()!;
    const header = await readFile(sessionFile, "utf8");
    await writeFile(sessionFile, `${header}{"type":"custom"}\n`);

    await expect(SessionManager.listAll(store.sessionDir)).resolves.toEqual([
      expect.objectContaining({ id: conversation.getSessionId() }),
    ]);
    await expect(
      store.openConversation(conversation.getSessionId()),
    ).rejects.toThrow("invalid session entry");
  });

  it("validates a non-empty matching Pi header before opening a listed file", async () => {
    const cwd = await createTemporaryDirectory("piweb-invalid-header-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();
    const sessionFile = join(store.sessionDir, "listed.jsonl");
    const invalidFiles = [
      "",
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: store.cwd,
      })}\n`,
      `${JSON.stringify({
        type: "not-session",
        version: 3,
        id: conversationId,
        timestamp: new Date().toISOString(),
        cwd: store.cwd,
      })}\n`,
      `${JSON.stringify({
        type: "session",
        version: 4,
        id: conversationId,
        timestamp: new Date().toISOString(),
        cwd: store.cwd,
      })}\n`,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: conversationId,
        timestamp: "not-a-timestamp",
        cwd: store.cwd,
      })}\n`,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: conversationId,
        timestamp: new Date().toISOString(),
        cwd: 42,
      })}\n`,
    ];

    for (const invalidFile of invalidFiles) {
      await writeFile(sessionFile, invalidFile);
      vi.spyOn(SessionManager, "listAll").mockResolvedValueOnce([
        sessionInformation(sessionFile, conversationId),
      ]);
      const open = vi.spyOn(SessionManager, "open");

      await expect(store.openConversation(conversationId)).rejects.toThrow(
        `Conversation not found: ${conversationId}`,
      );
      expect(open).not.toHaveBeenCalled();
      await expect(readFile(sessionFile, "utf8")).resolves.toBe(invalidFile);
      open.mockRestore();
    }
  });

  it("rejects duplicate conversation identities in separate JSONL files", async () => {
    const cwd = await createTemporaryDirectory("piweb-duplicate-session-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const sessionFile = conversation.getSessionFile()!;
    await writeFile(
      join(store.sessionDir, "duplicate.jsonl"),
      await readFile(sessionFile, "utf8"),
    );

    await expect(store.refreshConversations()).rejects.toThrow(
      "Duplicate conversation identity",
    );
  });

  it("recovers sessions after the project directory is moved", async () => {
    const parent = await createTemporaryDirectory("piweb-moved-project-");
    const originalCwd = join(parent, "original");
    const movedCwd = join(parent, "moved");
    await mkdir(originalCwd);
    const canonicalOriginalCwd = await realpath(originalCwd);
    const original = await ProjectStore.open(originalCwd, "full_access");
    const conversation = await original.createConversation();
    conversation.appendMessage({
      role: "user",
      content: "survive the move",
      timestamp: 20,
    });

    await rename(originalCwd, movedCwd);

    const moved = await ProjectStore.open(movedCwd, "read_only");
    expect(moved.id).toBe(original.id);
    const summaries = await moved.refreshConversations();
    expect(summaries.map(({ id }) => id)).toEqual([
      conversation.getSessionId(),
    ]);

    const reopened = await moved.openConversation(conversation.getSessionId());
    expect(reopened.getCwd()).toBe(await realpath(movedCwd));
    expect(reopened.getHeader()?.cwd).toBe(canonicalOriginalCwd);
  });
});

describe("ProjectStoreRegistry", () => {
  it("reuses canonical projects and exclusively leases conversation writers", async () => {
    const cwd = await createTemporaryDirectory("piweb-project-registry-");
    const registry = new ProjectStoreRegistry();
    const first = await registry.acquireProject(cwd, "full_access");
    const second = await registry.acquireProject(join(cwd, "."), "read_only");
    expect(second.store).toBe(first.store);

    const conversationId = randomUUID();
    const lease = registry.acquireConversation(first.store.cwd, conversationId);
    expect(() =>
      registry.acquireConversation(first.store.cwd, conversationId),
    ).toThrow("already leased");

    lease.release();
    lease.release();
    const reacquired = registry.acquireConversation(
      first.store.cwd,
      conversationId,
    );
    reacquired.release();
    first.release();
    second.release();
  });

  it("leases copied project identities independently by canonical cwd", async () => {
    const originalCwd = await createTemporaryDirectory(
      "piweb-project-registry-original-",
    );
    const copiedCwd = await createTemporaryDirectory(
      "piweb-project-registry-copy-",
    );
    const registry = new ProjectStoreRegistry();
    const original = await registry.acquireProject(
      originalCwd,
      "full_access",
    );
    const copiedStateDirectory = join(copiedCwd, ".piweb");
    await mkdir(copiedStateDirectory);
    await writeFile(
      join(copiedStateDirectory, "project.json"),
      await readFile(join(original.store.stateDir, "project.json"), "utf8"),
    );
    const copied = await registry.acquireProject(copiedCwd, "read_only");
    expect(copied.store.id).toBe(original.store.id);

    const conversationId = randomUUID();
    const originalLease = registry.acquireConversation(
      original.store.cwd,
      conversationId,
    );
    const copiedLease = registry.acquireConversation(
      copied.store.cwd,
      conversationId,
    );
    expect(() =>
      registry.acquireConversation(original.store.cwd, conversationId),
    ).toThrow("already leased");

    originalLease.release();
    copiedLease.release();
    original.release();
    copied.release();
  });

  it("reference-counts project handles and evicts the store after the last release", async () => {
    const cwd = await createTemporaryDirectory("piweb-project-handles-");
    const registry = new ProjectStoreRegistry();
    const [first, second] = await Promise.all([
      registry.acquireProject(cwd, "full_access"),
      registry.acquireProject(join(cwd, "."), "read_only"),
    ]);
    expect(second.store).toBe(first.store);
    const originalId = first.store.id;

    first.release();
    first.release();
    const stillShared = await registry.acquireProject(cwd, "read_only");
    expect(stillShared.store).toBe(second.store);
    second.release();
    stillShared.release();

    await rm(join(cwd, ".piweb"), { force: true, recursive: true });
    const rebuilt = await registry.acquireProject(cwd, "read_only");
    expect(rebuilt.store).not.toBe(first.store);
    expect(rebuilt.store.id).not.toBe(originalId);
    rebuilt.release();
    rebuilt.release();
  });

  it("hands a released conversation lease to waiters in FIFO order", async () => {
    const cwd = await createTemporaryDirectory("piweb-conversation-queue-");
    const registry = new ProjectStoreRegistry();
    const conversationId = randomUUID();
    const owner = registry.acquireConversation(cwd, conversationId);
    const order: string[] = [];
    const firstWaiting = registry
      .acquireConversationWhenAvailable(cwd, conversationId)
      .then((lease) => {
        order.push("first");
        return lease;
      });
    const secondWaiting = registry
      .acquireConversationWhenAvailable(cwd, conversationId)
      .then((lease) => {
        order.push("second");
        return lease;
      });

    owner.release();
    const first = await firstWaiting;
    await Promise.resolve();
    expect(order).toEqual(["first"]);

    first.release();
    first.release();
    const second = await secondWaiting;
    expect(order).toEqual(["first", "second"]);
    second.release();
  });

  it("atomically upgrades a writer lease for deletion without waking openers", async () => {
    const cwd = await createTemporaryDirectory("piweb-conversation-delete-");
    const registry = new ProjectStoreRegistry();
    const conversationId = randomUUID();
    const writer = registry.acquireConversation(cwd, conversationId);
    let openerResolved = false;
    const opener = registry
      .acquireConversationWhenAvailable(cwd, conversationId)
      .then((lease) => {
        openerResolved = true;
        return lease;
      });

    const deletion = writer.upgradeToDeletion();
    writer.release();
    await Promise.resolve();

    expect(openerResolved).toBe(false);
    expect(() =>
      registry.acquireConversation(cwd, conversationId),
    ).toThrow("already leased");

    deletion.release();
    const nextWriter = await opener;
    expect(openerResolved).toBe(true);
    nextWriter.release();
  });

  it("removes cancelled waiters without allowing later callers to jump the queue", async () => {
    const cwd = await createTemporaryDirectory("piweb-cancelled-waiter-");
    const registry = new ProjectStoreRegistry();
    const conversationId = randomUUID();
    const owner = registry.acquireConversation(cwd, conversationId);
    const controller = new AbortController();
    const cancelled = registry.acquireConversationWhenAvailable(
      cwd,
      conversationId,
      { signal: controller.signal },
    );
    const next = registry.acquireConversationWhenAvailable(cwd, conversationId);

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    owner.release();
    const nextLease = await next;
    nextLease.release();
  });

  it("bounds lease waiting with a default timeout and cleans up the queue", async () => {
    vi.useFakeTimers();
    const cwd = await createTemporaryDirectory("piweb-timed-waiter-");
    const registry = new ProjectStoreRegistry();
    const conversationId = randomUUID();
    const owner = registry.acquireConversation(cwd, conversationId);
    const timedOut = registry.acquireConversationWhenAvailable(
      cwd,
      conversationId,
    );
    const rejection = expect(timedOut).rejects.toThrow(
      "Timed out waiting for conversation",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    owner.release();
    expect(() =>
      registry.acquireConversation(cwd, conversationId),
    ).not.toThrow();
  });

  it.runIf(process.platform === "win32")(
    "treats differently-cased Windows project paths as the same lease key",
    async () => {
      const cwd = await createTemporaryDirectory("piweb-windows-lease-");
      const registry = new ProjectStoreRegistry();
      const conversationId = randomUUID();
      const lease = registry.acquireConversation(cwd, conversationId);

      expect(() =>
        registry.acquireConversation(cwd.toUpperCase(), conversationId),
      ).toThrow("already leased");
      lease.release();
    },
  );
});
