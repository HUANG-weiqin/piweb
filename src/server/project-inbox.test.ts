import { createHash, randomUUID } from "node:crypto";
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
import {
  MAX_INBOX_MESSAGES_PER_PROJECT,
  MAX_INBOX_MESSAGES_PER_TARGET,
  MAX_INBOX_TOTAL_BYTES,
  ProjectInbox,
  createInboxEnvelope,
  inboxEnvelopePayloadFingerprint,
  parseInboxEnvelope,
} from "./project-inbox.js";

const timestamp = "2026-07-19T10:00:00.000Z";

async function temporaryInbox(prefix: string): Promise<{
  directory: string;
  inbox: ProjectInbox;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const directory = join(root, "inbox");
  return {
    directory,
    inbox: await ProjectInbox.open(directory),
  };
}

function peer(conversationId = randomUUID()) {
  return {
    conversationId,
    title: "Parser worker",
    role: {
      id: "default",
      name: "Worker",
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const fromConversationId =
    typeof overrides.fromConversationId === "string"
      ? overrides.fromConversationId
      : randomUUID();
  const toConversationId =
    typeof overrides.toConversationId === "string"
      ? overrides.toConversationId
      : randomUUID();
  const kind =
    typeof overrides.kind === "string"
      ? overrides.kind
      : "message";
  return {
    messageId: randomUUID(),
    cardId: randomUUID(),
    fromConversationId,
    toConversationId,
    sentAt: timestamp,
    kind: "message" as const,
    body: "Please implement the parser.",
    fromSnapshot: peer(fromConversationId),
    toSnapshot: peer(toConversationId),
    ...(kind === "message" ? {} : { delegationId: randomUUID() }),
    ...overrides,
    fromRunId: typeof overrides.fromRunId === "string"
      ? overrides.fromRunId
      : randomUUID(),
  };
}

async function writeEnvelope(
  directory: string,
  value: ReturnType<typeof input>,
): Promise<void> {
  const envelope = createInboxEnvelope(value);
  await writeFile(
    join(directory, `${envelope.messageId}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
}

function maximumEnvelopeBytes(value: ReturnType<typeof input>): number {
  const envelope = createInboxEnvelope(value);
  return Buffer.byteLength(`${JSON.stringify({
    ...envelope,
    state: "processing",
    processingRunId: "ffffffff-ffff-8fff-bfff-ffffffffffff",
    processingDelivery: "steer",
    waitedByRunId: "ffffffff-ffff-8fff-bfff-ffffffffffff",
  }, null, 2)}\n`, "utf8");
}

function queuedEnvelopeBytes(value: ReturnType<typeof input>): number {
  return Buffer.byteLength(`${JSON.stringify(createInboxEnvelope(value), null, 2)}\n`, "utf8");
}

function tombstonePath(
  directory: string,
  conversationId: string,
): string {
  const identity = createHash("sha256")
    .update(conversationId, "utf8")
    .digest("hex");
  return join(
    directory,
    `target-${identity}.tombstone.json`,
  );
}

async function writeTombstone(
  directory: string,
  conversationId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    tombstonePath(directory, conversationId),
    `${JSON.stringify({
      version: 1,
      conversationId,
      deletedAt: timestamp,
      ...overrides,
    }, null, 2)}\n`,
  );
}

describe("ProjectInbox envelope schema", () => {
  it("constructs queued v1 envelopes and rejects unknown fields or state pairs", () => {
    const envelope = createInboxEnvelope(input());

    expect(envelope).toMatchObject({
      version: 1,
      state: "queued",
    });
    expect(parseInboxEnvelope(envelope)).toEqual(envelope);
    expect(() => parseInboxEnvelope({
      ...envelope,
      unknown: true,
    })).toThrow(/unknown|unrecognized/i);
    expect(() => parseInboxEnvelope({
      ...envelope,
      kind: "anything",
    })).toThrow(/kind/i);
    expect(() => parseInboxEnvelope({
      ...envelope,
      processingRunId: randomUUID(),
    })).toThrow(/processingRunId/i);
    expect(() => parseInboxEnvelope({
      ...envelope,
      state: "processing",
    })).toThrow(/processingRunId/i);
    expect(() => parseInboxEnvelope({
      ...envelope,
      processingDelivery: "steer",
    })).toThrow(/processingDelivery/i);
    expect(() => parseInboxEnvelope({
      ...envelope,
      waitedByRunId: randomUUID(),
    })).toThrow(/waitedByRunId/i);
    expect(() => parseInboxEnvelope({
      ...envelope,
      fromRunId: "not-a-run-id",
    })).toThrow(/fromRunId/i);
    const missingFromRunId = { ...envelope } as Record<string, unknown>;
    delete missingFromRunId.fromRunId;
    expect(() => parseInboxEnvelope(missingFromRunId)).toThrow(/fromRunId/i);
    expect(() => parseInboxEnvelope({
      ...envelope,
      temporaryReturnAssignment: {
        initialRunId: randomUUID(),
        callerRunId: randomUUID(),
        assignedAt: timestamp,
      },
    })).toThrow(/unknown|unrecognized/i);
    expect(() => createInboxEnvelope(input({
      body: "   ",
    }))).toThrow(/body/i);
  });
});

describe("inboxEnvelopePayloadFingerprint", () => {
  it("binds immutable payload without binding transport state", () => {
    const value = input({ fromRunId: randomUUID() });
    const runId = randomUUID();
    const queued = createInboxEnvelope(value);
    const processing = createInboxEnvelope(value, {
      state: "processing",
      processingRunId: runId,
      processingDelivery: "steer",
      waitedByRunId: runId,
    });

    expect(inboxEnvelopePayloadFingerprint(processing)).toBe(
      inboxEnvelopePayloadFingerprint(queued),
    );
    expect(inboxEnvelopePayloadFingerprint(createInboxEnvelope({
      ...value,
      body: "A different immutable body",
    }))).not.toBe(inboxEnvelopePayloadFingerprint(queued));
  });
});

describe("ProjectInbox", () => {
  it("atomically persists one envelope per message and is idempotent by payload", async () => {
    const { directory, inbox } = await temporaryInbox("piweb-inbox-put-");
    const value = input();

    const results = await Promise.all([
      inbox.put(value),
      inbox.put(value),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        status: "created",
        envelope: expect.objectContaining({
          messageId: value.messageId,
          state: "queued",
        }),
      }),
      expect.objectContaining({ status: "existing" }),
    ]);

    const path = join(directory, `${value.messageId}.json`);
    expect((await lstat(path)).isFile()).toBe(true);
    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify(createInboxEnvelope(value), null, 2)}\n`,
    );
    expect((await inbox.list()).map(({ messageId }) => messageId)).toEqual([
      value.messageId,
    ]);
  });

  it("rejects the same message ID with a different immutable payload", async () => {
    const { inbox } = await temporaryInbox("piweb-inbox-conflict-");
    const value = input();
    await inbox.put(value);

    await expect(inbox.put({
      ...value,
      body: "different",
    })).rejects.toThrow(/conflict/i);
    await expect(inbox.list()).resolves.toEqual([
      expect.objectContaining({ body: value.body }),
    ]);
  });

  it("updates state atomically without making a sender retry conflict", async () => {
    const { inbox } = await temporaryInbox("piweb-inbox-state-");
    const value = input();
    const runId = randomUUID();
    const waitedByRunId = runId;
    await inbox.put(value);

    await expect(inbox.put(value, {
      initialState: {
        state: "processing",
        processingRunId: runId,
        processingDelivery: "steer",
        waitedByRunId,
      },
    })).resolves.toMatchObject({
      status: "existing",
      envelope: {
        state: "processing",
        processingRunId: runId,
        processingDelivery: "steer",
        waitedByRunId,
      },
    });
    await expect(inbox.put(value)).resolves.toMatchObject({
      status: "existing",
      envelope: {
        state: "processing",
        processingRunId: runId,
        processingDelivery: "steer",
        waitedByRunId,
      },
    });
    await expect(
      inbox.updateState(value.messageId, { state: "queued" }),
    ).resolves.toMatchObject({
      state: "queued",
    });
    await expect(inbox.get(value.messageId)).resolves.toEqual(
      expect.not.objectContaining({
        processingRunId: expect.anything(),
        processingDelivery: expect.anything(),
        waitedByRunId: expect.anything(),
      }),
    );
  });

  it("persists a target tombstone before exact pending cleanup and rejects future puts after reopen", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-tombstone-",
    );
    const deletedTarget = randomUUID();
    const caller = randomUUID();
    const inbound = input({
      fromConversationId: caller,
      toConversationId: deletedTarget,
    });
    const outbound = input({
      fromConversationId: deletedTarget,
      toConversationId: caller,
    });
    await inbox.put(inbound);
    await inbox.put(outbound);

    await expect(
      inbox.tombstoneTarget(deletedTarget, timestamp),
    ).resolves.toBe(1);
    expect(await readFile(
      tombstonePath(directory, deletedTarget),
      "utf8",
    )).toBe(`${JSON.stringify({
      version: 1,
      conversationId: deletedTarget,
      deletedAt: timestamp,
    }, null, 2)}\n`);
    await expect(inbox.get(inbound.messageId)).resolves.toBeUndefined();
    await expect(inbox.get(outbound.messageId)).resolves.toBeDefined();
    await expect(
      inbox.tombstoneTarget(
        deletedTarget,
        "2026-07-19T11:00:00.000Z",
      ),
    ).resolves.toBe(0);

    const reopened = await ProjectInbox.open(directory);
    await expect(reopened.list()).resolves.toEqual([
      expect.objectContaining({ messageId: outbound.messageId }),
    ]);
    await expect(
      reopened.put(input({ toConversationId: deletedTarget })),
    ).rejects.toThrow(/target has been deleted/i);
  });

  it("recovers the crash boundary after tombstone commit but before pending cleanup", async () => {
    const { directory } = await temporaryInbox(
      "piweb-inbox-tombstone-recovery-",
    );
    const deletedTarget = randomUUID();
    const pending = input({ toConversationId: deletedTarget });
    await writeEnvelope(directory, pending);
    await writeTombstone(directory, deletedTarget);

    const reopened = await ProjectInbox.open(directory);
    await expect(reopened.list()).resolves.toEqual([
      expect.objectContaining({ messageId: pending.messageId }),
    ]);
    await expect(
      reopened.put(input({ toConversationId: deletedTarget })),
    ).rejects.toThrow(/target has been deleted/i);
    await expect(
      reopened.tombstoneTarget(deletedTarget),
    ).resolves.toBe(1);
    await expect(reopened.list()).resolves.toEqual([]);
    expect(await readFile(
      tombstonePath(directory, deletedTarget),
      "utf8",
    )).toContain(`"conversationId": "${deletedTarget}"`);
  });

  it("clears a completed deletion tombstone only after pending target messages are gone", async () => {
    const { inbox, directory } = await temporaryInbox(
      "piweb-inbox-tombstone-clear-",
    );
    const target = randomUUID();
    const message = input({
      toConversationId: target,
    });
    await inbox.put(message);
    await inbox.markTargetDeleted(target);

    await expect(inbox.clearTargetTombstone(target)).rejects.toThrow(
      "pending messages",
    );
    expect(await lstat(tombstonePath(directory, target))).toBeDefined();

    await inbox.tombstoneTarget(target);
    await expect(inbox.clearTargetTombstone(target)).resolves.toBe(true);
    await expect(inbox.clearTargetTombstone(target)).resolves.toBe(false);
    await expect(lstat(tombstonePath(directory, target))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(inbox.put({
      ...message,
      messageId: randomUUID(),
      cardId: randomUUID(),
    })).resolves.toMatchObject({ status: "created" });
  });

  it("prunes only completed tombstones whose conversations no longer exist", async () => {
    const { inbox, directory } = await temporaryInbox(
      "piweb-inbox-tombstone-prune-",
    );
    const existing = randomUUID();
    const deleted = randomUUID();
    await inbox.tombstoneTarget(existing);
    await inbox.tombstoneTarget(deleted);

    await expect(
      inbox.pruneCompletedTargetTombstones(new Set([existing])),
    ).resolves.toBe(1);
    expect(await lstat(tombstonePath(directory, existing))).toBeDefined();
    await expect(
      lstat(tombstonePath(directory, deleted)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes exact IDs idempotently and rejects malformed IDs", async () => {
    const { inbox } = await temporaryInbox("piweb-inbox-delete-");
    const value = input();
    await inbox.put(value);

    await expect(inbox.delete(value.messageId)).resolves.toBe(true);
    await expect(inbox.delete(value.messageId)).resolves.toBe(false);
    await expect(inbox.delete("../escape")).rejects.toThrow(/messageId/i);
  });

  it("fails closed on linked entries, malformed files, and filename identity mismatch", async () => {
    const linked = await temporaryInbox("piweb-inbox-linked-");
    const outside = await mkdtemp(
      join(tmpdir(), "piweb-inbox-outside-"),
    );
    await symlink(
      outside,
      join(linked.directory, `${randomUUID()}.json`),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(linked.inbox.list()).rejects.toThrow(/regular project-owned file/i);

    const malformed = await temporaryInbox("piweb-inbox-malformed-");
    await writeFile(
      join(malformed.directory, `${randomUUID()}.json`),
      "{not-json}\n",
    );
    await expect(malformed.inbox.list()).rejects.toThrow(/invalid JSON/i);

    const mismatch = await temporaryInbox("piweb-inbox-mismatch-");
    const envelope = createInboxEnvelope(input());
    await writeFile(
      join(mismatch.directory, `${randomUUID()}.json`),
      `${JSON.stringify(envelope)}\n`,
    );
    await expect(mismatch.inbox.list()).rejects.toThrow(/identity/i);
  });

  it("validates tombstones as strict owned sidecars without listing them as envelopes", async () => {
    const valid = await temporaryInbox("piweb-inbox-tombstone-valid-");
    await writeTombstone(valid.directory, randomUUID());
    await expect(valid.inbox.list()).resolves.toEqual([]);

    const malformed = await temporaryInbox(
      "piweb-inbox-tombstone-malformed-",
    );
    await writeTombstone(
      malformed.directory,
      randomUUID(),
      { unknown: true },
    );
    await expect(malformed.inbox.list()).rejects.toThrow(
      /invalid inbox target tombstone/i,
    );

    const mismatched = await temporaryInbox(
      "piweb-inbox-tombstone-mismatch-",
    );
    const filenameTarget = randomUUID();
    await writeTombstone(
      mismatched.directory,
      filenameTarget,
      { conversationId: randomUUID() },
    );
    await expect(mismatched.inbox.list()).rejects.toThrow(
      /filename identity/i,
    );

    const linked = await temporaryInbox(
      "piweb-inbox-tombstone-linked-",
    );
    const outside = await mkdtemp(
      join(tmpdir(), "piweb-inbox-tombstone-outside-"),
    );
    await symlink(
      outside,
      tombstonePath(linked.directory, randomUUID()),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(linked.inbox.list()).rejects.toThrow(
      /regular project-owned file/i,
    );
  });

  it("reserves queued capacity for worst-valid processing transitions", async () => {
    const { directory } = await temporaryInbox(
      "piweb-inbox-reserved-capacity-",
    );
    const seeded = Array.from({ length: 127 }, () => input({
      body: "x".repeat(256 * 1024),
    }));
    await Promise.all(seeded.map((value) => writeEnvelope(directory, value)));
    const reservedSeedBytes = seeded.reduce(
      (total, value) => total + maximumEnvelopeBytes(value),
      0,
    );
    expect(reservedSeedBytes).toBeLessThan(MAX_INBOX_TOTAL_BYTES);
    const inbox = await ProjectInbox.open(directory);
    const remaining = MAX_INBOX_TOTAL_BYTES - reservedSeedBytes;
    const candidate = input({ body: "x" });
    let bodyLength = remaining - queuedEnvelopeBytes(candidate) + 1;
    expect(bodyLength).toBeGreaterThan(1);
    expect(bodyLength).toBeLessThanOrEqual(256 * 1024);
    const overflowing = {
      ...candidate,
      body: "x".repeat(bodyLength),
    };
    expect(queuedEnvelopeBytes(overflowing)).toBeLessThanOrEqual(remaining);
    expect(maximumEnvelopeBytes(overflowing)).toBeGreaterThan(remaining);
    await expect(inbox.put(overflowing)).rejects.toThrow(/total byte limit/i);
    await writeEnvelope(directory, overflowing);
    const legacy = await ProjectInbox.open(directory);
    await expect(legacy.list()).resolves.toHaveLength(seeded.length + 1);
    await expect(legacy.put(input())).rejects.toThrow(/total byte limit/i);
    await expect(legacy.delete(overflowing.messageId)).resolves.toBe(true);

    do {
      bodyLength--;
    } while (maximumEnvelopeBytes({
      ...candidate,
      body: "x".repeat(bodyLength),
    }) > remaining);
    const accepted = {
      ...input(),
      body: "x".repeat(bodyLength),
    };
    await expect(legacy.put(accepted)).resolves.toMatchObject({
      status: "created",
      envelope: { state: "queued" },
    });
    const processingRunId = randomUUID();
    await expect(legacy.updateState(accepted.messageId, {
      state: "processing",
      processingRunId,
      processingDelivery: "steer",
      waitedByRunId: processingRunId,
    })).resolves.toMatchObject({
      state: "processing",
      processingRunId,
      processingDelivery: "steer",
      waitedByRunId: processingRunId,
    });
    await expect(legacy.markTargetDeleted(
      accepted.toConversationId,
      timestamp,
    )).resolves.toBeUndefined();
    const reopened = await ProjectInbox.open(directory);
    await expect(reopened.listDeletedTargets()).resolves.toContain(
      accepted.toConversationId,
    );
    await expect(reopened.list({
      toConversationId: accepted.toConversationId,
    })).resolves.toEqual([
      expect.objectContaining({ messageId: accepted.messageId }),
    ]);
  }, 20_000);

  it("includes tombstone sidecars in the inbox byte limit", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-tombstone-byte-limit-",
    );
    const target = randomUUID();
    await writeFile(
      tombstonePath(directory, target),
      "x".repeat(MAX_INBOX_TOTAL_BYTES + 1),
    );

    await expect(inbox.list()).rejects.toThrow(/tombstone byte limit/i);
  });

  it("rejects a linked inbox directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "piweb-inbox-dir-link-"));
    const outside = await mkdtemp(join(tmpdir(), "piweb-inbox-dir-target-"));
    const link = join(root, "inbox");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

    await expect(ProjectInbox.open(link)).rejects.toThrow(
      /must not be a symbolic link or junction|project-owned path/i,
    );
  });

  it("enforces per-target and project message limits", async () => {
    const perTarget = await temporaryInbox("piweb-inbox-target-limit-");
    const target = randomUUID();
    await Promise.all(
      Array.from(
        { length: MAX_INBOX_MESSAGES_PER_TARGET },
        () => writeEnvelope(
          perTarget.directory,
          input({ toConversationId: target }),
        ),
      ),
    );
    await expect(
      perTarget.inbox.put(input({ toConversationId: target })),
    ).rejects.toThrow(/target.*limit/i);

    const project = await temporaryInbox("piweb-inbox-project-limit-");
    await Promise.all(
      Array.from(
        { length: MAX_INBOX_MESSAGES_PER_PROJECT },
        () => writeEnvelope(project.directory, input()),
      ),
    );
    await expect(project.inbox.put(input())).rejects.toThrow(
      /project.*limit/i,
    );
  }, 15_000);

  it("fails closed before reading an inbox whose sidecars exceed the byte limit", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-byte-limit-",
    );
    await writeFile(
      join(directory, `${randomUUID()}.json`),
      "x".repeat(MAX_INBOX_TOTAL_BYTES + 1),
    );

    await expect(inbox.list()).rejects.toThrow(/total byte limit/i);
  });
});
