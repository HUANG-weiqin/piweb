import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  ExtensionError,
  ModelRegistry,
  SessionManager as SessionManagerType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ToolMode } from "../shared/protocol.js";
import type { ConversationMeta } from "./conversation-meta.js";
import {
  ConversationActor,
  type ConversationActorEvent,
  type ConversationActorOpenOptions,
} from "./conversation-actor.js";
import type {
  CreatedPiSession,
  CreatePiSessionOptions,
  PiRuntimeLike,
  ToolCallGate,
} from "./pi-runtime.js";
import type {
  ConversationDeletionLease,
  ConversationLease,
} from "./project-store.js";
import {
  ProjectRunCoordinator,
  type ProjectRunLease,
} from "./project-run-coordinator.js";

const CONVERSATION_ID = "0dd23f7c-80c8-4713-b7a7-33c00177a101";
const TARGET_CONVERSATION_ID =
  "e15c861c-e18f-4290-bc22-8932f3caaf4e";
const ROLE_ID = "b17204b1-6155-4fea-9be5-a70aaa670bf3";
const RUN_A = "ba39f161-b67f-47c9-9285-e391427ed7d0";
const RUN_B = "65feacc3-00b4-45bd-80ee-5e18bc32f7dc";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FakeSession extends AgentSession {
  abortCalls: number;
  disposeCalls: number;
  eventListener?: (event: AgentSessionEvent) => void;
  toolCallGate?: ToolCallGate;
  promptImplementation(text: string): Promise<void>;
}

function fakeSettings(): SettingsManager {
  return {
    flush: async () => undefined,
    drainErrors: () => [],
  } as unknown as SettingsManager;
}

function fakeSession(): FakeSession {
  const session = {
    abortCalls: 0,
    disposeCalls: 0,
    isStreaming: false,
    messages: [],
    model: { provider: "test", id: "model" },
    thinkingLevel: "off",
    extensionRunner: {
      getCommand: () => undefined,
    },
    promptImplementation: async () => undefined,
    prompt: function (text: string) {
      return this.promptImplementation(text);
    },
    abort: async function () {
      this.abortCalls++;
      this.isStreaming = false;
    },
    dispose: function () {
      this.disposeCalls++;
    },
    subscribe: function (listener: (event: AgentSessionEvent) => void) {
      this.eventListener = listener;
      return () => {
        if (this.eventListener === listener) {
          this.eventListener = undefined;
        }
      };
    },
  };
  return session as unknown as FakeSession;
}

class FakeRuntime implements PiRuntimeLike {
  readonly authStorage = {} as AuthStorage;
  readonly modelRegistry = {} as ModelRegistry;
  readonly session = fakeSession();
  readonly settings = fakeSettings();
  createOptions?: CreatePiSessionOptions;
  disposeCalls = 0;
  activationError?: Error;
  pendingExtensionErrors: ExtensionError[] = [];
  extensionErrorHandler?: (error: ExtensionError) => void;

  async createProjectModelCatalog() {
    return {
      modelRegistry: this.modelRegistry,
      dynamicProviderNames: () => new Set<string>(),
      dispose: async () => undefined,
    };
  }

  async createSession(
    _cwd: string,
    options: CreatePiSessionOptions = {},
  ): Promise<CreatedPiSession> {
    this.createOptions = options;
    this.session.toolCallGate = options.toolCallGate;
    return {
      session: this.session,
      settings: this.settings,
      modelRegistry: this.modelRegistry,
      activateExtensions: async () => {
        if (this.activationError) throw this.activationError;
      },
      activateExtensionErrors: (handler) => {
        this.extensionErrorHandler = handler;
        return this.pendingExtensionErrors.splice(0);
      },
      dynamicProviderNames: () => new Set(),
      dispose: async () => {
        this.disposeCalls++;
        this.session.dispose();
      },
    };
  }

  updateConfiguration<T>(change: () => Promise<T> | T): Promise<T> {
    return Promise.resolve().then(change);
  }

  refreshConfiguration(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

class FakeConversationLease implements ConversationLease {
  releases = 0;
  upgrades = 0;
  deletionReleases = 0;

  release(): void {
    this.releases++;
  }

  upgradeToDeletion(): ConversationDeletionLease {
    this.upgrades++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.deletionReleases++;
      },
    };
  }
}

class TrackingRunCoordinator extends ProjectRunCoordinator {
  constructor(private readonly order: string[] = []) {
    super();
  }

  override registerRun(
    _cwd: string,
    _cancel: () => Promise<void> | void,
  ): ProjectRunLease {
    this.order.push("run-registered");
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.order.push("run-lease-released");
      },
    };
  }

  override isRestrictionPending(): boolean {
    return false;
  }
}

