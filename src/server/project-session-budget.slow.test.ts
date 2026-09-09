import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aggregateReservedConversationEntries } from "./conversation-meta.js";
import {
  MAX_DELEGATION_DEPTH,
  MAX_LIVE_DELEGATION_DESCENDANTS,
  MAX_PEER_SESSIONS_PER_RUN,
  ProjectSessionCoordinator,
} from "./project-session-coordinator.js";
import {
  blocksUntil,
  coordinatorInbox,
  createFixture,
  deferred,
  deterministicTestUuid,
  executeTool,
  startBlockedSourceRun,
  startInput,
  startPeerFromActiveSource,
  waitUntil,
  type Fixture,
} from "./coordinator-test-fixture.js";
describe("ProjectSessionCoordinator slow paths", () => {
  it("releases target inbox capacity from durable receipts before run settlement", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(targetStarted, releaseTarget, "target settled"),
    );
    const targetRunId = randomUUID();
    const targetCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      targetRunId,
      "remain active while durable messages arrive",
    );
    await targetStarted.promise;

    const firstBatchAdmitted = deferred();
    const admitFinalMessage = deferred();
    const finalMessageAdmitted = deferred<{
      messageId: string;
      status: string;
    }>();
    const releaseSource = deferred();
    fixture.runtime.control(source.conversationId).enqueue(async (control) => {
      try {
        for (let index = 0; index < 64; index += 1) {
          await executeTool(
            control,
            "send_session_message",
            `receipt-capacity-${index}`,
            {
              conversationId: target.conversationId,
              message: `durable capacity message ${index}`,
            },
          );
        }
        firstBatchAdmitted.resolve();
        await admitFinalMessage.promise;
        finalMessageAdmitted.resolve(await executeTool(
          control,
          "send_session_message",
          "receipt-capacity-final",
          {
            conversationId: target.conversationId,
            message: "the sixty-fifth message",
          },
        ) as { messageId: string; status: string });
        await releaseSource.promise;
        control.emitFinal("source settled");
      } catch (error) {
        firstBatchAdmitted.reject(error);
        finalMessageAdmitted.reject(error);
        throw error;
      }
    });
    const sourceCompletion = fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "fill the target inbox",
    );
    await firstBatchAdmitted.promise;
    expect(await coordinatorInbox(fixture.handle).list({
      toConversationId: target.conversationId,
    })).toHaveLength(64);

    fixture.runtime.control(target.conversationId).beginNextModelTurn();
    admitFinalMessage.resolve();
    const finalMessage = await finalMessageAdmitted.promise;
    expect(finalMessage).toMatchObject({
      status: "queued",
      messageId: expect.any(String),
    });
    const retained = await coordinatorInbox(fixture.handle).list({
      toConversationId: target.conversationId,
    });
    expect(retained).toHaveLength(57);
    expect(retained).toContainEqual(
      expect.objectContaining({ messageId: finalMessage.messageId }),
    );
    expect(
      aggregateReservedConversationEntries(
        target.sessionManager.getEntries(),
      ).messageDeliveryReceipts,
    ).toHaveLength(8);

    fixture.runtime.control(target.conversationId).beginNextModelTurn();
    releaseTarget.resolve();
    releaseSource.resolve();
    await Promise.all([targetCompletion, sourceCompletion]);
  }, 60_000);
  it("permits depth up to MAX_DELEGATION_DEPTH and rejects deeper", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );

    let parentId = source.conversationId;
    let deepest: { conversationId: string; runId: string } | undefined;
    for (let depth = 0; depth < MAX_DELEGATION_DEPTH; depth++) {
      const peer = await startPeerFromActiveSource(
        fixture,
        parentId,
        startInput({
          task: `depth level ${depth + 1}`,
          idempotencyKey: `budget-depth-${depth}`,
        }),
      );
      deepest = peer;
      parentId = peer.conversationId;
    }

    const exceeded = startInput({
      task: "one level too deep",
      idempotencyKey: "budget-depth-exceeded",
    });
    await expect(startPeerFromActiveSource(
      fixture,
      parentId,
      exceeded,
    )).rejects.toThrow(/depth|maximum/i);

    // No card on deepest parent.
    const deepestActor = await fixture.coordinator.openConversation(
      fixture.handle,
      deepest!.conversationId,
      { updateRecent: false },
    );
    expect(aggregateReservedConversationEntries(
      deepestActor.sessionManager.getEntries(),
    ).cards.find(({ body }) => body === exceeded.task)).toBeUndefined();

    // No target conversation created.
    const expectedId = deterministicTestUuid(
      "piweb.start.conversation",
      exceeded.idempotencyKey,
    );
    expect((await fixture.coordinator.listSessions(fixture.handle))
      .find(({ id }) => id === expectedId)).toBeUndefined();
  });
});
