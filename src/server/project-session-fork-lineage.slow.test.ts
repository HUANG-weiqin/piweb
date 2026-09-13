import { describe, expect, it } from "vitest";
import { ProjectSessionCoordinator } from "./project-session-coordinator.js";
import {
  createFixture,
  startInput,
  startPeerFromActiveSource,
  waitUntil,
} from "./coordinator-test-fixture.js";

async function waitForIdle(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  conversationId: string,
  label: string,
): Promise<void> {
  await waitUntil(
    async () =>
      (await fixture.coordinator.listSessions(fixture.handle)).find(
        ({ id }) => id === conversationId,
      )?.activity?.kind === "idle",
    label,
  );
}

describe("fork lineage repro", () => {
  it("attributes a fork child session to the fork, not the source", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const fork = await fixture.coordinator.forkCurrentLeafConversation(
      fixture.handle,
      source.conversationId,
    );
    expect(fork.profile.createdBy).toEqual({ kind: "user" });
    expect(fork.profile.orchestration).toBeUndefined();

    const started = await startPeerFromActiveSource(
      fixture,
      fork.conversationId,
      startInput({ idempotencyKey: "fork-child-basic" }),
    );
    const target = await fixture.coordinator.openConversation(
      fixture.handle,
      started.conversationId,
      { updateRecent: false },
    );
    expect(target.profile.createdBy).toEqual({
      kind: "conversation",
      conversationId: fork.conversationId,
    });
    expect(target.profile.orchestration).toMatchObject({
      rootConversationId: fork.conversationId,
      depth: 1,
    });
    const summaries = await fixture.coordinator.listSessions(fixture.handle);
    expect(
      summaries.find(({ id }) => id === started.conversationId)
        ?.rootConversationId,
    ).toBe(fork.conversationId);
  });

  it("attributes correctly when the fork source is itself a child", async () => {
    const fixture = await createFixture();
    const root = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childSrc = await startPeerFromActiveSource(
      fixture,
      root.conversationId,
      startInput({ idempotencyKey: "lineage-src-child" }),
    );
    await waitForIdle(fixture, childSrc.conversationId, "source child settles");

    const fork = await fixture.coordinator.forkCurrentLeafConversation(
      fixture.handle,
      childSrc.conversationId,
    );
    const started = await startPeerFromActiveSource(
      fixture,
      fork.conversationId,
      startInput({ idempotencyKey: "fork-child-of-child" }),
    );
    const target = await fixture.coordinator.openConversation(
      fixture.handle,
      started.conversationId,
      { updateRecent: false },
    );
    expect(target.profile.orchestration).toMatchObject({
      rootConversationId: fork.conversationId,
      depth: 1,
    });
    const summaries = await fixture.coordinator.listSessions(fixture.handle);
    expect(
      summaries.find(({ id }) => id === started.conversationId)
        ?.rootConversationId,
    ).toBe(fork.conversationId);
  });

  it("attributes correctly after a restart between fork and start", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const fork = await fixture.coordinator.forkCurrentLeafConversation(
      fixture.handle,
      source.conversationId,
    );
    const forkId = fork.conversationId;

    await fixture.coordinator.close();
    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    const restartedHandle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    fixture.coordinator = restarted;
    fixture.handle = restartedHandle;
    await fixture.coordinator.openConversation(
      restartedHandle,
      forkId,
      { updateRecent: false },
    );

    const started = await startPeerFromActiveSource(
      fixture,
      forkId,
      startInput({ idempotencyKey: "fork-child-restart" }),
    );
    const target = await fixture.coordinator.openConversation(
      fixture.handle,
      started.conversationId,
      { updateRecent: false },
    );
    expect(target.profile.orchestration).toMatchObject({
      rootConversationId: forkId,
      depth: 1,
    });
    const summaries = await fixture.coordinator.listSessions(fixture.handle);
    expect(
      summaries.find(({ id }) => id === started.conversationId)
        ?.rootConversationId,
    ).toBe(forkId);
  });
});
