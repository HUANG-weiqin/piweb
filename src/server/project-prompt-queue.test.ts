import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PROMPT_CHARACTERS } from "../shared/protocol.js";
import {
  MAX_PENDING_PROMPTS_PER_CONVERSATION,
  MAX_PENDING_PROMPTS_PER_PROJECT,
  MAX_PENDING_PROMPT_ATTENTION_REASON_CHARACTERS,
  MAX_PENDING_PROMPT_TOTAL_BYTES,
  ProjectPromptQueue,
  createQueuedProjectPrompt,
  parseProjectPromptRecord,
} from "./project-prompt-queue.js";

const timestamp = "2026-07-24T10:00:00.000Z";

async function temporaryQueue(prefix: string): Promise<{
  directory: string;
  queue: ProjectPromptQueue;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const directory = join(root, "pending-prompts");
  return {
    directory,
    queue: await ProjectPromptQueue.open(directory),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    promptId: randomUUID(),
    conversationId: randomUUID(),
    text: "Continue after the other agent replies.",
    createdAt: timestamp,
    ...overrides,
  };
}

async function writeQueuedPrompt(
  directory: string,
  value: ReturnType<typeof input>,
): Promise<void> {
  const prompt = createQueuedProjectPrompt(value);
  await writeFile(
    join(directory, `${prompt.promptId}.json`),
    `${JSON.stringify(prompt, null, 2)}\n`,
  );
}

describe("ProjectPromptQueue record schema", () => {
  it("accepts only strict state-specific v1 records", () => {
    const queued = createQueuedProjectPrompt(input());

    expect(queued).toMatchObject({ version: 1, state: "queued" });
    expect(parseProjectPromptRecord(queued)).toEqual(queued);
    expect(() => parseProjectPromptRecord({ ...queued, unknown: true })).toThrow(
      /unknown|unrecognized/i,
    );
    expect(() => parseProjectPromptRecord({ ...queued, text: "   " })).toThrow(
      /blank/i,
    );
    expect(() => createQueuedProjectPrompt({
      ...input(),
      text: "x".repeat(MAX_PROMPT_CHARACTERS + 1),
    })).toThrow(/at most|too big/i);
    expect(() => parseProjectPromptRecord({
      ...queued,
      runId: randomUUID(),
    })).toThrow(/queued.*forbid/i);
    expect(() => parseProjectPromptRecord({
      ...queued,
      state: "dispatching",
    })).toThrow(/require runId/i);
    expect(() => parseProjectPromptRecord({
      ...queued,
      state: "dispatching",
      runId: randomUUID(),
      dispatchedAt: timestamp,
      reason: "not allowed",
    })).toThrow(/forbid attention/i);
    expect(() => parseProjectPromptRecord({
      ...queued,
      state: "attention",
    })).toThrow(/require reason/i);
    expect(() => parseProjectPromptRecord({
      ...queued,
      state: "attention",
      reason: "uncertain provider result",
      attentionAt: timestamp,
      runId: randomUUID(),
      dispatchedAt: timestamp,
    })).toThrow(/forbid dispatching/i);
    expect(() => parseProjectPromptRecord({
      ...queued,
      state: "attention",
      reason: "x".repeat(MAX_PENDING_PROMPT_ATTENTION_REASON_CHARACTERS + 1),
      attentionAt: timestamp,
    })).toThrow(/at most|too big/i);
  });
});

