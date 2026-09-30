import { randomUUID } from "node:crypto";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  BashExecutionBudget,
  createBashExecutionBinding,
  type BashExecutionLifecycle,
} from "./bash-execution.js";
import type { ConversationActor } from "./conversation-actor.js";
import type { SerialTaskQueue } from "./serial-task-queue.js";
import {
  appendReservedCustomEntry,
  createConversationCardEntry,
} from "./conversation-meta.js";
import {
  blocksUntil,
  coordinatorInbox,
  createFixture,
  deferred,
  executeTool,
  startBlockedSourceRun,
  waitUntil,
  type Fixture,
} from "./coordinator-test-fixture.js";

const NOTIFICATION_TYPE = "piweb.bash_task_notification.v1";

/** Exercise the real execution -> Actor completion callback, without a subprocess. */
function backgroundTask(fixture: Fixture, actor: ConversationActor) {
  const options = fixture.runtime.createOptions.get(actor.conversationId)!;
  expect(options.backgroundTasks).toBeDefined();
  const completion = deferred<{ exitCode: number | null }>();
  let executionStarted = false;
  let executionCount = 0;
  const started = deferred();
  const binding = createBashExecutionBinding({
    getOwner: options.bashExecutions!.getOwner,
    onChange: options.bashExecutions!.onChange,
    backgroundTasks: options.backgroundTasks,
    conversationKey: `${fixture.cwd}:${actor.conversationId}`,
    budget: new BashExecutionBudget(),
    operations: {
      exec: async (_command, _cwd, executionOptions) => {
        executionStarted = true;
        executionCount += 1;
        started.resolve();
        executionOptions.onData(Buffer.from("background result\n"));
        executionOptions.signal?.addEventListener("abort", () => {
          completion.resolve({ exitCode: null });
        }, { once: true });
        return completion.promise;
      },
    },
    createBaseTool: (operations) => createBashTool(fixture.cwd, { operations }),
  });
  return {
    completion,
    started: started.promise,
    executionCount: () => executionCount,
    binding,
    async startForeground() {
      const bash = binding.tools.find((tool) => tool.name === "bash")!;
      return bash.execute("foreground-task", {
        command: "printf 'foreground result'", timeout: 600000,
      }, undefined, undefined, {
        cwd: fixture.cwd, sessionManager: actor.sessionManager,
      } as never);
    },
    async start(): Promise<string> {
      const bash = binding.tools.find((tool) => tool.name === "bash")!;
      const result = await bash.execute("background-task", {
        command: "printf 'background result'", run_in_background: true,
      }, undefined, undefined, {
        cwd: fixture.cwd, sessionManager: actor.sessionManager,
      } as never);
      // The native factory needs its real session context. A task_id alone
      // could conceal a launch/formatter error before operations.exec starts.
      expect(executionStarted).toBe(true);
      const taskId = (result.details as { piwebBash: { taskId: string } }).piwebBash.taskId;
      expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
      return taskId;
    },
  };
}

async function startBackgroundTask(fixture: Fixture, actor: ConversationActor) {
  const task = backgroundTask(fixture, actor);
  let taskId!: string;
  fixture.runtime.control(actor.conversationId).enqueue(async (control) => {
    control.emitUserMessage("start background work");
    taskId = await task.start();
    control.emitFinal("background work started");
  });
  const settlement = await fixture.coordinator.prompt(
    fixture.handle, actor.conversationId, randomUUID(), "start background work",
  );
  expect(settlement).toMatchObject({ outcome: "completed" });
  expect(taskId).toBeTruthy();
  expect(actor.getActivity().kind).toBe("idle");
  expect(fixture.runtime.createOptions.get(actor.conversationId)!.backgroundTasks!.summaries())
    .toEqual([expect.objectContaining({ taskId, state: "in_progress" })]);
  return { ...task, taskId };
}