function profile(): ConversationMeta {
  return {
    role: {
      id: ROLE_ID,
      revision: 3,
      name: "Reviewer",
      description: "Review changes",
      systemPrompt: "Be precise.",
      model: {
        provider: "test",
        id: "model",
      },
    },
    lifecycle: { kind: "normal" },
    createdBy: { kind: "user" },
  };
}

interface ActorFixture {
  actor: ConversationActor;
  runtime: FakeRuntime;
  lease: FakeConversationLease;
  manager: SessionManagerType;
  events: ConversationActorEvent[];
  project: {
    cwd: string;
    toolMode: ToolMode;
    refreshConversations(): Promise<[]>;
  };
}

async function openActor(
  overrides: Partial<ConversationActorOpenOptions> = {},
): Promise<ActorFixture> {
  const runtime = overrides.runtime instanceof FakeRuntime
    ? overrides.runtime
    : new FakeRuntime();
  const lease = overrides.conversationLease instanceof FakeConversationLease
    ? overrides.conversationLease
    : new FakeConversationLease();
  const manager = overrides.sessionManager
    ?? SessionManager.inMemory(process.cwd(), { id: CONVERSATION_ID });
  const project = overrides.project ?? {
    cwd: process.cwd(),
    toolMode: "full_access" as ToolMode,
    refreshConversations: async () => [],
  };
  const actor = await ConversationActor.open({
    conversationId: CONVERSATION_ID,
    profile: profile(),
    project,
    sessionManager: manager,
    conversationLease: lease,
    runtime,
    ...overrides,
  });
  const events: ConversationActorEvent[] = [];
  actor.subscribe((event) => events.push(event));
  return {
    actor,
    runtime,
    lease,
    manager,
    events,
    project,
  };
}

