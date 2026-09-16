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
  it("keeps a reserved but failed deletion in the live descendant count", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peerIds: string[] = [];
    for (let index = 0; index < MAX_LIVE_DELEGATION_DESCENDANTS; index++) {
      const peer = await startPeerFromActiveSource(
        fixture,
        source.conversationId,
        startInput({
          task: `reserved-delete-peer-${index}`,
          idempotencyKey: `reserved-delete-peer-${index}`,
        }),
      );
      peerIds.push(peer.conversationId);
    }
    const busyStarted = deferred();
    const releaseBusy = deferred();
    fixture.runtime.control(peerIds[0]!).enqueue(
      blocksUntil(busyStarted, releaseBusy, "busy descendant finished"),
    );
    const busyCompletion = fixture.coordinator.prompt(
      fixture.handle,
      peerIds[0]!,
      randomUUID(),
      "stay busy during deletion",
    );
    await busyStarted.promise;

    const exceededInput = startInput({
      task: "reservation must not free a slot",
      idempotencyKey: "reserved-delete-exceeded",
    });
    const raceSourceRun = await startBlockedSourceRun(
      fixture,
      source.conversationId,
      "race the reserved descendant admission",
    );
    const results = await Promise.allSettled([
      fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        { ...exceededInput, sourceRunId: raceSourceRun.runId },
      ),
      fixture.coordinator.deleteConversation(
        fixture.handle,
        peerIds[0]!,
      ),
    ]);
    raceSourceRun.release.resolve();
    await raceSourceRun.completion;
    expect(results.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(
      results[0]?.status === "rejected"
        ? String(results[0].reason)
        : "",
    ).toMatch(/limit|maximum/i);
    expect(
      results[1]?.status === "rejected"
        ? String(results[1].reason)
        : "",
    ).toMatch(/busy|compacting/i);
    const exceededId = deterministicTestUuid(
      "piweb.start.conversation",
      exceededInput.idempotencyKey,
    );
    expect((await fixture.coordinator.listSessions(fixture.handle))
      .some(({ id }) => id === exceededId)).toBe(false);

    releaseBusy.resolve();
    await busyCompletion;
  }, 30_000);

  it("rejects a failed sending precommit that would exceed the live cap on replay after restart", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );

    // Precommit: write sending card for K, crash before target creation.
    let failNextTarget = true;
    const precommitInput = startInput({
      task: "precommit-K",
      idempotencyKey: "precommit-K-replay",
    });
    fixture.runtime.beforeCreateSession = async (conversationId) => {
      if (conversationId !== source.conversationId && failNextTarget) {
        failNextTarget = false;
        throw new Error("simulated crash after precommit");
      }
    };
    await expect(startPeerFromActiveSource(
      fixture,
      source.conversationId,
      precommitInput,
    )).rejects.toThrow("simulated crash after precommit");

    await fixture.coordinator.close();

    // Re-create coordinator and fill MAX_LIVE_DELEGATION_DESCENDANTS.
    const restarted = new ProjectSessionCoordinator(
      fixture.runtime, fixture.roles, fixture.registry,
    );
    const handle = await restarted.acquireProject(fixture.cwd);
    await restarted.openConversation(handle, source.conversationId, { updateRecent: false });

    const restartedFixture: Fixture = {
      ...fixture,
      coordinator: restarted,
      handle,
    };
    for (let i = 0; i < MAX_LIVE_DELEGATION_DESCENDANTS; i++) {
      await startPeerFromActiveSource(
        restartedFixture,
        source.conversationId,
        startInput({ task: `filler-${i}`, idempotencyKey: `filler-${i}` }),
      );
    }

    // Replay K — must be rejected (live cap exceeded).
    await expect(restarted.startPeerSession(
      handle, source.conversationId, precommitInput,
    )).rejects.toThrow(/limit|maximum/i);

    // No second card was created.
    const sourceActor = await restarted.openConversation(
      handle, source.conversationId, { updateRecent: false },
    );
    const sendingCards = aggregateReservedConversationEntries(
      sourceActor.sessionManager.getEntries(),
    ).cards.filter(({ body }) => body === precommitInput.task);
    expect(sendingCards).toHaveLength(1);

    await restarted.close();
  }, 30_000);
});
