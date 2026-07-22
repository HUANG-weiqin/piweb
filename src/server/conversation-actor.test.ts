import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  ExtensionError,
  ModelRegistry,
  SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import {
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ToolMode } from "../shared/protocol.js";
import type { ConversationMeta } from "./conversation-meta.js";
import { aggregateReservedConversationEntries } from "./conversation-meta.js";
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
  abortCompactionCalls: number;
  compactCalls: number;
  compactImplementation(): Promise<unknown>;
  contextPercent: number | null;
  clearQueueCalls: number;
  disposeCalls: number;
  eventListener?: (event: AgentSessionEvent) => void;
  steerCalls: string[];
  toolCallGate?: ToolCallGate;
  promptImplementation(text: string): Promise<void>;
  resumeCalls: number;
  turnBoundaryPaused: boolean;
  turnBoundaryPauseReleases: number;
  resumeImplementation(
    message: Parameters<AgentSession["sendCustomMessage"]>[0],
    options: Parameters<AgentSession["sendCustomMessage"]>[1],
  ): Promise<void>;
}

function fakeSettings(): SettingsManager {
  return SettingsManager.inMemory();
}

function fakeSession(): FakeSession {
  const session = {
    abortCalls: 0,
    abortCompactionCalls: 0,
    compactCalls: 0,
    compactImplementation: async () => ({}),
    contextPercent: 0,
    clearQueueCalls: 0,
    disposeCalls: 0,
    steerCalls: [],
    isStreaming: false,
    messages: [],
    model: { provider: "test", id: "model", contextWindow: 1_000 },
    thinkingLevel: "off",
    extensionRunner: {
      getCommand: () => undefined,
    },
    promptImplementation: async () => undefined,
    resumeCalls: 0,
    turnBoundaryPaused: false,
    turnBoundaryPauseReleases: 0,
    resumeImplementation: async () => undefined,
    prompt: function (text: string) {
      return this.promptImplementation(text);
    },
    sendCustomMessage: function (message, options) {
      this.resumeCalls++;
      return this.resumeImplementation(message, options);
    },
    steer: async function (text: string) {
      this.steerCalls.push(text);
    },
    clearQueue: function () {
      this.clearQueueCalls++;
      return { steering: [], followUp: [] };
    },
    abort: async function () {
      this.abortCalls++;
      this.isStreaming = false;
    },
    abortCompaction: function () {
      this.abortCompactionCalls++;
    },
    getContextUsage: function () {
      return {
        tokens: this.contextPercent === null
          ? null
          : this.contextPercent * 10,
        contextWindow: 1_000,
        percent: this.contextPercent,
      };
    },
    compact: async function () {
      this.compactCalls++;
      const result = await this.compactImplementation();
      this.contextPercent = null;
      return result;
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
    const turnBoundaryCheck = options.turnBoundaryCheck;
    this.createOptions = {
      ...options,
      turnBoundaryCheck: turnBoundaryCheck
        ? (input) => {
            const shouldStop = turnBoundaryCheck(input);
            if (shouldStop) this.session.turnBoundaryPaused = true;
            return shouldStop;
          }
        : undefined,
    };
    this.session.toolCallGate = options.toolCallGate;
    return {
      session: this.session,
      settings: this.settings,
      modelRegistry: this.modelRegistry,
      releaseTurnBoundaryPause: () => {
        if (!this.session.turnBoundaryPaused) return;
        this.session.turnBoundaryPaused = false;
        this.session.turnBoundaryPauseReleases++;
      },
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
      toolMode: "read_only",
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
  it("persists and triggers a per-conversation compaction threshold", async () => {
    const fixture = await openActor();

    expect(fixture.actor.getCompactionThresholdPercent()).toBe(70);

    fixture.actor.setCompactionThresholdPercent(55);
    fixture.runtime.session.contextPercent = 60;
    await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "compact after this turn",
      origin: "browser",
    });

    expect(fixture.runtime.session.compactCalls).toBe(1);
    expect(aggregateReservedConversationEntries(
      fixture.manager.getEntries(),
    ).compactionThreshold?.percent).toBe(55);
    await fixture.actor.dispose();
  });

  it("publishes automatic compaction progress while compacting after a run", async () => {
    const fixture = await openActor();
    const compactionStarted = deferred();
    const finishCompaction = deferred();
    fixture.runtime.session.contextPercent = 80;
    fixture.runtime.session.compactImplementation = async () => {
      compactionStarted.resolve();
      await finishCompaction.promise;
      return {};
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "compact after this turn",
      origin: "browser",
    });
    await compactionStarted.promise;

    expect(fixture.actor.getState().compacting).toBe(true);
    expect(fixture.events.filter(({ type }) => type === "compaction"))
      .toEqual([{
        type: "compaction",
        conversationId: CONVERSATION_ID,
        compacting: true,
      }]);

    finishCompaction.resolve();
    await running;

    expect(fixture.actor.getState().compacting).toBe(false);
    expect(fixture.events.filter(({ type }) => type === "compaction"))
      .toEqual([{
        type: "compaction",
        conversationId: CONVERSATION_ID,
        compacting: true,
      }, {
        type: "compaction",
        conversationId: CONVERSATION_ID,
        compacting: false,
      }]);
    await fixture.actor.dispose();
  });

  it("compacts and resumes the same workbench run at a tool-turn boundary", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;

    fixture.runtime.session.promptImplementation = async () => {
      emit()?.(nativeEvent({ type: "agent_start" }));
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "before compaction" }],
          stopReason: "toolUse",
        },
      }));
      fixture.runtime.session.contextPercent = 75;
      expect(fixture.runtime.createOptions?.turnBoundaryCheck?.({
        contextUsage: fixture.runtime.session.getContextUsage(),
        hasToolResults: true,
      })).toBe(true);
      emit()?.(nativeEvent({ type: "agent_end" }));
    };
    fixture.runtime.session.resumeImplementation = async (message, options) => {
      expect(message).toMatchObject({
        customType: "piweb.compaction_resume.v1",
        display: false,
      });
      expect(options).toMatchObject({ triggerTurn: true });
      fixture.runtime.session.contextPercent = 25;
      emit()?.(nativeEvent({ type: "agent_start" }));
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "after compaction" }],
          stopReason: "stop",
        },
      }));
      expect(fixture.runtime.createOptions?.turnBoundaryCheck?.({
        contextUsage: fixture.runtime.session.getContextUsage(),
        hasToolResults: false,
      })).toBe(false);
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    const settlement = await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "finish a long task",
      origin: "browser",
    });

    expect(fixture.runtime.session.compactCalls).toBe(1);
    expect(fixture.runtime.session.resumeCalls).toBe(1);
    expect(fixture.runtime.session.turnBoundaryPauseReleases).toBe(1);
    expect(settlement.finalText).toBe(
      "before compaction\n\nafter compaction",
    );
    expect(fixture.events.filter((event) => event.type === "context_usage"))
      .toHaveLength(4);
    expect(fixture.events.filter((event) => (
      event.type === "session_event"
      && (event.event.type === "run_started" || event.event.type === "run_finished")
    ))).toHaveLength(2);
    await fixture.actor.dispose();
  });

  it("does not inject a second resume when Pi continued after native compaction", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;

    fixture.runtime.session.promptImplementation = async () => {
      emit()?.(nativeEvent({ type: "agent_start" }));
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "before native continuation" }],
          stopReason: "toolUse",
        },
      }));
      fixture.runtime.session.contextPercent = 95;
      expect(fixture.runtime.createOptions?.turnBoundaryCheck?.({
        contextUsage: fixture.runtime.session.getContextUsage(),
        hasToolResults: true,
      })).toBe(true);
      emit()?.(nativeEvent({ type: "agent_end" }));
      emit()?.(nativeEvent({ type: "compaction_start", reason: "threshold" }));
      emit()?.(nativeEvent({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "summary" },
        aborted: false,
        willRetry: false,
      }));

      fixture.runtime.session.contextPercent = 20;
      emit()?.(nativeEvent({ type: "agent_start" }));
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "after native continuation" }],
          stopReason: "stop",
        },
      }));
      expect(fixture.runtime.createOptions?.turnBoundaryCheck?.({
        contextUsage: fixture.runtime.session.getContextUsage(),
        hasToolResults: false,
      })).toBe(false);
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    const settlement = await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "continue after native compaction",
      origin: "browser",
    });

    expect(fixture.runtime.session.compactCalls).toBe(0);
    expect(fixture.runtime.session.resumeCalls).toBe(0);
    expect(settlement.finalText).toBe(
      "before native continuation\n\nafter native continuation",
    );
    await fixture.actor.dispose();
  });

  it("does not resume a turn-boundary checkpoint after cancellation", async () => {
    const fixture = await openActor();
    const compactionStarted = deferred();
    const finishCompaction = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      fixture.runtime.session.contextPercent = 80;
      expect(fixture.runtime.createOptions?.turnBoundaryCheck?.({
        contextUsage: fixture.runtime.session.getContextUsage(),
        hasToolResults: true,
      })).toBe(true);
    };
    fixture.runtime.session.compactImplementation = async () => {
      compactionStarted.resolve();
      await finishCompaction.promise;
      throw new Error("Compaction cancelled");
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "cancel at the checkpoint",
      origin: "browser",
    });
    await compactionStarted.promise;
    await fixture.actor.abort(RUN_A);
    finishCompaction.resolve();

    await expect(running).resolves.toMatchObject({ outcome: "aborted" });
    expect(fixture.runtime.session.abortCompactionCalls).toBe(1);
    expect(fixture.runtime.session.resumeCalls).toBe(0);
    await fixture.actor.dispose();
  });

  it("continues the unfinished task after a turn-boundary compaction failure", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;
    fixture.runtime.session.promptImplementation = async () => {
      emit()?.(nativeEvent({ type: "agent_start" }));
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "before failed compaction" }],
          stopReason: "toolUse",
        },
      }));
      fixture.runtime.session.contextPercent = 80;
      fixture.runtime.createOptions?.turnBoundaryCheck?.({
        contextUsage: fixture.runtime.session.getContextUsage(),
        hasToolResults: true,
      });
      emit()?.(nativeEvent({ type: "agent_end" }));
    };
    fixture.runtime.session.compactImplementation = async () => {
      throw new Error("summary provider unavailable");
    };
    fixture.runtime.session.resumeImplementation = async () => {
      emit()?.(nativeEvent({ type: "agent_start" }));
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "continued without compaction" }],
          stopReason: "stop",
        },
      }));
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    const settlement = await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "do not truncate the task",
      origin: "browser",
    });

    expect(settlement).toMatchObject({
      outcome: "completed",
      finalText:
        "before failed compaction\n\ncontinued without compaction",
    });
    expect(fixture.runtime.session.resumeCalls).toBe(1);
    expect(fixture.events).toContainEqual({
      type: "error",
      conversationId: CONVERSATION_ID,
      runId: RUN_A,
      message: "summary provider unavailable",
    });
    await fixture.actor.dispose();
  });

  it("compacts an inherited high-water context before the next run", async () => {
    const fixture = await openActor();
    const order: string[] = [];
    fixture.runtime.session.promptImplementation = async () => {
      order.push("failed prompt");
      fixture.runtime.session.contextPercent = 80;
      throw new Error("model failed");
    };

    await expect(fixture.actor.startPrompt({
      runId: RUN_A,
      text: "first attempt",
      origin: "browser",
    })).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.runtime.session.compactCalls).toBe(0);

    fixture.runtime.session.compactImplementation = async () => {
      order.push("compact");
      return {};
    };
    fixture.runtime.session.promptImplementation = async () => {
      order.push("next prompt");
    };
    await fixture.actor.startPrompt({
      runId: RUN_B,
      text: "retry safely",
      origin: "browser",
    });

    expect(order).toEqual(["failed prompt", "compact", "next prompt"]);
    expect(fixture.runtime.session.compactCalls).toBe(1);
    await fixture.actor.dispose();
  });

  it("rechecks the threshold after host pre-compaction when the run refills context", async () => {
    const fixture = await openActor();
    fixture.runtime.session.contextPercent = 80;
    fixture.runtime.session.compactImplementation = async () => {
      fixture.runtime.session.eventListener?.(nativeEvent({
        type: "compaction_start",
        reason: "threshold",
      }));
      fixture.runtime.session.eventListener?.(nativeEvent({
        type: "compaction_end",
        reason: "threshold",
      }));
      return {};
    };
    fixture.runtime.session.promptImplementation = async () => {
      fixture.runtime.session.contextPercent = 80;
    };

    await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "grow after pre-compaction",
      origin: "browser",
    });

    expect(fixture.runtime.session.compactCalls).toBe(2);
    await fixture.actor.dispose();
  });

  it("does not retry a failed host pre-compaction after the run", async () => {
    const fixture = await openActor();
    fixture.runtime.session.contextPercent = 80;
    fixture.runtime.session.compactImplementation = async () => {
      throw new Error("host compaction failed");
    };

    await expect(fixture.actor.startPrompt({
      runId: RUN_A,
      text: "continue after compaction failure",
      origin: "browser",
    })).resolves.toMatchObject({ outcome: "completed" });

    expect(fixture.runtime.session.compactCalls).toBe(1);
    expect(fixture.events.filter(({ type }) => type === "error"))
      .toEqual([{
        type: "error",
        conversationId: CONVERSATION_ID,
        runId: RUN_A,
        message: "host compaction failed",
      }]);
    await fixture.actor.dispose();
  });

  it("observes SDK-owned compaction as actor activity", async () => {
    const fixture = await openActor();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = () =>
      promptFinished.promise;
    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "let the SDK compact",
      origin: "browser",
    });
    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual({
        type: "session_event",
        conversationId: CONVERSATION_ID,
        runId: RUN_A,
        event: { type: "run_started" },
      });
    });

    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "compaction_start",
    }));
    expect(fixture.actor.getState().compacting).toBe(true);
    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "compaction_end",
    }));
    expect(fixture.actor.getState().compacting).toBe(false);
    expect(fixture.events.filter(({ type }) => type === "compaction"))
      .toEqual([{
        type: "compaction",
        conversationId: CONVERSATION_ID,
        compacting: true,
      }, {
        type: "compaction",
        conversationId: CONVERSATION_ID,
        compacting: false,
      }]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("does not retry a failed SDK compaction through the host threshold", async () => {
    const fixture = await openActor();
    fixture.runtime.session.promptImplementation = async () => {
      fixture.runtime.session.contextPercent = 90;
      fixture.runtime.session.eventListener?.(nativeEvent({
        type: "compaction_start",
        reason: "threshold",
      }));
      fixture.runtime.session.eventListener?.(nativeEvent({
        type: "compaction_end",
        reason: "threshold",
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: "SDK compaction failed",
      }));
    };

    await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "one compaction attempt is enough",
      origin: "browser",
    });

    expect(fixture.runtime.session.compactCalls).toBe(0);
    expect(fixture.events.filter(({ type }) => type === "error"))
      .toEqual([{
        type: "error",
        conversationId: CONVERSATION_ID,
        runId: RUN_A,
        message: "SDK compaction failed",
      }]);
    await fixture.actor.dispose();
  });

  it("aborts threshold compaction before settling a queued run", async () => {
    const fixture = await openActor();
    const compactionStarted = deferred();
    const finishCompaction = deferred();
    let promptCalls = 0;
    fixture.runtime.session.contextPercent = 80;
    fixture.runtime.session.compactImplementation = async () => {
      compactionStarted.resolve();
      await finishCompaction.promise;
      return {};
    };
    fixture.runtime.session.abortCompaction = () => {
      fixture.runtime.session.abortCompactionCalls++;
      finishCompaction.resolve();
    };
    fixture.runtime.session.promptImplementation = async () => {
      promptCalls++;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "cancel before model call",
      origin: "browser",
    });
    await compactionStarted.promise;
    await fixture.actor.abort(RUN_A);
    await expect(running).resolves.toMatchObject({ outcome: "aborted" });

    expect(fixture.runtime.session.abortCompactionCalls).toBe(1);
    expect(promptCalls).toBe(0);
    expect(fixture.actor.getState().compacting).toBe(false);
    await fixture.actor.dispose();
  });

  it("settles an explicit stop during post-run compaction as aborted", async () => {
    const fixture = await openActor();
    const compactionStarted = deferred();
    const abortCompaction = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      fixture.runtime.session.contextPercent = 80;
    };
    fixture.runtime.session.compactImplementation = async () => {
      compactionStarted.resolve();
      await abortCompaction.promise;
      throw new Error("Compaction cancelled");
    };
    fixture.runtime.session.abortCompaction = () => {
      fixture.runtime.session.abortCompactionCalls++;
      abortCompaction.resolve();
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "stop during post-run compaction",
      origin: "browser",
    });
    await compactionStarted.promise;
    await fixture.actor.abort(RUN_A);

    await expect(running).resolves.toMatchObject({ outcome: "aborted" });
    expect(fixture.runtime.session.abortCompactionCalls).toBe(1);
    expect(fixture.events.filter(({ type }) => type === "error")).toEqual([]);
    await fixture.actor.dispose();
  });

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

  it("steers the exact active run even before the SDK streaming flag catches up", async () => {
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
    await promptStarted.promise;
    fixture.runtime.session.eventListener?.({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "inspect" }],
        timestamp: Date.now(),
      },
    } as AgentSessionEvent);

    await expect(fixture.actor.steer(RUN_B, "wrong run"))
      .rejects.toThrow("not currently able");
    expect(fixture.runtime.session.isStreaming).toBe(false);
    const guidance = fixture.actor.steer(RUN_A, "  change direction  ");
    expect(fixture.runtime.session.steerCalls).toEqual(["change direction"]);
    fixture.runtime.session.eventListener?.({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "change direction" }],
        timestamp: Date.now(),
      },
    } as AgentSessionEvent);
    await expect(guidance).resolves.toBeUndefined();

    const undelivered = fixture.actor.steer(RUN_A, "one more change");
    fixture.runtime.session.abort = async () => {
      fixture.runtime.session.abortCalls++;
      fixture.runtime.session.isStreaming = false;
      promptFinished.resolve();
    };
    await fixture.actor.abort(RUN_A);
    await expect(undelivered).rejects.toThrow(
      "Run ended before queued guidance was delivered",
    );
    await completion;
    expect(fixture.runtime.session.clearQueueCalls).toBe(1);
    await expect(fixture.actor.steer(RUN_A, "too late"))
      .rejects.toThrow("not currently able");
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
    expect(fixture.runtime.session.clearQueueCalls).toBe(1);
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
      recovered: false,
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

  it("uses the frozen role tool policy instead of mutable project state", async () => {
    const fixture = await openActor();
    const decisions: Array<
      { block?: boolean; reason?: string } | undefined
    > = [];
    fixture.project.toolMode = "full_access";
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

  it("manually compacts only while the conversation is idle", async () => {
    const fixture = await openActor();
    const compactionStarted = deferred();
    const finishCompaction = deferred();
    fixture.runtime.session.compactImplementation = async () => {
      compactionStarted.resolve();
      await finishCompaction.promise;
      return {};
    };

    const compaction = fixture.actor.compactContext();
    expect(() => fixture.actor.startPrompt({
      runId: RUN_A,
      text: "must not race the compaction reservation",
      origin: "browser",
    })).toThrow("Conversation is compacting");
    await compactionStarted.promise;
    expect(fixture.actor.getState().compacting).toBe(true);
    finishCompaction.resolve();
    await compaction;
    expect(fixture.actor.getState().compacting).toBe(false);
    expect(fixture.runtime.session.compactCalls).toBe(1);

    let finishPrompt!: () => void;
    fixture.runtime.session.promptImplementation = () => new Promise<void>(
      (resolve) => {
        finishPrompt = resolve;
      },
    );
    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "stay busy",
      origin: "browser",
    });
    await vi.waitFor(() => expect(fixture.actor.getActivity().kind).toBe("running"));

    await expect(fixture.actor.compactContext()).rejects.toThrow(
      "Cannot compact a busy conversation",
    );
    finishPrompt();
    await running;
  });
});
