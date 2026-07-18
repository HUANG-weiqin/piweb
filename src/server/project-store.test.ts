import { randomUUID } from "node:crypto";
import {
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
import { join } from "node:path";
import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore, ProjectStoreRegistry } from "./project-store.js";

const temporaryDirectories: string[] = [];

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
    const first = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();

    await Promise.all([
      first.setToolMode("read_only"),
      first.setLastConversation(conversationId),
    ]);

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

  it("durably serializes tool mode changes and notifies subscribers", async () => {
    const cwd = await createTemporaryDirectory("piweb-project-mode-");
    const store = await ProjectStore.open(cwd, "full_access");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.setToolMode("read_only");
    await store.setToolMode("read_only");
    unsubscribe();
    await store.setToolMode("full_access");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].toolMode).toBe("read_only");
    await expect(ProjectStore.open(cwd, "read_only")).resolves.toMatchObject({
      toolMode: "full_access",
    });
  });

  it("persists full-access mode in the project manifest", async () => {
    const cwd = await createTemporaryDirectory("piweb-project-full-access-");
    const store = await ProjectStore.open(cwd, "full_access");

    await store.setToolMode("full_access");

    await expect(ProjectStore.open(cwd, "read_only")).resolves.toMatchObject({
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

  it("serializes deletion behind an older refresh and only clears the matching recent pointer", async () => {
    const cwd = await createTemporaryDirectory("piweb-delete-refresh-race-");
    const store = await ProjectStore.open(cwd, "full_access");
    const retained = await store.createConversation();
    const deleted = await store.createConversation();
    await store.setLastConversation(deleted.getSessionId());
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

  it("strictly serializes refreshes so an older scan cannot overwrite a newer cache", async () => {
    const cwd = await createTemporaryDirectory("piweb-refresh-queue-");
    const store = await ProjectStore.open(cwd, "full_access");
    const conversation = await store.createConversation();
    const sessionFile = conversation.getSessionFile()!;
    const firstScan = createDeferred<SessionInfo[]>();
    const secondScan = createDeferred<SessionInfo[]>();
    const listAll = vi
      .spyOn(SessionManager, "listAll")
      .mockImplementationOnce(() => firstScan.promise)
      .mockImplementationOnce(() => secondScan.promise);

    const firstRefresh = store.refreshConversations();
    await vi.waitFor(() => expect(listAll).toHaveBeenCalledTimes(1));
    const secondRefresh = store.refreshConversations();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(listAll).toHaveBeenCalledTimes(1);

    firstScan.resolve([
      sessionInformation(sessionFile, conversation.getSessionId(), {
        name: "older scan",
      }),
    ]);
    await expect(firstRefresh).resolves.toEqual([
      expect.objectContaining({ name: "older scan" }),
    ]);
    await vi.waitFor(() => expect(listAll).toHaveBeenCalledTimes(2));

    secondScan.resolve([
      sessionInformation(sessionFile, conversation.getSessionId(), {
        name: "newer scan",
        modified: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ]);
    await expect(secondRefresh).resolves.toEqual([
      expect.objectContaining({ name: "newer scan" }),
    ]);
    expect(store.listConversations()).toEqual([
      expect.objectContaining({ name: "newer scan" }),
    ]);
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
        /empty|identity|header|unsupported/,
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
