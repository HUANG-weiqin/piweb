import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    lstat: vi.fn(actual.lstat),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});
const nativeFs = await vi.importActual<typeof import("node:fs/promises")>(
  "node:fs/promises",
);
import {
  ConversationNotebook,
  deleteConversationNotebook,
  MAX_NOTE_CONTENT_BYTES,
  MAX_NOTE_COUNT,
} from "./conversation-notebook.js";
import { createNotebookTools } from "./notebook-tools.js";

interface ToolResult<Details> {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
}

const temporaryDirectories: string[] = [];

async function createStateDir(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "piweb-notebook-tools-"));
  temporaryDirectories.push(cwd);
  const stateDir = join(cwd, ".piweb");
  await mkdir(stateDir);
  return stateDir;
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

async function executeTool<Details>(
  tool: ToolDefinition,
  input: unknown,
): Promise<ToolResult<Details>> {
  return tool.execute(
    "tool-call",
    input as never,
    undefined,
    undefined,
    undefined as never,
  ) as Promise<ToolResult<Details>>;
}

function artifactPath(
  stateDir: string,
  conversationId: string,
  operation: "create" | "replace" | "delete",
  transactionId: string,
  stage: "tmp" | "quarantine",
): string {
  return join(
    stateDir,
    "notebooks",
    `.${conversationId}.json.${operation}.${transactionId}.${stage}`,
  );
}

async function artifactNames(
  stateDir: string,
  conversationId: string,
): Promise<string[]> {
  return (await readdir(join(stateDir, "notebooks"))).filter((name) =>
    name.startsWith(`.${conversationId}.json.`)
  );
}

function ioError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EIO" });
}