async function queueInboxMessage(fixture: Fixture, target: ConversationActor) {
  const source = await fixture.coordinator.createUserConversation(
    fixture.handle, { roleId: "default", title: "Sender" },
  );
  const messageId = randomUUID();
  const cardId = randomUUID();
  const fromSnapshot = {
    conversationId: source.conversationId,
    role: { id: "default", name: "Default" },
  };
  const toSnapshot = {
    conversationId: target.conversationId,
    role: { id: "default", name: "Default" },
  };
  appendReservedCustomEntry(source.sessionManager, createConversationCardEntry({
    cardId, kind: "message", summary: "inbox first", body: "inbox first",
    fromSnapshot, toSnapshot, state: "sending", messageId,
    updatedAt: new Date().toISOString(),
  }));
  await coordinatorInbox(fixture.handle).put({
    messageId, cardId, fromConversationId: source.conversationId,
    toConversationId: target.conversationId, sentAt: new Date().toISOString(),
    kind: "message", summary: "inbox first", body: "inbox first",
    fromRunId: randomUUID(), fromSnapshot, toSnapshot,
  });
  return messageId;
}

function notifications(fixture: Fixture, actor: ConversationActor) {
  return fixture.runtime.control(actor.conversationId).received.filter(
    (message) => message.customType === NOTIFICATION_TYPE,
  );
}