function nativeEvent(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

describe("ConversationActor", () => {
  it("publishes queued synchronously and permits only one active run", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const completion = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });

    expect(fixture.events.slice(0, 2)).toEqual([
      {
        type: "session_event",
        conversationId: CONVERSATION_ID,
        runId: RUN_A,
        event: { type: "run_queued" },
      },
      {
        type: "activity",
        conversationId: CONVERSATION_ID,
        activity: { kind: "queued", runId: RUN_A },
      },
    ]);
    expect(() => fixture.actor.startPrompt({
      runId: RUN_B,
      text: "overlap",
      origin: "browser",
    })).toThrow("already running");

    await promptStarted.promise;
    promptFinished.resolve();
    await expect(completion).resolves.toMatchObject({
      runId: RUN_A,
      outcome: "completed",
    });
    await fixture.actor.dispose();
  });

  it("ignores a wrong abort run id and aborts the owned run", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      promptStarted.resolve();
      await promptFinished.promise;
    };
    fixture.runtime.session.abort = async () => {
      fixture.runtime.session.abortCalls++;
      promptFinished.resolve();
    };
    const completion = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "work",
      origin: "browser",
    });
    await promptStarted.promise;

    await fixture.actor.abort(RUN_B);
    expect(fixture.runtime.session.abortCalls).toBe(0);
    expect(fixture.actor.getActivity()).toEqual({
      kind: "running",
      runId: RUN_A,
    });

    await fixture.actor.abort(RUN_A);
    await expect(completion).resolves.toMatchObject({
      runId: RUN_A,
      outcome: "aborted",
    });
    expect(fixture.runtime.session.abortCalls).toBe(1);
    await fixture.actor.dispose();
  });

  it("restores waiting in finally and a stale restore cannot revive a run", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      promptStarted.resolve();
      await promptFinished.promise;
    };
    fixture.runtime.session.abort = async () => {
      fixture.runtime.session.abortCalls++;
      promptFinished.resolve();
    };
    const completion = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "coordinate",
      origin: "conversation",
    });
    await promptStarted.promise;
    const ownership = fixture.actor.currentRunOwnership(RUN_A);
    if (!ownership) throw new Error("run ownership was not exposed");

    await expect(fixture.actor.withWaiting(
      ownership,
      {
        conversationId: TARGET_CONVERSATION_ID,
        runId: RUN_B,
      },
      async () => {
        expect(fixture.actor.getActivity()).toEqual({
          kind: "waiting",
          runId: RUN_A,
          targetConversationId: TARGET_CONVERSATION_ID,
          targetRunId: RUN_B,
        });
        throw new Error("target failed");
      },
    )).rejects.toThrow("target failed");
    expect(fixture.actor.getActivity()).toEqual({
      kind: "running",
      runId: RUN_A,
    });

    const restore = fixture.actor.enterWaiting(ownership, {
      conversationId: TARGET_CONVERSATION_ID,
      runId: RUN_B,
    });
    const aborting = fixture.actor.abort(RUN_A);
    restore();
    expect(fixture.actor.getActivity()).toEqual({
      kind: "cancelling",
      runId: RUN_A,
    });
    await aborting;
    await completion;

    const second = fixture.actor.startPrompt({
      runId: RUN_B,
      text: "next",
      origin: "browser",
    });
    await expect(Promise.resolve().then(() => {
      fixture.actor.enterWaiting(ownership, {
        conversationId: TARGET_CONVERSATION_ID,
        runId: RUN_A,
      });
    })).rejects.toThrow("stale");
    promptFinished.resolve();
    await second;
    await fixture.actor.dispose();
  });

  it("persists exact final text before releasing and publishing terminal", async () => {
    const order: string[] = [];
    const projectRuns = new TrackingRunCoordinator(order);
    const fixture = await openActor({
      projectRuns,
      persistSettlement: async (settlement) => {
        order.push(`persist:${settlement.finalText}`);
      },
      onCompletion: async () => {
        order.push("completion-callback");
      },
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    });
    fixture.actor.subscribe((event) => {
      if (
        event.type === "session_event"
        && event.event.type === "run_finished"
      ) {
        order.push("terminal");
      }
    });
    fixture.runtime.session.promptImplementation = async () => {
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
        },
      }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "streamed draft",
        },
      }));
      emit?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "exact final" }],
          stopReason: "stop",
        },
      }));
      emit?.(nativeEvent({ type: "agent_end" }));
    };

    const settlement = await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "answer",
      origin: "inbox",
    });

    expect(settlement).toEqual({
      runId: RUN_A,
      outcome: "completed",
      finalText: "exact final",
      settledAt: "2026-07-19T12:00:00.000Z",
    });
    expect(order).toEqual([
      "run-registered",
      "persist:exact final",
      "run-lease-released",
      "terminal",
      "completion-callback",
    ]);
    await fixture.actor.dispose();
  });

  it("uses a reserved custom entry as the default durable settlement", async () => {
    const fixture = await openActor();
    await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "finish",
      origin: "browser",
    });

    expect(fixture.manager.getBranch().at(-1)).toMatchObject({
      type: "custom",
      customType: "piweb.run_settlement.v1",
      data: {
        runId: RUN_A,
        outcome: "completed",
        finalText: null,
      },
    });
    await fixture.actor.dispose();
  });

  it("delivers an idle inbox batch as custom messages and triggers only the final turn", async () => {
    const fixture = await openActor();
    const deliveries: Array<{
      customType: string;
      content: unknown;
      triggerTurn: boolean;
    }> = [];
    fixture.runtime.session.sendCustomMessage = async (message, options) => {
      deliveries.push({
        customType: message.customType,
        content: message.content,
        triggerTurn: options?.triggerTurn === true,
      });
      fixture.manager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      if (options?.triggerTurn) {
        await fixture.runtime.session.promptImplementation("inbox");
      }
    };

    const endpoint = (conversationId: string, role: string) => ({
      conversationId,
      role: { id: role, name: role },
    });
    await fixture.actor.startMessages({
      runId: RUN_A,
      messages: [
        {
          content: "First durable message",
          display: true,
          details: {
            messageId: "f963048b-75be-4f19-947f-4552f8accb5e",
            cardId: "5dd68e6b-2b46-4c35-be3f-3121e01b646d",
            sentAt: "2026-07-19T12:00:00.000Z",
            kind: "message",
            body: "First durable message",
            fromSnapshot: endpoint(TARGET_CONVERSATION_ID, "default"),
            toSnapshot: endpoint(CONVERSATION_ID, ROLE_ID),
          },
        },
        {
          content: "Second durable message",
          display: true,
          details: {
            messageId: "2b0255dc-3819-4889-8a86-6dcf9ace5a69",
            cardId: "fa3cf7c9-814a-4763-b431-036d4041eda6",
            sentAt: "2026-07-19T12:01:00.000Z",
            kind: "message",
            body: "Second durable message",
            fromSnapshot: endpoint(TARGET_CONVERSATION_ID, "default"),
            toSnapshot: endpoint(CONVERSATION_ID, ROLE_ID),
          },
        },
      ],
    });

    expect(deliveries).toEqual([
      {
        customType: "piweb.conversation_message.v1",
        content: "First durable message",
        triggerTurn: false,
      },
      {
        customType: "piweb.conversation_message.v1",
        content: "Second durable message",
        triggerTurn: true,
      },
    ]);
    expect(fixture.manager.getEntries().filter(
      (entry) => entry.type === "custom_message",
    )).toHaveLength(2);
    await fixture.actor.dispose();
  });

  it("does not deadlock when completion schedules the next idle run", async () => {
    let actor: ConversationActor;
    let completionCalls = 0;
    let secondCompletion:
      | ReturnType<ConversationActor["startPrompt"]>
      | undefined;
    const fixture = await openActor({
      onCompletion: (completion) => {
        completionCalls++;
        if (completion.settlement.runId !== RUN_A) return;
        secondCompletion = actor.startPrompt({
          runId: RUN_B,
          text: "consume queued inbox",
          origin: "inbox",
        });
        return secondCompletion;
      },
    });
    actor = fixture.actor;

    await actor.startPrompt({
      runId: RUN_A,
      text: "first",
      origin: "browser",
    });
    if (!secondCompletion) throw new Error("next run was not scheduled");
    await secondCompletion;

    expect(completionCalls).toBe(2);
    expect(actor.getActivity()).toEqual({ kind: "idle" });
    await actor.dispose();
  });

  it("detaching an observer does not abort and dispose releases the writer", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      promptStarted.resolve();
      await promptFinished.promise;
    };
    const detach = fixture.actor.subscribe(() => undefined);
    const completion = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "background",
      origin: "browser",
    });
    await promptStarted.promise;

    detach();
    expect(fixture.runtime.session.abortCalls).toBe(0);
    promptFinished.resolve();
    await completion;
    await fixture.actor.dispose();

    expect(fixture.runtime.disposeCalls).toBe(1);
    expect(fixture.lease.releases).toBe(1);
    expect(fixture.lease.upgrades).toBe(0);
  });

  it("can transfer its writer lease atomically for deletion", async () => {
    const fixture = await openActor();

    const deletionLease = await fixture.actor.dispose({
      transferLeaseForDeletion: true,
    });

    expect(deletionLease).toBeDefined();
    expect(fixture.lease.releases).toBe(0);
    expect(fixture.lease.upgrades).toBe(1);
    deletionLease?.release();
    expect(fixture.lease.deletionReleases).toBe(1);
  });

  it("cleans the runtime and writer lease when extension activation fails", async () => {
    const runtime = new FakeRuntime();
    runtime.activationError = new Error("extension activation failed");
    const lease = new FakeConversationLease();
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });

    await expect(ConversationActor.open({
      conversationId: CONVERSATION_ID,
      profile: profile(),
      project: {
        cwd: process.cwd(),
        toolMode: "full_access",
        refreshConversations: async () => [],
      },
      sessionManager: manager,
      conversationLease: lease,
      runtime,
    })).rejects.toThrow("extension activation failed");

    expect(runtime.disposeCalls).toBe(1);
    expect(lease.releases).toBe(1);
  });

  it("releases the writer lease when the frozen profile is invalid", async () => {
    const lease = new FakeConversationLease();
    const invalidProfile = {
      ...profile(),
      role: {
        ...profile().role,
        revision: 0,
      },
    } as ConversationMeta;

    await expect(ConversationActor.open({
      conversationId: CONVERSATION_ID,
      profile: invalidProfile,
      project: {
        cwd: process.cwd(),
        toolMode: "full_access",
        refreshConversations: async () => [],
      },
      sessionManager: SessionManager.inMemory(process.cwd(), {
        id: CONVERSATION_ID,
      }),
      conversationLease: lease,
      runtime: new FakeRuntime(),
    })).rejects.toThrow();

    expect(lease.releases).toBe(1);
  });

  it("keeps the existing project tool policy and run mode snapshot", async () => {
    const fixture = await openActor();
    const decisions: Array<
      { block?: boolean; reason?: string } | undefined
    > = [];
    fixture.project.toolMode = "read_only";
    fixture.runtime.session.promptImplementation = async () => {
      decisions.push(await fixture.runtime.createOptions?.toolCallGate?.({
        toolCallId: "write-call",
        toolName: "write",
        toolSource: "builtin",
        args: { path: "generated.ts" },
        signal: new AbortController().signal,
      }));
      decisions.push(await fixture.runtime.createOptions?.toolCallGate?.({
        toolCallId: "read-call",
        toolName: "read",
        toolSource: "builtin",
        args: { path: "source.ts" },
        signal: new AbortController().signal,
      }));
    };

    await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "use tools",
      origin: "browser",
    });

    expect(decisions[0]).toMatchObject({
      block: true,
      reason: expect.stringContaining("只读模式"),
    });
    expect(decisions[1]).toBeUndefined();
    await fixture.actor.dispose();
  });
});