async function prepareNotebook(conversationId = "conversation-a"): Promise<{
  stateDir: string;
  tools: ToolDefinition[];
  file: string;
  original: string;
  replacement: string;
}> {
  const stateDir = await createStateDir();
  const tools = createNotebookTools(stateDir, conversationId);
  await executeTool(toolByName(tools, "notebook_write"), {
    title: "Original",
    content: "original",
  });
  const file = join(stateDir, "notebooks", `${conversationId}.json`);
  const original = await readFile(file, "utf8");
  return {
    stateDir,
    tools,
    file,
    original,
    replacement: original.replace("original", "replacement"),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  return { promise: new Promise((next) => { resolve = next; }), resolve };
}

afterEach(async () => {
  vi.mocked(link).mockReset().mockImplementation(nativeFs.link);
  vi.mocked(lstat).mockReset().mockImplementation(nativeFs.lstat);
  vi.mocked(rename).mockReset().mockImplementation(nativeFs.rename);
  vi.mocked(unlink).mockReset().mockImplementation(nativeFs.unlink);
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("createNotebookTools", () => {
  it("exposes only the four narrow notebook schemas", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");

    expect(tools.map((tool) => tool.name)).toEqual([
      "notebook_write",
      "notebook_list",
      "notebook_grep",
      "notebook_read",
    ]);
    expect(Check(toolByName(tools, "notebook_write").parameters, {
      title: "Architecture checkpoint",
      content: "src/server/file.ts:10 - conclusion",
      archived: false,
    })).toBe(true);
    expect(Check(toolByName(tools, "notebook_list").parameters, {
      status: "all",
    })).toBe(true);
    expect(Check(toolByName(tools, "notebook_grep").parameters, {
      pattern: "lease",
      status: "active",
    })).toBe(true);
    expect(Check(toolByName(tools, "notebook_read").parameters, {
      titles: ["Architecture checkpoint"],
    })).toBe(true);

    expect(Check(toolByName(tools, "notebook_write").parameters, {
      title: "Architecture checkpoint",
      tags: ["design"],
    })).toBe(false);
    expect(Check(toolByName(tools, "notebook_grep").parameters, {
      pattern: "lease",
      limit: 10,
    })).toBe(false);
  });

  it("does not overwrite a notebook replacement when quarantine proof finds a swap", async () => {
    const { stateDir, tools, file, replacement } = await prepareNotebook();
    const write = toolByName(tools, "notebook_write");
    const replacementPath = join(stateDir, "notebooks", ".replacement.json");
    const displaced = join(stateDir, "notebooks", ".displaced.json");
    await writeFile(replacementPath, replacement);

    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await nativeFs.rename(source, displaced);
      await nativeFs.rename(replacementPath, source);
      await nativeFs.rename(source, destination);
    });

    await expect(executeTool(write, {
      title: "Original",
      content: "updated",
    })).rejects.toThrow(/changed before mutation/i);
    await expect(readFile(file, "utf8")).resolves.toBe(replacement);
  });

  it("recovers create crash cuts only at the owning notebook operation", async () => {
    const { stateDir, tools, file, original, replacement } = await prepareNotebook();
    const list = toolByName(tools, "notebook_list");
    const temporary = artifactPath(
      stateDir,
      "conversation-a",
      "create",
      randomUUID(),
      "tmp",
    );

    await rm(file);
    await writeFile(temporary, original);
    await expect(executeTool(list, {})).resolves.toMatchObject({
      details: { notes: [] },
    });
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(file, original);
    await nativeFs.link(file, temporary);
    await expect(executeTool(list, {})).resolves.toMatchObject({
      details: { notes: [expect.objectContaining({ title: "Original" })] },
    });
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(temporary, replacement);
    await expect(executeTool(list, {})).rejects.toThrow(/conflicts with published/i);
    await expect(readFile(file, "utf8")).resolves.toBe(original);
    await expect(readFile(temporary, "utf8")).resolves.toBe(replacement);
  });

  it("recovers replace crash cuts from physical inode states", async () => {
    const preRename = await prepareNotebook();
    const preRenameTemporary = artifactPath(
      preRename.stateDir,
      "conversation-a",
      "replace",
      randomUUID(),
      "tmp",
    );
    await writeFile(preRenameTemporary, preRename.replacement);
    await executeTool(toolByName(preRename.tools, "notebook_list"), {});
    await expect(readFile(preRename.file, "utf8")).resolves.toBe(preRename.original);
    await expect(lstat(preRenameTemporary)).rejects.toMatchObject({ code: "ENOENT" });

    const moved = await prepareNotebook();
    const movedId = randomUUID();
    const movedTemporary = artifactPath(
      moved.stateDir,
      "conversation-a",
      "replace",
      movedId,
      "tmp",
    );
    const movedQuarantine = artifactPath(
      moved.stateDir,
      "conversation-a",
      "replace",
      movedId,
      "quarantine",
    );
    await writeFile(movedTemporary, moved.replacement);
    await nativeFs.rename(moved.file, movedQuarantine);
    await executeTool(toolByName(moved.tools, "notebook_list"), {});
    await expect(readFile(moved.file, "utf8")).resolves.toBe(moved.original);
    await expect(artifactNames(moved.stateDir, "conversation-a")).resolves.toEqual([]);

    const committed = await prepareNotebook();
    const committedId = randomUUID();
    const committedTemporary = artifactPath(
      committed.stateDir,
      "conversation-a",
      "replace",
      committedId,
      "tmp",
    );
    const committedQuarantine = artifactPath(
      committed.stateDir,
      "conversation-a",
      "replace",
      committedId,
      "quarantine",
    );
    await writeFile(committedTemporary, committed.replacement);
    await nativeFs.rename(committed.file, committedQuarantine);
    await nativeFs.link(committedTemporary, committed.file);
    await executeTool(toolByName(committed.tools, "notebook_list"), {});
    await expect(readFile(committed.file, "utf8")).resolves.toBe(committed.replacement);
    await expect(artifactNames(committed.stateDir, "conversation-a")).resolves.toEqual([]);

    const restored = await prepareNotebook();
    const restoredId = randomUUID();
    const restoredTemporary = artifactPath(
      restored.stateDir,
      "conversation-a",
      "replace",
      restoredId,
      "tmp",
    );
    const restoredQuarantine = artifactPath(
      restored.stateDir,
      "conversation-a",
      "replace",
      restoredId,
      "quarantine",
    );
    await writeFile(restoredTemporary, restored.replacement);
    await nativeFs.rename(restored.file, restoredQuarantine);
    await nativeFs.link(restoredQuarantine, restored.file);
    await executeTool(toolByName(restored.tools, "notebook_list"), {});
    await expect(readFile(restored.file, "utf8")).resolves.toBe(restored.original);
    await expect(artifactNames(restored.stateDir, "conversation-a")).resolves.toEqual([]);
  });

  it("recovers committed delete cuts and rejects malformed or divergent artifacts", async () => {
    const deleted = await prepareNotebook();
    const deleteTransactionId = randomUUID();
    const deleteTemporary = artifactPath(
      deleted.stateDir,
      "conversation-a",
      "delete",
      deleteTransactionId,
      "tmp",
    );
    const deleteQuarantine = artifactPath(
      deleted.stateDir,
      "conversation-a",
      "delete",
      deleteTransactionId,
      "quarantine",
    );
    await nativeFs.link(deleted.file, deleteTemporary);
    await nativeFs.rename(deleted.file, deleteQuarantine);
    await expect(executeTool(toolByName(deleted.tools, "notebook_list"), {}))
      .resolves.toMatchObject({ details: { notes: [] } });
    await expect(lstat(deleteQuarantine)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(deleteTemporary)).rejects.toMatchObject({ code: "ENOENT" });

    const qOnly = await prepareNotebook();
    const qOnlyTransactionId = randomUUID();
    const qOnlyTemporary = artifactPath(
      qOnly.stateDir,
      "conversation-a",
      "delete",
      qOnlyTransactionId,
      "tmp",
    );
    const qOnlyPath = artifactPath(
      qOnly.stateDir,
      "conversation-a",
      "delete",
      qOnlyTransactionId,
      "quarantine",
    );
    await nativeFs.link(qOnly.file, qOnlyTemporary);
    await nativeFs.rename(qOnly.file, qOnlyPath);
    await nativeFs.unlink(qOnlyTemporary);
    await expect(executeTool(toolByName(qOnly.tools, "notebook_list"), {}))
      .rejects.toThrow(/delete quarantine has no matching temporary/i);
    await expect(readFile(qOnlyPath, "utf8")).resolves.toBe(qOnly.original);

    const malformed = await prepareNotebook();
    const malformedPath = join(
      malformed.stateDir,
      "notebooks",
      ".conversation-a.json.legacy.tmp",
    );
    await writeFile(malformedPath, "legacy");
    await expect(executeTool(toolByName(malformed.tools, "notebook_list"), {}))
      .rejects.toThrow(/legacy notebook mutation artifact/i);
    await expect(readFile(malformedPath, "utf8")).resolves.toBe("legacy");

    const divergent = await prepareNotebook();
    const transactionId = randomUUID();
    const temporary = artifactPath(
      divergent.stateDir,
      "conversation-a",
      "replace",
      transactionId,
      "tmp",
    );
    const quarantine = artifactPath(
      divergent.stateDir,
      "conversation-a",
      "replace",
      transactionId,
      "quarantine",
    );
    await writeFile(temporary, divergent.replacement);
    await nativeFs.rename(divergent.file, quarantine);
    await writeFile(divergent.file, divergent.original.replace("original", "third"));
    await expect(executeTool(toolByName(divergent.tools, "notebook_list"), {}))
      .rejects.toThrow(/conflict with published/i);
    await expect(readFile(divergent.file, "utf8"))
      .resolves.toContain("third");

    const multiple = await prepareNotebook();
    const firstTransaction = artifactPath(
      multiple.stateDir,
      "conversation-a",
      "create",
      randomUUID(),
      "tmp",
    );
    const secondTransaction = artifactPath(
      multiple.stateDir,
      "conversation-a",
      "replace",
      randomUUID(),
      "tmp",
    );
    await writeFile(firstTransaction, multiple.original);
    await writeFile(secondTransaction, multiple.replacement);
    await expect(executeTool(toolByName(multiple.tools, "notebook_list"), {}))
      .rejects.toThrow(/multiple mutation transactions/i);
    await expect(readFile(firstTransaction, "utf8")).resolves.toBe(multiple.original);
    await expect(readFile(secondTransaction, "utf8")).resolves.toBe(multiple.replacement);
  });

  it("keeps another conversation's typed artifacts outside this owner's recovery", async () => {
    const { stateDir, tools, file, original } = await prepareNotebook("conversation-a");
    const unrelated = artifactPath(
      stateDir,
      "conversation-a.more",
      "create",
      randomUUID(),
      "tmp",
    );
    await writeFile(unrelated, original);

    await expect(executeTool(toolByName(tools, "notebook_list"), {}))
      .resolves.toMatchObject({
        details: { notes: [expect.objectContaining({ title: "Original" })] },
      });
    await expect(readFile(file, "utf8")).resolves.toBe(original);
    await expect(readFile(unrelated, "utf8")).resolves.toBe(original);
  });

  it("serializes replacement and cascade deletion across notebook instances", async () => {
    const stateDir = await createStateDir();
    const first = new ConversationNotebook(stateDir, "conversation-a");
    const second = new ConversationNotebook(stateDir, "conversation-a");
    await first.write({ title: "Original", content: "original" });
    const renamed = deferred<void>();
    const release = deferred<void>();
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      const result = await nativeFs.rename(source, destination);
      renamed.resolve(undefined);
      await release.promise;
      return result;
    });

    const writing = first.write({ title: "Original", content: "replacement" });
    await renamed.promise;
    const deleting = deleteConversationNotebook(stateDir, "conversation-a");
    release.resolve(undefined);
    await expect(writing).resolves.toMatchObject({ title: "Original" });
    await expect(deleting).resolves.toBeUndefined();
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
    await expect(second.list()).resolves.toMatchObject({ notes: [] });
  });

  it("rolls back a replace when the Q proof fails after its rename cut", async () => {
    const { stateDir, tools, file, original } = await prepareNotebook();
    const write = toolByName(tools, "notebook_write");
    let failQuarantineProof = true;
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      const result = await nativeFs.rename(source, destination);
      vi.mocked(lstat).mockImplementation((async (
        path: Parameters<typeof lstat>[0],
      ) => {
        if (failQuarantineProof && String(path) === String(destination)) {
          failQuarantineProof = false;
          throw ioError("Q proof failed after rename");
        }
        return nativeFs.lstat(path);
      }) as never);
      return result;
    });

    await expect(executeTool(write, {
      title: "Original",
      content: "replacement",
    })).rejects.toThrow(/quarantine could not be proven/i);
    await expect(readFile(file, "utf8")).resolves.toBe(original);
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
    await expect(executeTool(write, {
      title: "Original",
      content: "replacement",
    })).resolves.toMatchObject({ details: { title: "Original" } });
  });

  it("cleans a pre-commit delete guard after its first F/T proof fails", async () => {
    const { stateDir, file, original } = await prepareNotebook();
    let failGuardProof = true;
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      vi.mocked(lstat).mockImplementation((async (
        path: Parameters<typeof lstat>[0],
      ) => {
        if (failGuardProof && String(path) === String(destination)) {
          failGuardProof = false;
          throw ioError("delete guard proof failed after link");
        }
        return nativeFs.lstat(path);
      }) as never);
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/delete guard proof failed after link/i);
    await expect(readFile(file, "utf8")).resolves.toBe(original);
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
  });

  it("reports deletion after T cleanup first fails while Q remains the guard", async () => {
    const { stateDir, file } = await prepareNotebook();
    let failTemporaryCleanup = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (
        failTemporaryCleanup
        && String(path).includes(".conversation-a.json.delete.")
        && String(path).endsWith(".tmp")
      ) {
        failTemporaryCleanup = false;
        throw ioError("delete temporary cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .resolves.toBeUndefined();
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
  });

  it("recreates the T guard after a transient Q cleanup failure", async () => {
    const { stateDir, file } = await prepareNotebook();
    let failQuarantineCleanup = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (
        failQuarantineCleanup
        && String(path).includes(".conversation-a.json.delete.")
        && String(path).endsWith(".quarantine")
      ) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .resolves.toBeUndefined();
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
  });

  it("leaves distinct typed transactions when Q swaps before provisional guard repair", async () => {
    const { stateDir, file, replacement } = await prepareNotebook();
    let failQuarantineCleanup = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (failQuarantineCleanup && String(path).endsWith(".quarantine")) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);
    vi.mocked(link).mockImplementation(async (source, destination) => {
      if (String(source).endsWith(".quarantine")) {
        await nativeFs.unlink(source);
        await writeFile(source, replacement);
      }
      return nativeFs.link(source, destination);
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(2);
    expect([...new Set(artifacts.map((name) => name.split(".")[4]))]).toHaveLength(2);
    await expect(Promise.all(artifacts.map((name) =>
      readFile(join(stateDir, "notebooks", name), "utf8")
    ))).resolves.toEqual([replacement, replacement]);
  });

  it("leaves distinct typed transactions when Q swaps after provisional guard link", async () => {
    const { stateDir, file, original, replacement } = await prepareNotebook();
    let failQuarantineCleanup = true;
    let swapQuarantine = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (failQuarantineCleanup && String(path).endsWith(".quarantine")) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);
    vi.mocked(link).mockImplementation(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      if (String(source).endsWith(".quarantine")) {
        vi.mocked(lstat).mockImplementation((async (
          candidate: Parameters<typeof lstat>[0],
        ) => {
          if (swapQuarantine && String(candidate) === String(source)) {
            swapQuarantine = false;
            await nativeFs.unlink(candidate);
            await writeFile(candidate, replacement);
          }
          return nativeFs.lstat(candidate);
        }) as never);
      }
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(2);
    expect([...new Set(artifacts.map((name) => name.split(".")[4]))]).toHaveLength(2);
    await expect(Promise.all(artifacts.map((name) =>
      readFile(join(stateDir, "notebooks", name), "utf8")
    ))).resolves.toEqual(expect.arrayContaining([original, replacement]));
  });

  it("leaves a provisional transaction after a crash-cut proof failure", async () => {
    const { stateDir, file, original } = await prepareNotebook();
    let failQuarantineCleanup = true;
    let failProvisionalProof = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (failQuarantineCleanup && String(path).endsWith(".quarantine")) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);
    vi.mocked(link).mockImplementation(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      if (String(source).endsWith(".quarantine")) {
        vi.mocked(lstat).mockImplementation((async (
          candidate: Parameters<typeof lstat>[0],
        ) => {
          if (failProvisionalProof && String(candidate) === String(destination)) {
            failProvisionalProof = false;
            throw ioError("provisional delete guard proof failed");
          }
          return nativeFs.lstat(candidate);
        }) as never);
      }
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(2);
    expect([...new Set(artifacts.map((name) => name.split(".")[4]))]).toHaveLength(2);
    await expect(Promise.all(artifacts.map((name) =>
      readFile(join(stateDir, "notebooks", name), "utf8")
    ))).resolves.toEqual([original, original]);
  });

  it("fails closed when Q swaps after provisional no-clobber installation", async () => {
    const { stateDir, file, original, replacement } = await prepareNotebook();
    let failQuarantineCleanup = true;
    let swapQuarantine = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (failQuarantineCleanup && String(path).endsWith(".quarantine")) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);
    vi.mocked(link).mockImplementation(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      if (String(source).endsWith(".tmp") && String(destination).endsWith(".tmp")) {
        vi.mocked(lstat).mockImplementation((async (
          candidate: Parameters<typeof lstat>[0],
        ) => {
          if (swapQuarantine && String(candidate).endsWith(".quarantine")) {
            swapQuarantine = false;
            await nativeFs.unlink(candidate);
            await writeFile(candidate, replacement);
          }
          return nativeFs.lstat(candidate);
        }) as never);
      }
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(3);
    await expect(Promise.all(artifacts.map((name) =>
      readFile(join(stateDir, "notebooks", name), "utf8")
    ))).resolves.toEqual(expect.arrayContaining([original, replacement]));
  });

  it("preserves an occupied T target during provisional no-clobber installation", async () => {
    const { stateDir, file, replacement } = await prepareNotebook();
    let failQuarantineCleanup = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (failQuarantineCleanup && String(path).endsWith(".quarantine")) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);
    vi.mocked(link).mockImplementation(async (source, destination) => {
      if (String(source).endsWith(".tmp") && String(destination).endsWith(".tmp")) {
        await writeFile(destination, replacement);
      }
      return nativeFs.link(source, destination);
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(3);
    const quarantine = artifacts.find((name) => name.endsWith(".quarantine"));
    const transactionId = quarantine?.split(".")[4];
    const occupiedTemporary = artifacts.find((name) =>
      name === `.conversation-a.json.delete.${transactionId}.tmp`
    );
    expect(occupiedTemporary).toBeDefined();
    await expect(readFile(join(stateDir, "notebooks", occupiedTemporary!), "utf8"))
      .resolves.toBe(replacement);
  });

  it("leaves distinct transactions after the provisional installation crash cut", async () => {
    const { stateDir, file, original } = await prepareNotebook();
    let failQuarantineCleanup = true;
    let failInstalledProof = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (failQuarantineCleanup && String(path).endsWith(".quarantine")) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);
    vi.mocked(link).mockImplementation(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      if (String(source).endsWith(".tmp") && String(destination).endsWith(".tmp")) {
        vi.mocked(lstat).mockImplementation((async (
          candidate: Parameters<typeof lstat>[0],
        ) => {
          if (failInstalledProof && String(candidate) === String(destination)) {
            failInstalledProof = false;
            throw ioError("installed provisional guard proof failed");
          }
          return nativeFs.lstat(candidate);
        }) as never);
      }
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(3);
    await expect(Promise.all(artifacts.map((name) =>
      readFile(join(stateDir, "notebooks", name), "utf8")
    ))).resolves.toEqual([original, original, original]);
  });

  it("fails closed when the provisional artifact swaps before retirement", async () => {
    const { stateDir, file, replacement } = await prepareNotebook();
    let failQuarantineCleanup = true;
    let provisionalProofs = 0;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (failQuarantineCleanup && String(path).endsWith(".quarantine")) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);
    vi.mocked(link).mockImplementation(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      if (String(source).endsWith(".tmp") && String(destination).endsWith(".tmp")) {
        vi.mocked(lstat).mockImplementation((async (
          candidate: Parameters<typeof lstat>[0],
        ) => {
          if (String(candidate) === String(source) && ++provisionalProofs === 2) {
            await nativeFs.unlink(candidate);
            await writeFile(candidate, replacement);
          }
          return nativeFs.lstat(candidate);
        }) as never);
      }
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(3);
    await expect(Promise.all(artifacts.map((name) =>
      readFile(join(stateDir, "notebooks", name), "utf8")
    ))).resolves.toContain(replacement);
  });

  it("preserves the provisional transaction when its cleanup fails", async () => {
    const { stateDir, file, original } = await prepareNotebook();
    let failQuarantineCleanup = true;
    let provisionalPath: string | undefined;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (failQuarantineCleanup && String(path).endsWith(".quarantine")) {
        failQuarantineCleanup = false;
        throw ioError("delete quarantine cleanup failed");
      }
      if (String(path) === provisionalPath) {
        throw ioError("provisional delete cleanup failed");
      }
      return nativeFs.unlink(path);
    }) as never);
    vi.mocked(link).mockImplementation(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      if (String(source).endsWith(".tmp") && String(destination).endsWith(".tmp")) {
        provisionalPath = String(source);
      }
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(provisionalPath).toBeDefined();
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(3);
    await expect(readFile(provisionalPath!, "utf8")).resolves.toBe(original);
  });

  it("fails closed when Q swaps after T cleanup and retains the inode evidence", async () => {
    const { stateDir, file, replacement } = await prepareNotebook();
    let swapQuarantine = true;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      const result = await nativeFs.unlink(path);
      if (String(path).endsWith(".tmp")) {
        vi.mocked(lstat).mockImplementation((async (
          candidate: Parameters<typeof lstat>[0],
        ) => {
          if (swapQuarantine && String(candidate).endsWith(".quarantine")) {
            swapQuarantine = false;
            await nativeFs.unlink(candidate);
            await writeFile(candidate, replacement);
          }
          return nativeFs.lstat(candidate);
        }) as never);
      }
      return result;
    }) as never);

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(1);
    await expect(readFile(join(stateDir, "notebooks", artifacts[0]!), "utf8"))
      .resolves.toBe(replacement);
  });

  it("fails closed when T swaps after Q proof and retains the inode evidence", async () => {
    const { stateDir, file, original, replacement } = await prepareNotebook();
    let swapTemporary = true;
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      const result = await nativeFs.rename(source, destination);
      vi.mocked(lstat).mockImplementation((async (
        path: Parameters<typeof lstat>[0],
      ) => {
        if (swapTemporary && String(path).endsWith(".tmp")) {
          swapTemporary = false;
          await nativeFs.unlink(path);
          await writeFile(path, replacement);
        }
        return nativeFs.lstat(path);
      }) as never);
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(2);
    await expect(Promise.all(artifacts.map((name) =>
      readFile(join(stateDir, "notebooks", name), "utf8")
    ))).resolves.toEqual(expect.arrayContaining([original, replacement]));
  });

  it("fails closed on a delete Q swap and retains the inode evidence", async () => {
    const { stateDir, file, original, replacement } = await prepareNotebook();
    const replacementPath = join(stateDir, "notebooks", ".replacement.json");
    const displaced = join(stateDir, "notebooks", ".displaced.json");
    await writeFile(replacementPath, replacement);
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await nativeFs.rename(source, displaced);
      await nativeFs.rename(replacementPath, source);
      return nativeFs.rename(source, destination);
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not be completed/i);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const artifacts = await artifactNames(stateDir, "conversation-a");
    expect(artifacts).toHaveLength(2);
    await expect(Promise.all(artifacts.map((name) =>
      readFile(join(stateDir, "notebooks", name), "utf8")
    ))).resolves.toEqual(expect.arrayContaining([original, replacement]));
    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .rejects.toThrow(/could not clear|conflict/i);
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual(artifacts);
  });

  it("reports a committed delete after Q proof failure only once recovery proves absence", async () => {
    const { stateDir, file } = await prepareNotebook();
    let failQuarantineProof = true;
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      const result = await nativeFs.rename(source, destination);
      vi.mocked(lstat).mockImplementation((async (
        path: Parameters<typeof lstat>[0],
      ) => {
        if (failQuarantineProof && String(path) === String(destination)) {
          failQuarantineProof = false;
          throw ioError("Q proof failed after delete rename");
        }
        return nativeFs.lstat(path);
      }) as never);
      return result;
    });

    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .resolves.toBeUndefined();
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
  });

  it("reports a committed publication after F/T proof failure only when recovery proves it", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const file = join(stateDir, "notebooks", "conversation-a.json");
    let failPublishedProof = true;
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      vi.mocked(lstat).mockImplementation((async (
        path: Parameters<typeof lstat>[0],
      ) => {
        if (failPublishedProof && String(path) === String(destination)) {
          failPublishedProof = false;
          throw ioError("F/T proof failed after link");
        }
        return nativeFs.lstat(path);
      }) as never);
      return result;
    });

    await expect(executeTool(write, {
      title: "Original",
      content: "published despite the missed first proof",
    })).resolves.toMatchObject({ details: { title: "Original" } });
    await expect(readFile(file, "utf8"))
      .resolves.toContain("published despite the missed first proof");
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);

    let failReplacementProof = true;
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      const result = await nativeFs.link(source, destination);
      vi.mocked(lstat).mockImplementation((async (
        path: Parameters<typeof lstat>[0],
      ) => {
        if (failReplacementProof && String(path) === String(destination)) {
          failReplacementProof = false;
          throw ioError("replacement F/T proof failed after link");
        }
        return nativeFs.lstat(path);
      }) as never);
      return result;
    });
    await expect(executeTool(write, {
      title: "Original",
      content: "replacement published despite the missed first proof",
    })).resolves.toMatchObject({ details: { title: "Original" } });
    await expect(readFile(file, "utf8"))
      .resolves.toContain("replacement published despite the missed first proof");
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
  });

  it("reports a cleanup failure as success only after recovery proves the final state", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const file = join(stateDir, "notebooks", "conversation-a.json");

    let cleanupFailures = 1;
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (cleanupFailures-- > 0) throw ioError("temporary cleanup failed");
      return nativeFs.unlink(path);
    }) as never);
    await expect(executeTool(write, {
      title: "Original",
      content: "original",
    })).resolves.toMatchObject({ details: { title: "Original" } });
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);

    cleanupFailures = 1;
    await expect(executeTool(write, {
      title: "Original",
      content: "replacement",
    })).resolves.toMatchObject({ details: { title: "Original" } });
    await expect(readFile(file, "utf8")).resolves.toContain("replacement");
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);

    cleanupFailures = 1;
    await expect(deleteConversationNotebook(stateDir, "conversation-a"))
      .resolves.toBeUndefined();
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
  });

  it("leaves an unproven cleanup for a later same-file operation to retry", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const list = toolByName(tools, "notebook_list");
    const file = join(stateDir, "notebooks", "conversation-a.json");
    vi.mocked(unlink).mockImplementation((async (
      path: Parameters<typeof unlink>[0],
    ) => {
      if (String(path).includes(".conversation-a.json.create.")) {
        throw ioError("persistent temporary cleanup failure");
      }
      return nativeFs.unlink(path);
    }) as never);

    await expect(executeTool(write, {
      title: "Original",
      content: "original",
    })).rejects.toThrow(/could not be completed/i);
    await expect(readFile(file, "utf8")).resolves.toContain("original");
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toHaveLength(1);

    vi.mocked(unlink).mockReset().mockImplementation(nativeFs.unlink);
    await expect(executeTool(list, {})).resolves.toMatchObject({
      details: { notes: [expect.objectContaining({ title: "Original" })] },
    });
    await expect(artifactNames(stateDir, "conversation-a")).resolves.toEqual([]);
  });

  it("writes, lists, greps, reads, archives, and restores notes", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const list = toolByName(tools, "notebook_list");
    const grep = toolByName(tools, "notebook_grep");
    const read = toolByName(tools, "notebook_read");

    const saved = await executeTool<{
      title: string;
      archived: boolean;
      preview: string;
    }>(write, {
      title: "Deletion lifecycle",
      content: "src/server/project-store.ts:642 deletes the JSONL.\nCascade the notebook sidecar too.",
    });
    expect(saved.details).toMatchObject({
      title: "Deletion lifecycle",
      archived: false,
      preview: "src/server/project-store.ts:642 deletes the JSONL.",
    });
    expect(saved.content[0]?.text).not.toContain("Cascade the notebook sidecar too");

    const active = await executeTool<{
      notes: Array<{ title: string; preview: string; archived: boolean }>;
    }>(list, {});
    expect(active.details.notes).toEqual([
      expect.objectContaining({
        title: "Deletion lifecycle",
        archived: false,
        preview: "src/server/project-store.ts:642 deletes the JSONL.",
      }),
    ]);

    const matches = await executeTool<{
      matches: Array<{ title: string; field: string; line?: number }>;
    }>(grep, { pattern: "CASCADE" });
    expect(matches.details.matches).toEqual([
      expect.objectContaining({
        title: "Deletion lifecycle",
        field: "content",
        line: 2,
      }),
    ]);

    const opened = await executeTool<{
      notes: Array<{ title: string; content: string; archived: boolean }>;
    }>(read, { titles: ["Deletion lifecycle"] });
    expect(opened.details.notes[0]).toMatchObject({
      title: "Deletion lifecycle",
      content: expect.stringContaining("Cascade the notebook sidecar too."),
      archived: false,
    });

    await executeTool(write, {
      title: "Deletion lifecycle",
      archived: true,
    });
    await expect(executeTool<{ notes: unknown[] }>(list, {}))
      .resolves.toMatchObject({ details: { notes: [] } });
    await expect(executeTool<{ notes: unknown[] }>(list, { status: "archived" }))
      .resolves.toMatchObject({
        details: {
          notes: [expect.objectContaining({ title: "Deletion lifecycle" })],
        },
      });
    await expect(executeTool(read, { titles: ["Deletion lifecycle"] }))
      .resolves.toMatchObject({
        details: {
          notes: [expect.objectContaining({ archived: true })],
        },
      });

    await executeTool(write, {
      title: "Deletion lifecycle",
      archived: false,
    });
    await expect(executeTool<{ notes: unknown[] }>(list, {}))
      .resolves.toMatchObject({
        details: {
          notes: [expect.objectContaining({ title: "Deletion lifecycle" })],
        },
      });
  });

  it("isolates notes by conversation id", async () => {
    const stateDir = await createStateDir();
    const first = createNotebookTools(stateDir, "conversation-a");
    const second = createNotebookTools(stateDir, "conversation-b");

    await executeTool(toolByName(first, "notebook_write"), {
      title: "Same title",
      content: "first conversation memory",
    });
    await executeTool(toolByName(second, "notebook_write"), {
      title: "Same title",
      content: "second conversation memory",
    });

    await expect(executeTool(toolByName(first, "notebook_read"), {
      titles: ["Same title"],
    })).resolves.toMatchObject({
      details: {
        notes: [expect.objectContaining({
          content: "first conversation memory",
        })],
      },
    });
    await expect(executeTool(toolByName(second, "notebook_read"), {
      titles: ["Same title"],
    })).resolves.toMatchObject({
      details: {
        notes: [expect.objectContaining({
          content: "second conversation memory",
        })],
      },
    });
  });

  it("bounds read output without exposing a limit parameter", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const read = toolByName(tools, "notebook_read");
    const content = "x".repeat(MAX_NOTE_CONTENT_BYTES);

    await executeTool(write, { title: "First", content });
    await executeTool(write, { title: "Second", content });
    await executeTool(write, { title: "Third", content });

    const opened = await executeTool<{
      notes: Array<{ title: string; content: string; truncated: boolean }>;
      truncated: boolean;
    }>(read, { titles: ["First", "Second", "Third"] });

    expect(opened.details.truncated).toBe(true);
    expect(opened.details.notes.map((note) => note.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(opened.details.notes.every((note) => !note.truncated)).toBe(true);
    expect(opened.content[0]?.text).toContain("output truncated");
    expect(opened.content[0]?.text).not.toContain("# Third");
  });

  it("never commits a notebook file beyond its own reread budget", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const list = toolByName(tools, "notebook_list");
    const escapedContent = "\0".repeat(MAX_NOTE_CONTENT_BYTES);
    let accepted = 0;
    let rejection: unknown;

    for (let index = 0; index < MAX_NOTE_COUNT; index++) {
      try {
        await executeTool(write, {
          title: `Escaped ${index.toString().padStart(3, "0")}`,
          content: escapedContent,
        });
        accepted++;
      } catch (error) {
        rejection = error;
        break;
      }
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toMatch(/file exceeds its safety limit/i);
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(MAX_NOTE_COUNT);
    const listed = await executeTool<{ notes: unknown[] }>(
      list,
      { status: "all" },
    );
    expect(listed.details.notes).toHaveLength(accepted);
  });

  it("requires content for new notes and replaces existing content by title", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const read = toolByName(tools, "notebook_read");

    await expect(executeTool(write, {
      title: "Open question",
      archived: true,
    })).rejects.toThrow(/require content/i);
    await executeTool(write, {
      title: "Open question",
      content: "initial answer",
    });
    await executeTool(write, {
      title: "Open question",
      content: "replacement answer",
    });

    await expect(executeTool(read, { titles: ["Open question"] }))
      .resolves.toMatchObject({
        details: {
          notes: [expect.objectContaining({ content: "replacement answer" })],
        },
      });
  });
});