describe("ProjectPromptQueue", () => {
  it("atomically persists queued prompts and is idempotent by immutable payload", async () => {
    const { directory, queue } = await temporaryQueue("piweb-prompt-put-");
    const value = input();

    await expect(Promise.all([queue.put(value), queue.put(value)])).resolves.toEqual([
      expect.objectContaining({ status: "created" }),
      expect.objectContaining({ status: "existing" }),
    ]);
    const path = join(directory, `${value.promptId}.json`);
    expect((await lstat(path)).isFile()).toBe(true);
    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify(createQueuedProjectPrompt(value), null, 2)}\n`,
    );
    await expect(queue.put({ ...value, text: "different" })).rejects.toThrow(
      /conflict/i,
    );
  });

  it("lists prompts FIFO by createdAt then promptId and can filter a conversation", async () => {
    const { queue } = await temporaryQueue("piweb-prompt-fifo-");
    const conversationId = randomUUID();
    const first = input({
      conversationId,
      createdAt: "2026-07-24T10:00:02.000Z",
    });
    const second = input({
      conversationId,
      createdAt: "2026-07-24T10:00:01.000Z",
    });
    const other = input({ createdAt: "2026-07-24T10:00:00.000Z" });
    await queue.put(first);
    await queue.put(second);
    await queue.put(other);

    expect((await queue.list()).map(({ promptId }) => promptId)).toEqual([
      other.promptId,
      second.promptId,
      first.promptId,
    ]);
    expect((await queue.list({ conversationId })).map(({ promptId }) => promptId)).toEqual([
      second.promptId,
      first.promptId,
    ]);
  });

  it("allows only the specified dispatch lifecycle transitions", async () => {
    const { queue } = await temporaryQueue("piweb-prompt-lifecycle-");
    const value = input();
    const runId = randomUUID();
    await queue.put(value);

    await expect(queue.markDispatching(
      value.promptId,
      value.conversationId,
      runId,
      timestamp,
    )).resolves.toMatchObject({ state: "dispatching", runId });
    await expect(queue.requeueAfterDeterministicRejection(
      value.promptId,
      value.conversationId,
      randomUUID(),
    )).rejects.toThrow(/runId/i);
    await expect(queue.requeueAfterDeterministicRejection(
      value.promptId,
      value.conversationId,
      runId,
    )).resolves.toMatchObject({ state: "queued" });

    const uncertainRunId = randomUUID();
    await queue.markDispatching(
      value.promptId,
      value.conversationId,
      uncertainRunId,
      timestamp,
    );
    await expect(queue.markAttentionAfterUncertainFailure(
      value.promptId,
      value.conversationId,
      uncertainRunId,
      "The provider may have accepted the request before disconnecting.",
      "2026-07-24T10:00:03.000Z",
    )).resolves.toMatchObject({ state: "attention" });
    await expect(queue.requeueAfterDeterministicRejection(
      value.promptId,
      value.conversationId,
      uncertainRunId,
    )).rejects.toThrow(/not dispatching/i);
    await expect(queue.removeForHostCleanup(
      value.promptId,
      value.conversationId,
    )).resolves.toBe(true);
  });

  it("withdraws only exact queued prompts; host cleanup is a separate boundary", async () => {
    const { queue } = await temporaryQueue("piweb-prompt-withdraw-");
    const queued = input();
    await queue.put(queued);

    await expect(queue.withdrawQueued(
      queued.promptId,
      randomUUID(),
    )).rejects.toThrow(/identity/i);
    await expect(queue.removeForHostCleanup(
      queued.promptId,
      queued.conversationId,
    )).rejects.toThrow(/withdrawn/i);
    await expect(queue.withdrawQueued(
      queued.promptId,
      queued.conversationId,
    )).resolves.toBe(true);
    await expect(queue.withdrawQueued(
      queued.promptId,
      queued.conversationId,
    )).resolves.toBe(false);

    const claimed = input();
    await queue.put(claimed);
    await queue.markDispatching(
      claimed.promptId,
      claimed.conversationId,
      randomUUID(),
      timestamp,
    );
    await expect(queue.withdrawQueued(
      claimed.promptId,
      claimed.conversationId,
    )).rejects.toThrow(/only queued/i);
    await expect(queue.removeForHostCleanup(
      claimed.promptId,
      claimed.conversationId,
    )).resolves.toBe(true);
  });

  it("fails closed on linked directories or entries, unsafe IDs, and unknown files", async () => {
    const root = await mkdtemp(join(tmpdir(), "piweb-prompt-dir-link-"));
    const outside = await mkdtemp(join(tmpdir(), "piweb-prompt-dir-target-"));
    const linkedDirectory = join(root, "pending-prompts");
    await symlink(
      outside,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(ProjectPromptQueue.open(linkedDirectory)).rejects.toThrow(
      /symbolic link or junction|project-owned path/i,
    );

    const linked = await temporaryQueue("piweb-prompt-entry-link-");
    await symlink(
      outside,
      join(linked.directory, `${randomUUID()}.json`),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(linked.queue.list()).rejects.toThrow(/regular project-owned file/i);
    await expect(linked.queue.withdrawQueued("../escape", randomUUID())).rejects.toThrow(
      /promptId/i,
    );

    const unknown = await temporaryQueue("piweb-prompt-unknown-");
    await writeFile(join(unknown.directory, "unexpected.tmp"), "x\n");
    await expect(unknown.queue.list()).rejects.toThrow(/invalid prompt queue entry name/i);
  });

  it("enforces conversation, project, and total-byte limits", async () => {
    const perConversation = await temporaryQueue("piweb-prompt-conversation-limit-");
    const conversationId = randomUUID();
    await Promise.all(Array.from(
      { length: MAX_PENDING_PROMPTS_PER_CONVERSATION },
      () => writeQueuedPrompt(perConversation.directory, input({ conversationId })),
    ));
    await expect(perConversation.queue.put(input({ conversationId }))).rejects.toThrow(
      /conversation.*limit/i,
    );

    const project = await temporaryQueue("piweb-prompt-project-limit-");
    await Promise.all(Array.from(
      { length: MAX_PENDING_PROMPTS_PER_PROJECT },
      () => writeQueuedPrompt(project.directory, input()),
    ));
    await expect(project.queue.put(input())).rejects.toThrow(/project.*limit/i);

    const bytes = await temporaryQueue("piweb-prompt-byte-limit-");
    await writeFile(
      join(bytes.directory, `${randomUUID()}.json`),
      "x".repeat(MAX_PENDING_PROMPT_TOTAL_BYTES + 1),
    );
    await expect(bytes.queue.list()).rejects.toThrow(/total byte limit/i);
  }, 15_000);

  it("reserves queued capacity for worst-valid dispatch and attention transitions", async () => {
    const { directory, queue } = await temporaryQueue("piweb-prompt-reserve-");
    const text = "x".repeat(MAX_PROMPT_CHARACTERS);
    const sample = input({ text });
    const maxUuid = "ffffffff-ffff-8fff-bfff-ffffffffffff";
    const maxTimestamp = "+275760-09-13T00:00:00.000Z";
    const maxReason = "\0".repeat(
      MAX_PENDING_PROMPT_ATTENTION_REASON_CHARACTERS,
    );
    const serializedBytes = (value: unknown) => Buffer.byteLength(
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    const queuedBytes = serializedBytes(createQueuedProjectPrompt(sample));
    const reservedBytes = Math.max(
      queuedBytes,
      serializedBytes({
        version: 1,
        ...sample,
        state: "dispatching",
        runId: maxUuid,
        dispatchedAt: maxTimestamp,
      }),
      serializedBytes({
        version: 1,
        ...sample,
        state: "attention",
        reason: maxReason,
        attentionAt: maxTimestamp,
      }),
    );
    const recordCount = Math.floor(
      MAX_PENDING_PROMPT_TOTAL_BYTES / reservedBytes,
    );
    const conversations = Array.from({ length: 4 }, () => randomUUID());
    const accepted = Array.from({ length: recordCount }, (_, index) => input({
      text,
      conversationId: conversations[index % conversations.length],
    }));
    await Promise.all(accepted.map((value) =>
      writeQueuedPrompt(directory, value)
    ));

    const candidate = input({ text, conversationId: conversations[0] });
    expect((recordCount + 1) * queuedBytes)
      .toBeLessThanOrEqual(MAX_PENDING_PROMPT_TOTAL_BYTES);
    await expect(queue.put(candidate)).rejects.toThrow(/reserved byte limit/i);
    await writeQueuedPrompt(directory, candidate);
    const legacy = await ProjectPromptQueue.open(directory);
    await expect(legacy.list()).resolves.toHaveLength(recordCount + 1);
    await expect(legacy.put(input({
      text,
      conversationId: conversations[0],
    }))).rejects.toThrow(/reserved byte limit/i);

    const transitioned = accepted[0]!;
    const runId = randomUUID();
    await expect(legacy.markDispatching(
      transitioned.promptId,
      transitioned.conversationId,
      runId,
      timestamp,
    )).resolves.toMatchObject({ state: "dispatching" });
    await expect(legacy.markAttentionAfterUncertainFailure(
      transitioned.promptId,
      transitioned.conversationId,
      runId,
      maxReason,
      timestamp,
    )).resolves.toMatchObject({ state: "attention", reason: maxReason });
    const reopened = await ProjectPromptQueue.open(directory);
    await expect(reopened.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        promptId: transitioned.promptId,
        state: "attention",
        reason: maxReason,
      }),
    ]));
  }, 30_000);

  it("reopens persisted state without losing attention records", async () => {
    const { directory, queue } = await temporaryQueue("piweb-prompt-reopen-");
    const value = input();
    const runId = randomUUID();
    await queue.put(value);
    await queue.markDispatching(value.promptId, value.conversationId, runId, timestamp);
    await queue.markAttentionAfterUncertainFailure(
      value.promptId,
      value.conversationId,
      runId,
      "Unable to determine whether the provider accepted the request.",
      "2026-07-24T10:00:01.000Z",
    );

    const reopened = await ProjectPromptQueue.open(directory);
    await expect(reopened.list()).resolves.toEqual([
      expect.objectContaining({
        promptId: value.promptId,
        state: "attention",
      }),
    ]);
  });
});