describe("ProjectSessionCoordinator background Bash", () => {
  it.each(["browser", "peer"] as const)("promotes a real foreground wait after accepted %s input without restarting the command", async (source) => {
    const fixture = await createFixture();
    let lifecycle: BashExecutionLifecycle | undefined;
    // The fixture owns runtime creation. Forward Actor lifecycle calls to the
    // same real native binding executing this test's foreground tool.
    fixture.runtime.bashExecutions = {
      promoteForeground: (owner) => lifecycle?.promoteForeground(owner) ?? 0,
      requestStop: (owner, reason) => lifecycle?.requestStop(owner, reason),
      close: async (owner, reason) => lifecycle?.close(owner, reason)
        ?? { executions: [], cleanupUnknown: false },
      dispose: async () => lifecycle?.dispose() ?? { executions: [], cleanupUnknown: false },
      activity: (owner) => lifecycle?.activity(owner)
        ?? { running: 0, stopping: 0, cleanupUnknown: false },
    };
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Caller" },
    );
    const task = backgroundTask(fixture, caller);
    lifecycle = task.binding.lifecycle;
    const acceptedRun = deferred();
    let taskId!: string;
    let nativeResult: unknown;
    const control = fixture.runtime.control(caller.conversationId);
    control.enqueue(async (current) => {
      current.emitUserMessage("long foreground work");
      nativeResult = await task.startForeground();
      taskId = (nativeResult as { details: { piwebBash: { taskId: string } } }).details.piwebBash.taskId;
      expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
      current.beginNextModelTurn();
      if (source === "browser") current.emitUserMessage("handle this input now");
      acceptedRun.resolve();
      current.emitFinal("new input processed while the command is still running");
    });
    const runId = randomUUID();
    const completion = fixture.coordinator.prompt(
      fixture.handle, caller.conversationId, runId, "long foreground work",
    );
    let sender: Awaited<ReturnType<typeof startBlockedSourceRun>> | undefined;
    let guidance: Promise<unknown> | undefined;
    try {
      await task.started;
      expect(nativeResult).toBeUndefined();
      expect(caller.getBashActivity()).toMatchObject({ running: 1 });
      if (source === "browser") {
        guidance = fixture.coordinator.prompt(fixture.handle, caller.conversationId, runId,
          "handle this input now", randomUUID());
      } else {
        const peer = await fixture.coordinator.createUserConversation(
          fixture.handle, { roleId: "default", title: "Sender" },
        );
        sender = await startBlockedSourceRun(fixture, peer.conversationId);
        await executeTool(fixture.runtime.control(peer.conversationId), "send_session_message",
          "interrupt-foreground", { conversationId: caller.conversationId,
            summary: "handle this input now", message: "handle this input now" });
      }
      await Promise.race([
        acceptedRun.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Accepted input did not release foreground wait")), 1500)),
      ]);
      await expect(completion).resolves.toMatchObject({ outcome: "completed" });
      await guidance;
      expect(caller.getActivity().kind).toBe("idle");
      expect(task.executionCount()).toBe(1);
      expect(fixture.runtime.createOptions.get(caller.conversationId)!.backgroundTasks!.summaries())
        .toEqual([expect.objectContaining({ taskId, state: "in_progress" })]);
      if (source === "peer") {
        expect(control.modelRequestCustomMessages.at(-1)?.some((message) =>
          message.customType === "piweb.conversation_message.v1")).toBe(true);
      }
      task.completion.resolve({ exitCode: 0 });
      await waitUntil(() => notifications(fixture, caller).length === 1,
        "promoted task to complete and notify");
      expect(notifications(fixture, caller)[0]).toMatchObject({
        details: { tasks: [{ taskId, status: "completed", exitCode: 0 }] },
      });
    } finally {
      task.completion.resolve({ exitCode: 0 });
      sender?.release.resolve();
      await sender?.completion;
      await guidance?.catch(() => undefined);
      await completion.catch(() => undefined);
    }
  });

  it("wakes an idle conversation once and releases the lifecycle lane before the notification turn ends", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Bash" },
    );
    const task = await startBackgroundTask(fixture, actor);
    const notificationStarted = deferred();
    const release = deferred();
    fixture.runtime.control(actor.conversationId).enqueue(
      blocksUntil(notificationStarted, release, "notification handled"),
    );
    try {
      task.completion.resolve({ exitCode: 0 });
      await waitUntil(
        () => notifications(fixture, actor).length === 1,
        "background completion to start an idle notification turn",
      );
      await notificationStarted.promise;
      expect(notifications(fixture, actor)[0]).toMatchObject({
        triggerTurn: true,
        details: { tasks: [{ taskId: task.taskId, status: "completed", exitCode: 0 }] },
      });
      const other = fixture.coordinator.createUserConversation(
        fixture.handle, { roleId: "default", title: "Other" },
      );
      await expect(Promise.race([
        other.then(() => "admitted"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1500)),
      ])).resolves.toBe("admitted");
      expect(fixture.runtime.control(actor.conversationId).promptTexts)
        .toEqual(["start background work"]);
    } finally {
      release.resolve();
      task.completion.resolve({ exitCode: 0 });
    }
    await waitUntil(() => actor.getActivity().kind === "idle", "notification run to settle");
    expect(notifications(fixture, actor)).toHaveLength(1);
    expect(actor.sessionManager.getEntries().filter((entry) =>
      entry.type === "custom_message" && entry.customType === NOTIFICATION_TYPE
    )).toHaveLength(1);
  });

  it("brings pending completion into an already queued browser prompt rather than starting a competing run", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Bash" },
    );
    const task = await startBackgroundTask(fixture, actor);
    const entered = deferred();
    const release = deferred();
    // withListSnapshot does not hold the project lifecycle lane. Block the
    // actual admission owner so browser work is queued before task readiness.
    const context = (fixture.handle as unknown as {
      context: { lifecycle: SerialTaskQueue };
    }).context;
    const blocked = context.lifecycle.run(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const prompt = fixture.coordinator.prompt(
      fixture.handle, actor.conversationId, randomUUID(), "browser won admission",
    );
    try {
      task.completion.resolve({ exitCode: 0 });
      await waitUntil(() => actor.hasPendingBashNotifications(), "unhanded notification to queue");
    } finally {
      release.resolve();
      await blocked;
    }
    await expect(prompt).resolves.toMatchObject({ outcome: "completed" });
    expect(notifications(fixture, actor)).toHaveLength(1);
    expect(notifications(fixture, actor)[0].triggerTurn).toBe(false);
    expect(fixture.runtime.control(actor.conversationId).promptTexts)
      .toEqual(["start background work", "browser won admission"]);
  });

  it("admits existing durable inbox work before the completion wake and carries the notification into that run", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Bash" },
    );
    const task = await startBackgroundTask(fixture, actor);
    const messageId = await queueInboxMessage(fixture, actor);
    const inboxStarted = deferred();
    const release = deferred();
    fixture.runtime.control(actor.conversationId).enqueue(
      blocksUntil(inboxStarted, release, "inbox handled"),
    );
    try {
      task.completion.resolve({ exitCode: 0 });
      await waitUntil(
        () => fixture.runtime.control(actor.conversationId).received.some((message) =>
          (message.details as { messageId?: string } | undefined)?.messageId === messageId
        ),
        "inbox message to win completion wake admission",
      );
      await inboxStarted.promise;
      const received = fixture.runtime.control(actor.conversationId).received;
      expect(received.map((message) => message.customType)).toEqual([
        NOTIFICATION_TYPE, "piweb.conversation_message.v1",
      ]);
      expect(received[0].triggerTurn).toBe(false);
      expect(received[1].triggerTurn).toBe(true);
    } finally {
      release.resolve();
      task.completion.resolve({ exitCode: 0 });
    }
    await waitUntil(() => actor.getActivity().kind === "idle", "inbox run to settle");
    expect(notifications(fixture, actor)).toHaveLength(1);
  });

  it("does not retry an unaccepted notification by recursively waking from its own failed run", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Bash" },
    );
    const task = await startBackgroundTask(fixture, actor);
    const control = fixture.runtime.control(actor.conversationId);
    const original = control.session.sendCustomMessage.bind(control.session);
    let attempts = 0;
    vi.spyOn(control.session, "sendCustomMessage").mockImplementation(async (message, options) => {
      if (message.customType === NOTIFICATION_TYPE && options?.triggerTurn === true) {
        attempts++;
        throw new Error("SDK rejected notification before acceptance");
      }
      return original(message, options);
    });
    task.completion.resolve({ exitCode: 0 });
    await waitUntil(() => attempts > 0, "one failed notification admission");
    const context = (fixture.handle as unknown as {
      context: { backgroundTasks: Set<Promise<void>>; scheduledPumps: Set<string> };
    }).context;
    await waitUntil(() => actor.getActivity().kind === "idle"
      && context.backgroundTasks.size === 0
      && !context.scheduledPumps.has(actor.conversationId), "failed wake to stop without self-retry");
    expect(attempts).toBe(1);
    expect(actor.hasPendingBashNotifications()).toBe(true);
    expect(notifications(fixture, actor)).toHaveLength(0);
  });

  it("does not even request a Bash wake admission while cleanup is unknown", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Bash" },
    );
    const task = await startBackgroundTask(fixture, actor);
    const wake = vi.spyOn(actor, "startBashNotifications");
    const activity = vi.spyOn(actor, "getBashActivity").mockReturnValue({
      running: 0, stopping: 1, cleanupUnknown: true,
    });
    try {
      task.completion.resolve({ exitCode: 0 });
      await waitUntil(() => actor.hasPendingBashNotifications(), "completion to remain pending");
      const context = (fixture.handle as unknown as {
        context: { backgroundTasks: Set<Promise<void>>; scheduledPumps: Set<string> };
      }).context;
      await waitUntil(() => context.backgroundTasks.size === 0
        && !context.scheduledPumps.has(actor.conversationId), "unknown-cleanup wake to stop");
      expect(wake).not.toHaveBeenCalled();
      expect(notifications(fixture, actor)).toHaveLength(0);
    } finally {
      activity.mockRestore();
    }
  });

  it("does not consume an immediate Bash wait cause when cancellation wins after the lifecycle read", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Caller" },
    );
    const peer = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Peer" },
    );
    const target = await startBlockedSourceRun(fixture, peer.conversationId);
    const task = backgroundTask(fixture, caller);
    const started = deferred();
    const beginWait = deferred();
    const cancelled = new AbortController();
    const context = (fixture.handle as unknown as {
      context: { lifecycle: SerialTaskQueue };
    }).context;
    const run = context.lifecycle.run.bind(context.lifecycle);
    const lifecycle = vi.spyOn(context.lifecycle, "run").mockImplementation(async (work) => {
      const result = await run(work);
      if ((result as { outcome?: string } | undefined)?.outcome === "bash_task"
        && !cancelled.signal.aborted) cancelled.abort();
      return result;
    });
    let taskId!: string;
    const control = fixture.runtime.control(caller.conversationId);
    control.enqueue(async (current) => {
      current.emitUserMessage("wait for background completion");
      taskId = await task.start();
      started.resolve();
      await beginWait.promise;
      const input = { targets: [{ conversationId: peer.conversationId, runId: target.runId }] };
      await expect(executeTool(current, "wait_for_session", "cancelled-wait", input,
        cancelled.signal)).rejects.toThrow(/aborted/i);
      expect(caller.peekBashTaskNotificationForWait(caller.currentRunOwnership()!)).toEqual([taskId]);
      await expect(executeTool(current, "wait_for_session", "next-wait", input)).resolves.toEqual({
        outcome: "bash_task", taskIds: [taskId],
      });
      current.beginNextModelTurn();
      current.emitFinal("notification consumed once");
    });
    const completion = fixture.coordinator.prompt(
      fixture.handle, caller.conversationId, randomUUID(), "wait for background completion",
    );
    try {
      await started.promise;
      task.completion.resolve({ exitCode: 0 });
      await waitUntil(() => control.pendingSteers.some((message) =>
        message.customType === NOTIFICATION_TYPE
      ) && !caller.hasPendingBashNotifications(), "SDK to accept before cancellation check");
      beginWait.resolve();
      await expect(completion).resolves.toMatchObject({ outcome: "completed" });
      expect(cancelled.signal.aborted).toBe(true);
      expect(notifications(fixture, caller)).toHaveLength(1);
    } finally {
      lifecycle.mockRestore();
      beginWait.resolve();
      target.release.resolve();
      task.completion.resolve({ exitCode: 0 });
      await target.completion;
      await completion.catch(() => undefined);
    }
  });

  it.each([true, false])("returns only task metadata for SDK notification acceptance (before wait: %s)", async (beforeWait) => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Caller" },
    );
    const peer = await fixture.coordinator.createUserConversation(
      fixture.handle, { roleId: "default", title: "Peer" },
    );
    const target = await startBlockedSourceRun(fixture, peer.conversationId);
    const task = backgroundTask(fixture, caller);
    const started = deferred();
    const beginWait = deferred();
    let taskId!: string;
    let result: unknown;
    const control = fixture.runtime.control(caller.conversationId);
    control.enqueue(async (current) => {
      current.emitUserMessage("wait for peer or background completion");
      taskId = await task.start();
      started.resolve();
      await beginWait.promise;
      result = await executeTool(current, "wait_for_session", "wait-for-completion", {
        targets: [{ conversationId: peer.conversationId, runId: target.runId }],
      });
      current.beginNextModelTurn();
      current.emitFinal("background notification consumed");
    });
    const completion = fixture.coordinator.prompt(
      fixture.handle, caller.conversationId, randomUUID(), "wait for peer or background completion",
    );
    try {
      await started.promise;
      if (!beforeWait) {
        beginWait.resolve();
        await waitUntil(
          () => caller.getActivity().kind === "waiting" || result !== undefined,
          "source wait to register",
        );
        expect(result).toBeUndefined();
      }
      task.completion.resolve({ exitCode: 0 });
      if (beforeWait) {
        await waitUntil(() => control.pendingSteers.some((message) =>
          message.customType === NOTIFICATION_TYPE
        ) && !caller.hasPendingBashNotifications(), "SDK to accept the completion before waiting");
        beginWait.resolve();
      }
      await expect(Promise.race([
        completion.then(() => "resumed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1500)),
      ])).resolves.toBe("resumed");
      expect(result).toEqual({ outcome: "bash_task", taskIds: [taskId] });
      expect(JSON.stringify(result)).not.toContain("background result");
      expect(notifications(fixture, caller)).toHaveLength(1);
      expect(notifications(fixture, caller)[0]).toMatchObject({
        details: { tasks: [{ taskId, status: "completed", exitCode: 0 }] },
      });
    } finally {
      beginWait.resolve();
      target.release.resolve();
      task.completion.resolve({ exitCode: 0 });
      await target.completion;
      await completion.catch(() => undefined);
    }
  });
});
