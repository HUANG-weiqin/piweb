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
  it("enforces MAX_PEER_SESSIONS_PER_RUN within one run; delete doesn't free slot", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peerIds: string[] = [];
    let fifthError: unknown;
    let retriedConversationId: string | undefined;

    fixture.runtime.control(source.conversationId).enqueue(
      async (control) => {
        for (let index = 0; index < MAX_PEER_SESSIONS_PER_RUN; index++) {
          const peer = await executeTool(
            control,
            "start_session",
            `budget-run-${index}`,
            {
              roleId: "default",
              task: `peer-${index}`,
            },
          ) as { conversationId: string };
          peerIds.push(peer.conversationId);
        }
        await waitUntil(async () => (
          (await fixture.coordinator.listSessions(fixture.handle))
            .find(({ id }) => id === peerIds[0])?.activity?.kind === "idle"
        ), "the first budget peer to become idle");
        await fixture.coordinator.deleteConversation(
          fixture.handle,
          peerIds[0]!,
        );
        try {
          await executeTool(
            control,
            "start_session",
            "budget-run-exceeded",
            {
              roleId: "default",
              task: "deletion must not free the run budget",
            },
          );
        } catch (error) {
          fifthError = error;
        }
        const retry = await executeTool(
          control,
          "start_session",
          "budget-run-0",
          {
            roleId: "default",
            task: "peer-0",
          },
        ) as { conversationId: string };
        retriedConversationId = retry.conversationId;
        control.emitFinal("same-run budget checked");
      },
    );

    const settlement = await fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "exercise one run budget",
    );
    expect(settlement.outcome).toBe("completed");
    expect(fifthError).toBeInstanceOf(Error);
    expect((fifthError as Error).message).toMatch(/limit|maximum/i);
    expect(retriedConversationId).toBe(peerIds[0]);

    let freshConversationId: string | undefined;
    fixture.runtime.control(source.conversationId).enqueue(
      async (control) => {
        const fresh = await executeTool(
          control,
          "start_session",
          "fresh-run-peer",
          {
            roleId: "default",
            task: "a fresh run has a fresh budget",
          },
        ) as { conversationId: string };
        freshConversationId = fresh.conversationId;
        control.emitFinal("fresh run accepted");
      },
    );
    const freshSettlement = await fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "exercise a fresh run budget",
    );
    expect(freshSettlement.outcome).toBe("completed");
    expect(freshConversationId).toEqual(expect.any(String));
  }, 15_000);

  it("enforces MAX_LIVE_DELEGATION_DESCENDANTS and allows creation after deletion", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );

    const peerIds: string[] = [];
    for (let i = 0; i < MAX_LIVE_DELEGATION_DESCENDANTS; i++) {
      const peer = await startPeerFromActiveSource(
        fixture,
        source.conversationId,
        startInput({
          task: `live-descendant-${i}`,
          idempotencyKey: `live-descendant-${i}`,
        }),
      );
      peerIds.push(peer.conversationId);
    }

    const exceeded = startInput({
      task: "too many descendants",
      idempotencyKey: "live-descendant-exceeded",
    });
    await expect(startPeerFromActiveSource(
      fixture,
      source.conversationId,
      exceeded,
    )).rejects.toThrow(/limit|maximum/i);

    // Delete one descendant → now creation succeeds.
    await fixture.coordinator.deleteConversation(
      fixture.handle,
      peerIds[0]!,
    );
    const afterDeletion = await startPeerFromActiveSource(
      fixture,
      source.conversationId,
      startInput({
        task: "after descendant deletion",
        idempotencyKey: "live-descendant-after-delete",
      }),
    );
    expect(afterDeletion).toMatchObject({ conversationId: expect.any(String) });
  }, 15_000);
});
