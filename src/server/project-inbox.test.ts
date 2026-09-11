import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    lstat: vi.fn(actual.lstat),
    rename: vi.fn(actual.rename),
  };
});
const nativeFs = await vi.importActual<typeof import("node:fs/promises")>(
  "node:fs/promises",
);
import {
  MAX_INBOX_MESSAGES_PER_PROJECT,
  MAX_INBOX_MESSAGES_PER_TARGET,
  MAX_INBOX_TOTAL_BYTES,
  InboxPutOperationError,
  InboxTargetTombstoneCommittedError,
  ProjectInbox,
  createInboxEnvelope,
  inboxEnvelopePayloadFingerprint,
  parseInboxEnvelope,
} from "./project-inbox.js";

const timestamp = "2026-07-19T10:00:00.000Z";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.mocked(link).mockReset().mockImplementation(nativeFs.link);
  vi.mocked(lstat).mockReset().mockImplementation(nativeFs.lstat);
  vi.mocked(rename).mockReset().mockImplementation(nativeFs.rename);
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function temporaryInbox(prefix: string): Promise<{
  directory: string;
  inbox: ProjectInbox;
}> {
  const root = await temporaryDirectory(prefix);
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

function artifactPath(
  directory: string,
  targetPath: string,
  operation: "create" | "replace" | "delete",
  transactionId: string,
  stage: "tmp" | "quarantine",
): string {
  return join(
    directory,
    `.${targetPath.slice(directory.length + 1)}.${operation}.${transactionId}.${stage}`,
  );
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
    expect(envelope).not.toHaveProperty("summary");
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
    expect(() => createInboxEnvelope(input({
      summary: "   ",
    }))).toThrow(/summary/i);
  });

  it("canonicalizes optional summaries without populating legacy envelopes", () => {
    const summary = "  Parser findings\nneed review.  ";
    const envelope = createInboxEnvelope(input({ summary }));

    expect(envelope.summary).toBe("Parser findings\nneed review.");
    expect(parseInboxEnvelope(envelope)).toEqual(envelope);
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
    expect(inboxEnvelopePayloadFingerprint(createInboxEnvelope({
      ...value,
      summary: "A different user summary.",
    }))).not.toBe(inboxEnvelopePayloadFingerprint(queued));
  });

  it("keeps a summary-bearing receipt-only reconstruction fingerprint-stable", () => {
    const runId = randomUUID();
    const canonical = createInboxEnvelope(input({
      summary: "Reconcile a receipt-only message.",
      fromRunId: runId,
    }), {
      state: "processing",
      processingRunId: runId,
    });
    // This matches the receipt-only recovery construction, whose field order
    // need not match the order produced by the envelope parser.
    const reconstructed = {
      version: canonical.version,
      messageId: canonical.messageId,
      cardId: canonical.cardId,
      fromConversationId: canonical.fromConversationId,
      toConversationId: canonical.toConversationId,
      sentAt: canonical.sentAt,
      kind: canonical.kind,
      summary: canonical.summary!,
      body: canonical.body,
      fromRunId: canonical.fromRunId,
      fromSnapshot: canonical.fromSnapshot,
      toSnapshot: canonical.toSnapshot,
      state: canonical.state,
      processingRunId: canonical.processingRunId!,
    };

    expect(inboxEnvelopePayloadFingerprint(reconstructed)).toBe(
      inboxEnvelopePayloadFingerprint(canonical),
    );
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

  it("returns a created envelope after post-link recovery confirms publication", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-post-link-recovery-",
    );
    const value = input();
    const path = join(directory, `${value.messageId}.json`);
    let proofFailed = false;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (!proofFailed && String(args[0]) === path) {
        proofFailed = true;
        throw new Error("post-link ownership proof failed");
      }
      return nativeFs.lstat(...args);
    });

    await expect(inbox.put(value)).resolves.toMatchObject({
      status: "created",
      envelope: { messageId: value.messageId },
    });
    expect(proofFailed).toBe(true);
    await expect(inbox.get(value.messageId)).resolves.toMatchObject({
      messageId: value.messageId,
    });
  });

  it("reports committed_or_unknown when post-link publication cannot be proven", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-post-link-unknown-",
    );
    const value = input();
    const path = join(directory, `${value.messageId}.json`);
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (String(args[0]) === path) {
        throw new Error("post-link ownership proof remains unavailable");
      }
      return nativeFs.lstat(...args);
    });

    await expect(inbox.put(value)).rejects.toMatchObject({
      outcome: "committed_or_unknown",
    } satisfies Partial<InboxPutOperationError>);
  });

  it("reports committed_or_unknown when EEXIST publication is ambiguous", async () => {
    const { inbox } = await temporaryInbox("piweb-inbox-eexist-unknown-");
    const value = input();
    const error = new Error("publication response interrupted") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    vi.mocked(link).mockRejectedValueOnce(error);

    await expect(inbox.put(value)).rejects.toMatchObject({
      outcome: "committed_or_unknown",
    } satisfies Partial<InboxPutOperationError>);
    await expect(inbox.get(value.messageId)).resolves.toBeUndefined();
  });

  it("rejects the same message ID with a different immutable payload", async () => {
    const { inbox } = await temporaryInbox("piweb-inbox-conflict-");
    const value = input();
    await inbox.put(value);

    await expect(inbox.put({
      ...value,
      body: "different",
    })).rejects.toThrow(/conflict/i);
    await expect(inbox.put({
      ...value,
      summary: "Different user summary.",
    })).rejects.toThrow(/conflict/i);
    await expect(inbox.list()).resolves.toEqual([
      expect.objectContaining({ body: value.body }),
    ]);
  });

  it("does not overwrite a path replacement after validating an envelope", async () => {
    const { directory, inbox } = await temporaryInbox("piweb-inbox-replace-");
    const value = input();
    await inbox.put(value);
    const target = join(directory, `${value.messageId}.json`);
    const displaced = join(dirname(directory), ".displaced-envelope.json");
    const replacement = join(dirname(directory), ".replacement-envelope.json");
    const replacementRaw = `${JSON.stringify(createInboxEnvelope({
      ...value,
      body: "replacement envelope",
    }), null, 2)}\n`;
    await writeFile(replacement, replacementRaw);

    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await nativeFs.rename(source, displaced);
      await nativeFs.rename(replacement, source);
      await nativeFs.rename(source, destination);
    });

    await expect(inbox.updateState(value.messageId, {
      state: "processing",
      processingRunId: randomUUID(),
    })).rejects.toThrow(/changed before mutation/i);
    await expect(readFile(target, "utf8")).resolves.toBe(replacementRaw);
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

  it("treats a replace as successful when post-commit cleanup recovery preserves the new state", async () => {
    const { inbox } = await temporaryInbox("piweb-inbox-replace-cleanup-");
    const value = input();
    const runId = randomUUID();
    await inbox.put(value);

    let quarantineProofs = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (
        path.includes(`.${value.messageId}.json.replace.`)
        && path.endsWith(".quarantine")
      ) {
        quarantineProofs++;
        if (quarantineProofs === 2) {
          throw new Error("post-commit quarantine cleanup proof failed");
        }
      }
      return nativeFs.lstat(...args);
    });

    await expect(inbox.updateState(value.messageId, {
      state: "processing",
      processingRunId: runId,
    })).resolves.toMatchObject({
      state: "processing",
      processingRunId: runId,
    });
    expect(quarantineProofs).toBeGreaterThanOrEqual(2);
    await expect(inbox.get(value.messageId)).resolves.toMatchObject({
      state: "processing",
      processingRunId: runId,
    });
  });

  it("recovers typed create artifacts before scanning and rejects divergent publication", async () => {
    const { directory } = await temporaryInbox("piweb-inbox-create-recovery-");
    const abandoned = input();
    const abandonedPath = join(directory, `${abandoned.messageId}.json`);
    const abandonedTemporary = artifactPath(
      directory,
      abandonedPath,
      "create",
      randomUUID(),
      "tmp",
    );
    await writeFile(abandonedTemporary, `${JSON.stringify(
      createInboxEnvelope(abandoned),
      null,
      2,
    )}\n`);

    await expect(ProjectInbox.open(directory)).resolves.toBeInstanceOf(ProjectInbox);
    await expect(lstat(abandonedTemporary)).rejects.toMatchObject({ code: "ENOENT" });

    const committed = input();
    const committedPath = join(directory, `${committed.messageId}.json`);
    const committedTemporary = artifactPath(
      directory,
      committedPath,
      "create",
      randomUUID(),
      "tmp",
    );
    const committedRaw = `${JSON.stringify(createInboxEnvelope(committed), null, 2)}\n`;
    await writeFile(committedTemporary, committedRaw);
    await link(committedTemporary, committedPath);

    const recovered = await ProjectInbox.open(directory);
    await expect(readFile(committedPath, "utf8")).resolves.toBe(committedRaw);
    await expect(lstat(committedTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recovered.get(committed.messageId)).resolves.toMatchObject({
      messageId: committed.messageId,
    });

    const conflict = input();
    const conflictPath = join(directory, `${conflict.messageId}.json`);
    await writeEnvelope(directory, conflict);
    await writeFile(artifactPath(
      directory,
      conflictPath,
      "create",
      randomUUID(),
      "tmp",
    ), "different inode\n");
    await expect(ProjectInbox.open(directory)).rejects.toThrow(/conflicts/i);
  });

  it("recovers typed replace artifacts at each crash boundary", async () => {
    const { directory } = await temporaryInbox("piweb-inbox-replace-recovery-");
    const beforeRename = input();
    const beforeRenamePath = join(directory, `${beforeRename.messageId}.json`);
    const oldRaw = `${JSON.stringify(createInboxEnvelope(beforeRename), null, 2)}\n`;
    const newRaw = `${JSON.stringify(createInboxEnvelope({
      ...beforeRename,
      body: "new body",
    }), null, 2)}\n`;
    await writeFile(beforeRenamePath, oldRaw);
    const beforeRenameTemporary = artifactPath(
      directory,
      beforeRenamePath,
      "replace",
      randomUUID(),
      "tmp",
    );
    await writeFile(beforeRenameTemporary, newRaw);

    await ProjectInbox.open(directory);
    await expect(readFile(beforeRenamePath, "utf8")).resolves.toBe(oldRaw);
    await expect(lstat(beforeRenameTemporary)).rejects.toMatchObject({ code: "ENOENT" });

    const betweenRenameAndCommit = input();
    const betweenRenameAndCommitPath = join(
      directory,
      `${betweenRenameAndCommit.messageId}.json`,
    );
    const interruptedTransactionId = randomUUID();
    const interruptedQuarantine = artifactPath(
      directory,
      betweenRenameAndCommitPath,
      "replace",
      interruptedTransactionId,
      "quarantine",
    );
    const interruptedTemporary = artifactPath(
      directory,
      betweenRenameAndCommitPath,
      "replace",
      interruptedTransactionId,
      "tmp",
    );
    const interruptedOldRaw = `${JSON.stringify(
      createInboxEnvelope(betweenRenameAndCommit),
      null,
      2,
    )}\n`;
    await writeFile(interruptedQuarantine, interruptedOldRaw);
    await writeFile(interruptedTemporary, `${JSON.stringify(
      createInboxEnvelope({
        ...betweenRenameAndCommit,
        body: "interrupted replacement",
      }),
      null,
      2,
    )}\n`);

    await ProjectInbox.open(directory);
    await expect(readFile(betweenRenameAndCommitPath, "utf8")).resolves.toBe(
      interruptedOldRaw,
    );
    await expect(lstat(interruptedQuarantine)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(interruptedTemporary)).rejects.toMatchObject({ code: "ENOENT" });

    const rollbackRestored = input();
    const rollbackRestoredPath = join(
      directory,
      `${rollbackRestored.messageId}.json`,
    );
    const rollbackTransactionId = randomUUID();
    const rollbackQuarantine = artifactPath(
      directory,
      rollbackRestoredPath,
      "replace",
      rollbackTransactionId,
      "quarantine",
    );
    const rollbackTemporary = artifactPath(
      directory,
      rollbackRestoredPath,
      "replace",
      rollbackTransactionId,
      "tmp",
    );
    const rollbackOldRaw = `${JSON.stringify(
      createInboxEnvelope(rollbackRestored),
      null,
      2,
    )}\n`;
    await writeFile(rollbackQuarantine, rollbackOldRaw);
    await writeFile(rollbackTemporary, `${JSON.stringify(
      createInboxEnvelope({
        ...rollbackRestored,
        body: "recovery must discard this staged replacement",
      }),
      null,
      2,
    )}\n`);
    // This is the crash boundary inside recovery after link(Q, F), before Q
    // cleanup. F and Q are intentionally the same inode.
    await link(rollbackQuarantine, rollbackRestoredPath);

    await ProjectInbox.open(directory);
    await expect(readFile(rollbackRestoredPath, "utf8")).resolves.toBe(
      rollbackOldRaw,
    );
    await expect(lstat(rollbackQuarantine)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(rollbackTemporary)).rejects.toMatchObject({ code: "ENOENT" });

    const afterCommit = input();
    const afterCommitPath = join(directory, `${afterCommit.messageId}.json`);
    const transactionId = randomUUID();
    const afterCommitTemporary = artifactPath(
      directory,
      afterCommitPath,
      "replace",
      transactionId,
      "tmp",
    );
    const afterCommitQuarantine = artifactPath(
      directory,
      afterCommitPath,
      "replace",
      transactionId,
      "quarantine",
    );
    const afterCommitRaw = `${JSON.stringify(createInboxEnvelope(afterCommit), null, 2)}\n`;
    await writeFile(afterCommitTemporary, afterCommitRaw);
    await link(afterCommitTemporary, afterCommitPath);
    await writeFile(afterCommitQuarantine, newRaw.replace(
      beforeRename.messageId,
      afterCommit.messageId,
    ));

    await ProjectInbox.open(directory);
    await expect(readFile(afterCommitPath, "utf8")).resolves.toBe(afterCommitRaw);
    await expect(lstat(afterCommitTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(afterCommitQuarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on conflicting typed replace and delete artifacts", async () => {
    const { directory } = await temporaryInbox("piweb-inbox-artifact-conflict-");
    const replace = input();
    const replacePath = join(directory, `${replace.messageId}.json`);
    await writeEnvelope(directory, replace);
    await writeFile(artifactPath(
      directory,
      replacePath,
      "replace",
      randomUUID(),
      "quarantine",
    ), "orphan replacement\n");
    await expect(ProjectInbox.open(directory)).rejects.toThrow(
      /quarantine has no matching temporary/i,
    );

    const qOnlyDirectory = (await temporaryInbox(
      "piweb-inbox-replace-q-only-",
    )).directory;
    const qOnly = input();
    const qOnlyPath = join(qOnlyDirectory, `${qOnly.messageId}.json`);
    await writeFile(artifactPath(
      qOnlyDirectory,
      qOnlyPath,
      "replace",
      randomUUID(),
      "quarantine",
    ), `${JSON.stringify(createInboxEnvelope(qOnly), null, 2)}\n`);
    await expect(ProjectInbox.open(qOnlyDirectory)).rejects.toThrow(
      /no matching temporary/i,
    );

    const sharedDirectory = (await temporaryInbox(
      "piweb-inbox-replace-shared-artifacts-",
    )).directory;
    const shared = input();
    const sharedPath = join(sharedDirectory, `${shared.messageId}.json`);
    const sharedTransactionId = randomUUID();
    const sharedQuarantine = artifactPath(
      sharedDirectory,
      sharedPath,
      "replace",
      sharedTransactionId,
      "quarantine",
    );
    await writeFile(sharedQuarantine, `${JSON.stringify(
      createInboxEnvelope(shared),
      null,
      2,
    )}\n`);
    await link(sharedQuarantine, artifactPath(
      sharedDirectory,
      sharedPath,
      "replace",
      sharedTransactionId,
      "tmp",
    ));
    await expect(ProjectInbox.open(sharedDirectory)).rejects.toThrow(
      /share an inode/i,
    );

    const secondDirectory = (await temporaryInbox(
      "piweb-inbox-delete-artifact-conflict-",
    )).directory;
    const deleted = input();
    const deletedPath = join(secondDirectory, `${deleted.messageId}.json`);
    await writeEnvelope(secondDirectory, deleted);
    await writeFile(artifactPath(
      secondDirectory,
      deletedPath,
      "delete",
      randomUUID(),
      "quarantine",
    ), "deleted copy\n");
    await expect(ProjectInbox.open(secondDirectory)).rejects.toThrow(/conflicts/i);

    const legacyDirectory = (await temporaryInbox(
      "piweb-inbox-legacy-artifact-",
    )).directory;
    const legacy = input();
    await writeFile(
      join(
        legacyDirectory,
        `.${legacy.messageId}.json.${process.pid}.${randomUUID()}.tmp`,
      ),
      "legacy mutation artifact\n",
    );
    await expect(ProjectInbox.open(legacyDirectory)).rejects.toThrow(
      /invalid inbox entry name/i,
    );
  });

  it("forwards a typed delete quarantine during recovery", async () => {
    const { directory } = await temporaryInbox("piweb-inbox-delete-recovery-");
    const deleted = input();
    const deletedPath = join(directory, `${deleted.messageId}.json`);
    const quarantine = artifactPath(
      directory,
      deletedPath,
      "delete",
      randomUUID(),
      "quarantine",
    );
    await writeFile(quarantine, `${JSON.stringify(createInboxEnvelope(deleted), null, 2)}\n`);

    const recovered = await ProjectInbox.open(directory);
    await expect(lstat(deletedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recovered.get(deleted.messageId)).resolves.toBeUndefined();
  });

  it("reports a committed tombstone when its post-write verification fails", async () => {
    const { inbox } = await temporaryInbox("piweb-inbox-tombstone-commit-");
    const target = randomUUID();
    const internals = inbox as unknown as {
      scan(): Promise<unknown>;
    };
    const scan = internals.scan.bind(inbox);
    vi.spyOn(internals, "scan")
      .mockImplementationOnce(scan)
      .mockRejectedValueOnce(new Error("post-write verification failed"));

    await expect(inbox.markTargetDeleted(target)).rejects.toMatchObject({
      constructor: InboxTargetTombstoneCommittedError,
      conversationId: target,
    });
  });

  it("treats an EEXIST whose stable census is absent as unpublished", async () => {
    const { inbox } = await temporaryInbox("piweb-inbox-tombstone-absent-");
    const target = randomUUID();
    const error = new Error("target appeared then disappeared") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    vi.mocked(link).mockRejectedValueOnce(error);

    await expect(inbox.markTargetDeleted(target)).rejects.toThrow(
      /was not persisted/i,
    );
    await expect(inbox.listDeletedTargets()).resolves.not.toContain(target);
  });

  it("treats a vanished post-link target as unpublished after a stable census", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-tombstone-vanished-",
    );
    const target = randomUUID();
    const path = tombstonePath(directory, target);
    let removed = false;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (!removed && String(args[0]) === path) {
        removed = true;
        await nativeFs.unlink(path);
        throw new Error("post-link ownership proof failed");
      }
      return nativeFs.lstat(...args);
    });

    await expect(inbox.markTargetDeleted(target)).rejects.toThrow(
      /was not persisted/i,
    );
    await expect(inbox.listDeletedTargets()).resolves.not.toContain(target);
  });

  it("accepts an EEXIST when the stable census proves the tombstone is present", async () => {
    const { directory, inbox } = await temporaryInbox("piweb-inbox-tombstone-present-");
    const target = randomUUID();
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      await nativeFs.link(source, destination);
      const error = new Error("link response interrupted") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    await expect(inbox.markTargetDeleted(target)).resolves.toBeUndefined();
    await expect(nativeFs.lstat(tombstonePath(directory, target))).resolves.toBeDefined();
  });

  it("accepts a link error after publication when the stable census proves the tombstone is present", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-tombstone-link-ambiguous-",
    );
    const target = randomUUID();
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      await nativeFs.link(source, destination);
      const error = new Error("link response interrupted") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    });

    await expect(inbox.markTargetDeleted(target)).resolves.toBeUndefined();
    await expect(nativeFs.lstat(tombstonePath(directory, target))).resolves.toBeDefined();
  });

  it("keeps a published tombstone committed when temporary cleanup and recovery both fail", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-tombstone-cleanup-failure-",
    );
    const target = randomUUID();
    let temporaryProofs = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (path.includes(".create.") && path.endsWith(".tmp")) {
        temporaryProofs++;
        if (temporaryProofs >= 2) {
          throw new Error("temporary cleanup proof failed");
        }
      }
      return nativeFs.lstat(...args);
    });

    await expect(inbox.markTargetDeleted(target)).rejects.toMatchObject({
      constructor: InboxTargetTombstoneCommittedError,
      conversationId: target,
    });
    await expect(nativeFs.lstat(tombstonePath(directory, target))).resolves.toBeDefined();

    vi.mocked(lstat).mockReset().mockImplementation(nativeFs.lstat);
    await expect(inbox.markTargetDeleted(target)).resolves.toBeUndefined();
  });

  it("keeps a tombstone committed when post-link proof fails", async () => {
    const { directory, inbox } = await temporaryInbox(
      "piweb-inbox-tombstone-post-link-",
    );
    const target = randomUUID();
    const path = tombstonePath(directory, target);
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (String(args[0]) === path) {
        throw new Error("post-link ownership proof failed");
      }
      return nativeFs.lstat(...args);
    });

    await expect(inbox.markTargetDeleted(target)).rejects.toMatchObject({
      constructor: InboxTargetTombstoneCommittedError,
      conversationId: target,
    });
    await expect(nativeFs.lstat(path)).resolves.toBeDefined();

    vi.mocked(lstat).mockReset().mockImplementation(nativeFs.lstat);
    await expect(inbox.markTargetDeleted(target)).resolves.toBeUndefined();
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

  it("treats a tombstone clear as successful when post-commit cleanup recovery removes its quarantine", async () => {
    const { inbox, directory } = await temporaryInbox(
      "piweb-inbox-tombstone-clear-recovery-",
    );
    const target = randomUUID();
    await inbox.markTargetDeleted(target);

    let quarantineProofs = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (
        path.includes(".delete.")
        && path.endsWith(".quarantine")
      ) {
        quarantineProofs++;
        if (quarantineProofs === 2) {
          throw new Error("post-commit tombstone cleanup proof failed");
        }
      }
      return nativeFs.lstat(...args);
    });

    await expect(inbox.clearTargetTombstone(target)).resolves.toBe(true);
    expect(quarantineProofs).toBeGreaterThanOrEqual(2);
    await expect(inbox.listDeletedTargets()).resolves.not.toContain(target);
    await expect(lstat(tombstonePath(directory, target))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("treats a tombstone clear as successful when its first post-rename quarantine proof fails", async () => {
    const { inbox, directory } = await temporaryInbox(
      "piweb-inbox-tombstone-first-quarantine-proof-",
    );
    const target = randomUUID();
    await inbox.markTargetDeleted(target);

    let quarantineProofs = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (
        path.includes(".delete.")
        && path.endsWith(".quarantine")
      ) {
        quarantineProofs++;
        if (quarantineProofs === 1) {
          throw new Error("first post-rename quarantine proof failed");
        }
      }
      return nativeFs.lstat(...args);
    });

    await expect(inbox.clearTargetTombstone(target)).resolves.toBe(true);
    expect(quarantineProofs).toBeGreaterThanOrEqual(1);
    await expect(inbox.listDeletedTargets()).resolves.not.toContain(target);
    await expect(lstat(tombstonePath(directory, target))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    const outside = await temporaryDirectory("piweb-inbox-outside-");
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
    const outside = await temporaryDirectory(
      "piweb-inbox-tombstone-outside-",
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
    const root = await temporaryDirectory("piweb-inbox-dir-link-");
    const outside = await temporaryDirectory("piweb-inbox-dir-target-");
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
