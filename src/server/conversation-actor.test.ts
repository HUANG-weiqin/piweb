import type {
  AgentMessage,
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
import {
  MAX_PROMPT_CHARACTERS,
  parseServerEvent,
  type ToolMode,
} from "../shared/protocol.js";
import type {
  ConversationMessageEntry,
  ConversationMeta,
} from "./conversation-meta.js";
import {
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createConversationCardEntry,
} from "./conversation-meta.js";
import {
  ConversationActor,
  createPendingPromptBatchGuidance,
  type ConversationActorEvent,
  type ConversationActorOpenOptions,
} from "./conversation-actor.js";
import { MAX_HISTORY_SNAPSHOT_BYTES } from "./conversation-history.js";
import type {
  CreatedPiSession,
  CreatePiSessionOptions,
  CredentialChangeIntent,
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

const SESSION_ID = "f74fedb8-ea07-49a6-bd47-3036f7b06a27";
const FOCUS_ID = "cab0af06-a001-45f7-9084-2a4ac5a1ed56";
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
  promptCalls: Array<{ text: string; streamingBehavior?: "steer" | "followUp" }>;
  promptImplementation(text: string, options?: Parameters<AgentSession["prompt"]>[1]): Promise<void>;
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
    promptCalls: [],
    prompt: function (text: string, options?: Parameters<AgentSession["prompt"]>[1]) {
      this.promptCalls.push({ text, streamingBehavior: options?.streamingBehavior });
      return this.promptImplementation(text, options);
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

  beginCredentialChange(provider: string): CredentialChangeIntent {
    return { provider, revision: 1 };
  }

  async commitCredentialChange(
    _intent: CredentialChangeIntent,
    change: () => void,
  ): Promise<boolean> {
    change();
    return true;
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

function peer(conversationId = TARGET_CONVERSATION_ID) {
  return {
    conversationId,
    title: "Peer",
    role: { id: ROLE_ID, name: "Reviewer" },
  };
}

function appendCard(
  manager: SessionManagerType,
  cardId = "6cb37047-770e-4b20-96b8-c2258523af05",
): void {
  appendReservedCustomEntry(manager, createConversationCardEntry({
    cardId,
    kind: "delegation_task",
    body: "Review this",
    fromSnapshot: peer(CONVERSATION_ID),
    toSnapshot: peer(),
    state: "running",
    messageId: RUN_B,
    delegationId: "1c8afc8f-e6fe-4f8c-b1f8-892b888fb384",
    runId: RUN_A,
    updatedAt: "2026-07-19T10:00:00.000Z",
  }));
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

function agentMessage(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function checkToolTurnBoundary(runtime: FakeRuntime): boolean {
  return Boolean(runtime.createOptions?.turnBoundaryCheck?.({
    contextUsage: runtime.session.getContextUsage(),
    hasToolResults: true,
  }));
}

describe("ConversationActor", () => {
  describe("browser prompt admission while busy (A')", () => {
    const PROMPT_ID = "3c5b3e7a-1f2a-4b6e-8d0c-9a1b2c3d4e5f";

    function busyRun(
      fixture: ActorFixture,
    ): { runStarted: Deferred<void>; finishRun: Deferred<void>; running: Promise<unknown> } {
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (text === "follow up") {
          // admit 的调用：SDK 接受即入队返回
          options?.preflightResult?.(true);
          return;
        }
        emit()?.(nativeEvent({ type: "agent_start" }));
        runStarted.resolve();
        await finishRun.promise;
        emit()?.(nativeEvent({ type: "agent_end" }));
      };
      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "long task",
        origin: "browser",
      });
      return { runStarted, finishRun, running };
    }

    it("admits via SDK followUp while a run is active and emits prompt_admitted", async () => {
      const fixture = await openActor();
      const { runStarted, finishRun, running } = busyRun(fixture);
      await runStarted.promise;

      const admit = fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_B,
        text: "follow up",
      });

      await vi.waitFor(() => {
        expect(fixture.runtime.session.promptCalls).toContainEqual({
          text: "follow up",
          streamingBehavior: "followUp",
        });
      });
      await vi.waitFor(() => {
        expect(fixture.events).toContainEqual({
          type: "prompt_admitted",
          conversationId: CONVERSATION_ID,
          promptId: PROMPT_ID,
          text: "follow up",
        });
      });
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([{
        promptId: PROMPT_ID,
        text: "follow up",
        createdAt: expect.any(String),
      }]);

      finishRun.resolve();
      await running;
      await expect(admit).resolves.toEqual({ outcome: "admitted" });
      await fixture.actor.dispose();
    });

    it("emits prompt_delivered when the SDK appends the admitted user message", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const { runStarted, finishRun, running } = busyRun(fixture);
      await runStarted.promise;
      await fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_B,
        text: "follow up",
      });
      await vi.waitFor(() => expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1));

      // SDK 投递：消息持久化 + message_end user
      const rawMessage = {
        role: "user",
        content: [{ type: "text", text: "follow up" }],
      };
      fixture.manager.appendMessage(rawMessage as never);
      emit()?.(nativeEvent({ type: "message_end", message: rawMessage }));

      await vi.waitFor(() => {
        expect(fixture.events).toContainEqual({
          type: "prompt_delivered",
          conversationId: CONVERSATION_ID,
          promptId: PROMPT_ID,
          runId: RUN_A,
        });
      });
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("clears admitted prompts when the run is aborted", async () => {
      const fixture = await openActor();
      const { runStarted, finishRun, running } = busyRun(fixture);
      await runStarted.promise;
      await fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_B,
        text: "follow up",
      });
      await vi.waitFor(() => expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1));

      await fixture.actor.abort(RUN_A);
      expect(fixture.runtime.session.clearQueueCalls).toBe(1);
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await expect(running).resolves.toMatchObject({ outcome: "aborted" });
      await fixture.actor.dispose();
    });

    it("falls back to startPrompt when the actor became idle", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      fixture.runtime.session.promptImplementation = async () => {
        emit()?.(nativeEvent({ type: "agent_start" }));
        emit()?.(nativeEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
          },
        }));
        emit()?.(nativeEvent({ type: "agent_end" }));
      };

      const result = await fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "hello",
      });

      // idle 时转 startPrompt：返回 RunSettlement 而非 admitted
      expect(result).toMatchObject({ runId: RUN_A });
      expect("outcome" in (result as object) && (result as { outcome?: string }).outcome)
        .not.toBe("admitted");
      expect(fixture.runtime.session.promptCalls).toEqual([{
        text: "hello",
        streamingBehavior: undefined,
      }]);
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);
      await fixture.actor.dispose();
    });

    it("rejects duplicate promptIds and enforces the admission cap", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (text === "long task") {
          emit()?.(nativeEvent({ type: "agent_start" }));
          runStarted.resolve();
          await finishRun.promise;
          emit()?.(nativeEvent({ type: "agent_end" }));
          return;
        }
        // admit 的调用：SDK 接受即入队返回
        options?.preflightResult?.(true);
      };
      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "long task",
        origin: "browser",
      });
      await runStarted.promise;

      await expect(fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "one",
      })).resolves.toEqual({ outcome: "admitted" });
      await expect(fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_B,
        text: "duplicate",
      })).rejects.toThrow("already admitted");

      // 填满上限（已有一条 admission，再塞 63 条到 64）
      for (let index = 0; index < 63; index += 1) {
        await fixture.actor.admitBrowserPrompt({
          promptId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          runId: `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`,
          text: `message ${index}`,
        });
      }
      await expect(fixture.actor.admitBrowserPrompt({
        promptId: "22222222-3333-4444-8555-666677778888",
        runId: "99999999-8888-4777-8666-555544443333",
        text: "over the cap",
      })).rejects.toThrow("Too many pending messages");
      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });
  });

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

  it("retries a transient compaction failure after context grows", async () => {
    const fixture = await openActor();
    const boundaryDecisions: boolean[] = [];
    let attempt = 0;
    fixture.runtime.session.promptImplementation = async () => {
      fixture.runtime.session.contextPercent = 75;
      boundaryDecisions.push(checkToolTurnBoundary(fixture.runtime));
    };
    fixture.runtime.session.compactImplementation = async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient summary failure");
      return {};
    };
    fixture.runtime.session.resumeImplementation = async () => {
      if (fixture.runtime.session.resumeCalls === 1) {
        fixture.runtime.session.contextPercent = 79;
        boundaryDecisions.push(checkToolTurnBoundary(fixture.runtime));
        fixture.runtime.session.contextPercent = 81;
        boundaryDecisions.push(checkToolTurnBoundary(fixture.runtime));
      } else {
        fixture.runtime.session.contextPercent = 20;
      }
    };

    const settlement = await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "keep a long task below the context ceiling",
      origin: "browser",
    });

    expect(settlement.outcome).toBe("completed");
    expect(boundaryDecisions).toEqual([true, false, true]);
    expect(fixture.runtime.session.compactCalls).toBe(2);
    expect(fixture.runtime.session.resumeCalls).toBe(2);
    expect(fixture.events.filter(({ type }) => type === "error"))
      .toEqual([{
        type: "error",
        conversationId: CONVERSATION_ID,
        runId: RUN_A,
        message: "transient summary failure",
      }]);
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
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "session_event",
        conversationId: CONVERSATION_ID,
        runId: RUN_A,
        event: { type: "run_started" },
      }));
    });

    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "compaction_start",
    }));
    expect(fixture.actor.getState().compacting).toBe(true);
    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "compaction_end",
      result: { summary: "summary" },
      aborted: false,
      willRetry: false,
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

  it("backs off instead of immediately retrying a failed SDK compaction", async () => {
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

  it("retries a failed SDK compaction through the host after context grows", async () => {
    const fixture = await openActor();
    const boundaryDecisions: boolean[] = [];
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
      fixture.runtime.session.contextPercent = 94;
      boundaryDecisions.push(checkToolTurnBoundary(fixture.runtime));
      fixture.runtime.session.contextPercent = 96;
      boundaryDecisions.push(checkToolTurnBoundary(fixture.runtime));
    };

    await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "retry native compaction after bounded growth",
      origin: "browser",
    });

    expect(boundaryDecisions).toEqual([false, true]);
    expect(fixture.runtime.session.compactCalls).toBe(1);
    expect(fixture.runtime.session.resumeCalls).toBe(1);
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

  it("projects live active run instead of duplicating durable message tail", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const durableUser = agentMessage({
        role: "user",
        content: "inspect",
        timestamp: 1,
      });
      const durableAssistant = agentMessage({
        role: "assistant",
        content: [{ type: "text", text: "durable partial" }],
        timestamp: 2,
      });
      const openAssistant = agentMessage({ role: "assistant", content: [] });
      fixture.manager.appendMessage(durableUser);
      fixture.manager.appendMessage(durableAssistant);
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: durableUser }));
      emit?.(nativeEvent({ type: "message_start", message: durableAssistant }));
      emit?.(nativeEvent({ type: "message_start", message: openAssistant }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "live partial",
        },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const projected = fixture.actor.projectConversationItems()
      .items.filter((item) => item.kind === "message");
    expect(projected).toEqual([
      expect.objectContaining({ role: "user", text: "inspect" }),
      expect.objectContaining({ role: "assistant", text: "durable partial" }),
      expect.objectContaining({
        role: "assistant",
        runId: RUN_A,
        text: "live partial",
      }),
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("hands an exact raw assistant identity to the durable aggregate without overwriting the open suffix", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const user = agentMessage({ role: "user", content: "inspect", timestamp: 0 });
      const durable = agentMessage({
        role: "assistant",
        content: [{ type: "text", text: "committed" }],
        timestamp: 1,
      });
      const handedOff = agentMessage({
        role: "assistant",
        content: [{ type: "text", text: "handed off" }],
        timestamp: 2,
      });
      const open = agentMessage({ role: "assistant", content: [] });
      // This is intentionally not `open`: projection may receive a final
      // message event before the raw open message is durably appended.
      const finalOpenProjection = agentMessage({
        role: "assistant",
        content: [{ type: "text", text: "final tail" }],
      });
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: user }));
      fixture.manager.appendMessage(user);
      emit?.(nativeEvent({ type: "message_start", message: durable }));
      fixture.manager.appendMessage(durable);
      emit?.(nativeEvent({ type: "message_start", message: handedOff }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "handed off" },
      }));
      expect(fixture.actor.projectConversationItems().items.filter((item) => (
        item.kind === "message" && item.role === "assistant"
      ))).toEqual([
        expect.objectContaining({ role: "assistant", text: "committed" }),
        expect.objectContaining({ role: "assistant", text: "handed off" }),
      ]);
      fixture.manager.appendMessage(handedOff);
      expect(fixture.actor.projectConversationItems().items.filter((item) => (
        item.kind === "message" && item.role === "assistant"
      ))).toEqual([
        expect.objectContaining({ text: "committed\n\nhanded off", runId: RUN_A }),
      ]);
      emit?.(nativeEvent({ type: "message_start", message: open }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "draft tail" },
      }));
      emit?.(nativeEvent({
        type: "message_end",
        message: finalOpenProjection,
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    expect(fixture.actor.projectConversationItems().items.filter((item) => (
      item.kind === "message" && item.role === "assistant"
    ))).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "committed\n\nhanded off",
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        runId: RUN_A,
        text: "final tail",
      }),
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("does not let a live tool patch overwrite a durable result across a card", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const user = agentMessage({ role: "user", content: "inspect", timestamp: 1 });
      const assistant = agentMessage({
        role: "assistant",
        content: [{
          type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.ts" },
        }],
        timestamp: 2,
      });
      fixture.manager.appendMessage(user);
      fixture.manager.appendMessage(assistant);
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: user }));
      emit?.(nativeEvent({ type: "message_start", message: assistant }));
      emit?.(nativeEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "a.ts" },
      }));
      appendCard(fixture.manager);
      fixture.manager.appendMessage(agentMessage({
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "durable result" }],
        isError: false,
        timestamp: 3,
      }));
      emit?.(nativeEvent({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        partialResult: { stale: true },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const assistant = fixture.actor.projectConversationItems().items.find((item) => (
      item.kind === "message" && item.role === "assistant"
    ));
    expect(assistant).toMatchObject({
      kind: "message",
      runId: RUN_A,
      tools: [expect.objectContaining({
        toolCallId: "tool-1",
        status: "done",
        result: { content: [{ type: "text", text: "durable result" }] },
      })],
    });

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("keeps the initial durable prompt owned while a later steered user message is still open", async () => {
    const fixture = await openActor();
    const steerStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const emit = fixture.runtime.session.eventListener;
      const initial = agentMessage({
        role: "user",
        content: "inspect",
        timestamp: 1,
      });
      const assistantStarted = agentMessage({
        role: "assistant",
        content: [],
        timestamp: 2,
      });
      const assistantFinal = agentMessage({
        role: "assistant",
        content: [{ type: "text", text: "before steer" }],
        timestamp: 2,
      });
      const steer = agentMessage({
        role: "user",
        content: "steer while running",
        timestamp: 3,
      });

      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: initial }));
      emit?.(nativeEvent({ type: "message_end", message: initial }));
      fixture.manager.appendMessage(initial);
      // pi-agent-core intentionally emits a shallow partial clone at start,
      // then a different finalized object at end; only the latter is persisted.
      emit?.(nativeEvent({ type: "message_start", message: assistantStarted }));
      emit?.(nativeEvent({ type: "message_end", message: assistantFinal }));
      fixture.manager.appendMessage(assistantFinal);

      // Pi emits message_start before message_end persistence. A focused
      // snapshot can therefore observe this later user message still open.
      emit?.(nativeEvent({ type: "message_start", message: steer }));
      steerStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await steerStarted.promise;

    expect(() => fixture.actor.projectConversationItems()).not.toThrow();
    expect(fixture.actor.projectConversationItems().items).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "inspect",
        runId: RUN_A,
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "before steer",
        runId: RUN_A,
      }),
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "steer while running",
        runId: RUN_A,
      }),
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("projects live deltas into the current assistant segment after steering", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({
        type: "message_start",
        message: { role: "user", content: "inspect" },
      }));
      emit?.(nativeEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "before" },
      }));
      emit?.(nativeEvent({
        type: "message_start",
        message: { role: "user", content: "steer" },
      }));
      emit?.(nativeEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const messages = fixture.actor.projectConversationItems()
      .items.filter((item) => item.kind === "message");
    expect(messages).toEqual([
      expect.objectContaining({ role: "user", text: "inspect" }),
      expect.objectContaining({ role: "assistant", text: "before" }),
      expect.objectContaining({ role: "user", text: "steer" }),
      expect.objectContaining({ role: "assistant", text: "after" }),
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("keeps a card after all live assistant segments represented by one durable aggregate", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const user = agentMessage({ role: "user", content: "inspect", timestamp: 1 });
      const before = agentMessage({
        role: "assistant", content: [{ type: "text", text: "before" }], timestamp: 2,
      });
      const after = agentMessage({
        role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 3,
      });
      fixture.manager.appendMessage(user);
      fixture.manager.appendMessage(before);
      fixture.manager.appendMessage(after);
      appendCard(fixture.manager);
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: user }));
      emit?.(nativeEvent({ type: "message_start", message: before }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "before" },
      }));
      emit?.(nativeEvent({ type: "message_start", message: after }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const items = fixture.actor.projectConversationItems().items;
    expect(items.map((item) => (
      item.kind === "message" ? `${item.role}:${item.text}` : item.kind
    ))).toEqual([
      "user:inspect",
      "assistant:before\n\nafter",
      "session_message",
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("keeps a card between two live assistant segments without a steered user", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const user = agentMessage({ role: "user", content: "inspect", timestamp: 1 });
      const before = agentMessage({
        role: "assistant", content: [{ type: "text", text: "before" }], timestamp: 2,
      });
      const after = agentMessage({
        role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 3,
      });
      fixture.manager.appendMessage(user);
      fixture.manager.appendMessage(before);
      appendCard(fixture.manager);
      fixture.manager.appendMessage(after);
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: user }));
      emit?.(nativeEvent({ type: "message_start", message: before }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "before" },
      }));
      emit?.(nativeEvent({ type: "message_start", message: after }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const items = fixture.actor.projectConversationItems().items;
    expect(items.map((item) => (
      item.kind === "message" ? `${item.role}:${item.text}` : item.kind
    ))).toEqual([
      "user:inspect",
      "assistant:before",
      "session_message",
      "assistant:after",
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("keeps compaction between two live assistant segments", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const user = agentMessage({ role: "user", content: "inspect", timestamp: 1 });
      const before = agentMessage({
        role: "assistant", content: [{ type: "text", text: "before" }], timestamp: 2,
      });
      const after = agentMessage({
        role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 3,
      });
      fixture.manager.appendMessage(user);
      fixture.manager.appendMessage(before);
      fixture.manager.appendCompaction("summary", undefined, 30);
      fixture.manager.appendMessage(after);
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: user }));
      emit?.(nativeEvent({ type: "message_start", message: before }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "before" },
      }));
      emit?.(nativeEvent({ type: "message_start", message: after }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const items = fixture.actor.projectConversationItems().items;
    expect(items.map((item) => (
      item.kind === "message" ? `${item.role}:${item.text}` : item.kind
    ))).toEqual([
      "user:inspect",
      "assistant:before",
      "compaction",
      "assistant:after",
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("keeps the durable pre-compaction aggregate when live segments exceed the snapshot cap", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    const segmentCount = Math.floor(MAX_HISTORY_SNAPSHOT_BYTES / 80_000) + 1;
    const liveSegments = Array.from(
      { length: segmentCount },
      (_, index) => `pre-compaction-${index}-${"x".repeat(80_000)}`,
    );
    fixture.runtime.session.promptImplementation = async () => {
      const user = agentMessage({ role: "user", content: "inspect", timestamp: 1 });
      const assistants = liveSegments.map((text, index) => agentMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: index + 2,
      }));
      const suffix = agentMessage({
        role: "assistant",
        content: [{ type: "text", text: "live suffix" }],
        timestamp: segmentCount + 2,
      });
      fixture.manager.appendMessage(user);
      for (const assistant of assistants) fixture.manager.appendMessage(assistant);
      fixture.manager.appendCompaction("summary", undefined, 30);
      fixture.manager.appendMessage(suffix);

      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: user }));
      for (const [index, text] of liveSegments.entries()) {
        emit?.(nativeEvent({ type: "message_start", message: assistants[index]! }));
        emit?.(nativeEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: text },
        }));
      }
      emit?.(nativeEvent({ type: "message_start", message: suffix }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "live suffix" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const projection = fixture.actor.projectConversationItems();
    expect(projection.window.contentTruncated).toBe(true);
    expect(projection.items.map((item) => (
      item.kind === "message" ? `${item.role}:${item.text}` : item.kind
    ))).toEqual([
      "user:inspect",
      expect.stringContaining("assistant:pre-compaction-0-"),
      "compaction",
      "assistant:live suffix",
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("keeps the active browser prompt and latest live content when one live turn exceeds the page budget", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    const segmentCount = 10;
    fixture.runtime.session.promptImplementation = async () => {
      const emit = fixture.runtime.session.eventListener;
      const initialPrompt = agentMessage({
        role: "user",
        content: "inspect the active oversized run",
        timestamp: 1,
      });
      fixture.manager.appendMessage(initialPrompt);
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: initialPrompt }));
      emit?.(nativeEvent({ type: "message_end", message: initialPrompt }));

      for (let index = 0; index < segmentCount; index += 1) {
        const toolCallId = `tool-${index}`;
        const text = `live-segment-${index}-${"x".repeat(80_000)}`;
        const assistant = agentMessage({
          role: "assistant",
          content: [
            { type: "text", text },
            {
              type: "toolCall",
              id: toolCallId,
              name: "read",
              arguments: { path: `file-${index}.txt` },
            },
          ],
          stopReason: "toolUse",
          timestamp: index * 3 + 2,
        });
        fixture.manager.appendMessage(assistant);
        emit?.(nativeEvent({
          type: "message_start",
          message: assistant,
        }));
        emit?.(nativeEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: text },
        }));
        emit?.(nativeEvent({
          type: "tool_execution_start",
          toolCallId,
          toolName: "read",
          args: { path: `file-${index}.txt` },
        }));
        fixture.manager.appendMessage(agentMessage({
          role: "toolResult",
          toolCallId,
          toolName: "read",
          content: [{ type: "text", text: `tool result ${index}` }],
          isError: false,
          timestamp: index * 3 + 3,
        }));
        emit?.(nativeEvent({
          type: "tool_execution_end",
          toolCallId,
          toolName: "read",
          result: { content: `tool result ${index}` },
          isError: false,
        }));
        emit?.(nativeEvent({ type: "message_end", message: assistant }));
      }
      const openAssistant = agentMessage({ role: "assistant", content: [] });
      emit?.(nativeEvent({ type: "message_start", message: openAssistant }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "latest live content" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect the active oversized run",
      origin: "browser",
    });
    await promptStarted.promise;

    expect(fixture.actor.getActivity().kind).toBe("running");
    expect(fixture.runtime.session.compactCalls).toBe(0);
    const projection = fixture.actor.projectConversationItems();
    expect(projection.items).not.toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(projection.items), "utf8"))
      .toBeLessThanOrEqual(MAX_HISTORY_SNAPSHOT_BYTES);
    expect(projection.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "inspect the active oversized run",
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "latest live content",
      }),
    ]));
    expect(projection.window.contentTruncated).toBe(true);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("does not move a steered user message before an intervening card", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const user = agentMessage({ role: "user", content: "inspect", timestamp: 1 });
      const before = agentMessage({
        role: "assistant", content: [{ type: "text", text: "before" }], timestamp: 2,
      });
      const steer = agentMessage({ role: "user", content: "steer", timestamp: 3 });
      const after = agentMessage({
        role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 4,
      });
      fixture.manager.appendMessage(user);
      fixture.manager.appendMessage(before);
      appendCard(fixture.manager);
      fixture.manager.appendMessage(steer);
      fixture.manager.appendMessage(after);
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: user }));
      emit?.(nativeEvent({ type: "message_start", message: before }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "before" },
      }));
      emit?.(nativeEvent({ type: "message_start", message: steer }));
      emit?.(nativeEvent({ type: "message_start", message: after }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const items = fixture.actor.projectConversationItems().items;
    expect(items.map((item) => (
      item.kind === "message" ? `${item.role}:${item.text}` : item.kind
    ))).toEqual([
      "user:inspect",
      "assistant:before",
      "session_message",
      "user:steer",
      "assistant:after",
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("keeps pre-run compaction before the live prompt", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const firstKeptEntryId = fixture.manager.appendCompaction(
        "summary",
        undefined,
        30,
      );
      const user = agentMessage({ role: "user", content: "inspect", timestamp: 1 });
      const assistant = agentMessage({
        role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 2,
      });
      fixture.manager.appendMessage(user);
      fixture.manager.appendMessage(assistant);
      expect(firstKeptEntryId).toEqual(expect.any(String));
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: user }));
      emit?.(nativeEvent({ type: "message_start", message: assistant }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const items = fixture.actor.projectConversationItems().items;
    expect(items.map((item) => (
      item.kind === "message" ? `${item.role}:${item.text}` : item.kind
    ))).toEqual([
      "compaction",
      "user:inspect",
      "assistant:after",
    ]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("does not duplicate a resumed reply that extends a baseline assistant aggregate", async () => {
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    manager.appendMessage(agentMessage({
      role: "assistant",
      content: [{ type: "text", text: "old" }],
      timestamp: 1,
    }));
    const fixture = await openActor({ sessionManager: manager });
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.resumeImplementation = async () => {
      const assistant = agentMessage({
        role: "assistant",
        content: [{ type: "text", text: "after" }],
        timestamp: 2,
      });
      fixture.manager.appendMessage(assistant);
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({ type: "message_start", message: assistant }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after" },
      }));
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.resumeMessages({ runId: RUN_A });
    await promptStarted.promise;

    const items = fixture.actor.projectConversationItems().items;
    expect(items.map((item) => (
      item.kind === "message" ? `${item.role}:${item.text}` : item.kind
    ))).toEqual(["assistant:old\n\nafter"]);

    promptFinished.resolve();
    await running;
    await fixture.actor.dispose();
  });

  it("bounds live projection parts so refocus snapshots remain parseable", async () => {
    const fixture = await openActor();
    const promptStarted = deferred();
    const promptFinished = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      const emit = fixture.runtime.session.eventListener;
      emit?.(nativeEvent({ type: "agent_start" }));
      emit?.(nativeEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }));
      emit?.(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "" },
      }));
      for (let index = 0; index < 201; index += 1) {
        emit?.(nativeEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "x" },
        }));
      }
      promptStarted.resolve();
      await promptFinished.promise;
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "inspect",
      origin: "browser",
    });
    await promptStarted.promise;

    const projection = fixture.actor.projectConversationItems();
    const parsed = parseServerEvent(JSON.stringify({
      type: "conversation_snapshot",
      sessionId: SESSION_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_ID,
      projectionSeq: projection.projectionSeq,
      items: projection.items,
      window: projection.window,
    }));
    expect(parsed.type).toBe("conversation_snapshot");
    expect(projection.items).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      text: "x".repeat(201),
      parts: [{ kind: "text", offset: 0, length: 201 }],
    }));

    promptFinished.resolve();
    await running;
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
        projectionSeq: 1,
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

  it("encodes pending prompt batch guidance deterministically and rejects invalid batches", () => {
    expect(JSON.parse(createPendingPromptBatchGuidance("batch-1", [
      "first prompt",
      "second\nwith a boundary",
    ]))).toEqual({
      hostInstruction: "以下消息属于同一批，请作为整体处理。",
      batchId: "batch-1",
      items: [
        { ordinal: 1, text: "first prompt" },
        { ordinal: 2, text: "second\nwith a boundary" },
      ],
    });
    expect(() => createPendingPromptBatchGuidance("batch-1", []))
      .toThrow(/1 to/i);
    expect(() => createPendingPromptBatchGuidance("batch-1", ["   "]))
      .toThrow(/empty/i);
    expect(() => createPendingPromptBatchGuidance("batch-1", [" \t/skill"]))
      .toThrow(/slash-command/i);
    expect(() => createPendingPromptBatchGuidance(
      "batch-1",
      ["x".repeat(MAX_PROMPT_CHARACTERS)],
    )).toThrow(/exceeds/i);
  });

  it("steers a pending prompt batch once and settles it from one durable raw user message", async () => {
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
    const initialPrompt = agentMessage({
      role: "user",
      content: [{ type: "text", text: "inspect" }],
      timestamp: Date.now(),
    });
    fixture.manager.appendMessage(initialPrompt);
    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "message_start",
      message: initialPrompt,
    }));
    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "message_end",
      message: initialPrompt,
    }));
    await Promise.resolve();

    const delivery = fixture.actor.steerPendingPromptBatch(
      RUN_A,
      "batch-1",
      ["first prompt", "second prompt", "third prompt"],
    );
    expect(fixture.runtime.session.steerCalls).toHaveLength(1);
    expect(JSON.parse(fixture.runtime.session.steerCalls[0]!)).toMatchObject({
      batchId: "batch-1",
      items: [
        { ordinal: 1, text: "first prompt" },
        { ordinal: 2, text: "second prompt" },
        { ordinal: 3, text: "third prompt" },
      ],
    });

    const durableBatchMessage = agentMessage({
      role: "user",
      content: [{
        type: "text",
        text: fixture.runtime.session.steerCalls[0],
      }],
      timestamp: Date.now(),
    });
    fixture.manager.appendMessage(durableBatchMessage);
    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "message_start",
      message: durableBatchMessage,
    }));
    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: "session_event",
      conversationId: CONVERSATION_ID,
      runId: RUN_A,
      event: expect.objectContaining({
        type: "user_message",
        text: "first prompt\n\nsecond prompt\n\nthird prompt",
      }),
    }));
    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "message_end",
      message: durableBatchMessage,
    }));
    await expect(delivery).resolves.toBeUndefined();
    expect(fixture.runtime.session.steerCalls).toHaveLength(1);

    promptFinished.resolve();
    await completion;
    await fixture.actor.dispose();
  });

  it("rejects invalid pending prompt batch steering before the SDK call", async () => {
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

    await expect(fixture.actor.steerPendingPromptBatch(
      RUN_B,
      "batch-1",
      ["valid"],
    )).rejects.toMatchObject({
      classification: "rejected_before_sdk_acceptance",
      message: expect.stringContaining("not currently able"),
    });
    await expect(fixture.actor.steerPendingPromptBatch(
      RUN_A,
      "batch-1",
      ["  /skill"],
    )).rejects.toMatchObject({
      classification: "rejected_before_sdk_acceptance",
      message: expect.stringMatching(/slash-command/i),
    });
    await expect(fixture.actor.steerPendingPromptBatch(
      RUN_A,
      "batch-1",
      [""],
    )).rejects.toMatchObject({
      classification: "rejected_before_sdk_acceptance",
      message: expect.stringMatching(/empty/i),
    });
    await expect(fixture.actor.steerPendingPromptBatch(
      RUN_A,
      "batch-1",
      ["x".repeat(MAX_PROMPT_CHARACTERS)],
    )).rejects.toMatchObject({
      classification: "rejected_before_sdk_acceptance",
      message: expect.stringMatching(/exceeds/i),
    });
    expect(fixture.runtime.session.steerCalls).toEqual([]);

    promptFinished.resolve();
    await completion;
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
      .rejects.toMatchObject({
        classification: "rejected_before_sdk_acceptance",
        message: expect.stringContaining("not currently able"),
      });
    const originalSteer = fixture.runtime.session.steer;
    const sdkError = new Error("SDK steer rejected");
    fixture.runtime.session.steer = () => {
      throw sdkError;
    };
    await expect(fixture.actor.steer(RUN_A, "SDK rejection"))
      .rejects.toMatchObject({
        classification: "rejected_before_sdk_acceptance",
        cause: sdkError,
      });
    fixture.runtime.session.steer = originalSteer;
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
    let guidanceDelivered = false;
    void guidance.then(() => {
      guidanceDelivered = true;
    });
    await Promise.resolve();
    expect(guidanceDelivered).toBe(false);
    const lateInitialPrompt = agentMessage({
      role: "user",
      content: [{ type: "text", text: "late initial prompt" }],
      timestamp: Date.now(),
    });
    fixture.manager.appendMessage(lateInitialPrompt);
    fixture.runtime.session.eventListener?.({
      type: "message_end",
      message: lateInitialPrompt,
    } as AgentSessionEvent);
    await Promise.resolve();
    expect(guidanceDelivered).toBe(false);
    const transformedGuidance = agentMessage({
      role: "user",
      content: [{ type: "text", text: "template-expanded guidance" }],
      timestamp: Date.now(),
    });
    fixture.manager.appendMessage(transformedGuidance);
    fixture.runtime.session.eventListener?.({
      type: "message_end",
      message: transformedGuidance,
    } as AgentSessionEvent);
    await expect(guidance).resolves.toBeUndefined();

    const undelivered = fixture.actor.steer(RUN_A, "one more change");
    fixture.runtime.session.abort = async () => {
      fixture.runtime.session.abortCalls++;
      fixture.runtime.session.isStreaming = false;
      promptFinished.resolve();
    };
    await fixture.actor.abort(RUN_A);
    await expect(undelivered).rejects.toMatchObject({
      classification: "uncertain_after_sdk_acceptance",
      message: "Run ended before queued guidance was delivered",
    });
    await completion;
    expect(fixture.runtime.session.clearQueueCalls).toBe(1);
    await expect(fixture.actor.steer(RUN_A, "too late"))
      .rejects.toThrow("not currently able");
    await fixture.actor.dispose();
  });

  it("rejects guidance when the raw user message was not durably appended", async () => {
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
    const initialPrompt = agentMessage({
      role: "user",
      content: [{ type: "text", text: "initial persisted" }],
      timestamp: Date.now(),
    });
    fixture.manager.appendMessage(initialPrompt);
    fixture.runtime.session.eventListener?.({
      type: "message_end",
      message: initialPrompt,
    } as AgentSessionEvent);
    await Promise.resolve();
    const guidance = fixture.actor.steer(RUN_A, "guidance without append");
    fixture.runtime.session.eventListener?.({
      type: "message_end",
      message: agentMessage({
        role: "user",
        content: [{ type: "text", text: "transformed but not persisted" }],
        timestamp: Date.now(),
      }),
    } as AgentSessionEvent);
    await expect(guidance).rejects.toMatchObject({
      classification: "uncertain_after_sdk_acceptance",
      message: expect.stringMatching(/did not durably append/i),
    });
    promptFinished.resolve();
    await completion;
    await fixture.actor.dispose();
  });

  it("holds a custom peer message until the exact run reaches Pi steering", async () => {
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

    let queued: {
      content: unknown;
      deliverAs: unknown;
      triggerTurn: unknown;
    } | undefined;
    fixture.runtime.session.resumeImplementation = async (message, options) => {
      queued = {
        content: message.content,
        deliverAs: options?.deliverAs,
        triggerTurn: options?.triggerTurn,
      };
    };

    const delivery = fixture.actor.steerCustomMessage(
      RUN_A,
      {
        customType: "piweb.conversation_message.v1",
        content: "Peer supervision instruction",
        display: true,
        details: {},
      } as ConversationMessageEntry,
    );
    expect(fixture.runtime.session.resumeCalls).toBe(0);

    (fixture.runtime.session as unknown as { isStreaming: boolean })
      .isStreaming = true;
    fixture.runtime.session.eventListener?.({
      type: "agent_start",
    } as AgentSessionEvent);

    await expect(delivery).resolves.toBeUndefined();
    expect(fixture.runtime.session.resumeCalls).toBe(1);
    expect(queued).toEqual({
      content: "Peer supervision instruction",
      deliverAs: "steer",
      triggerTurn: false,
    });
    promptFinished.resolve();
    await completion;
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

  it("publishes the frozen creator with completion events", async () => {
    const inputProfile = profile();
    inputProfile.createdBy = {
      kind: "conversation",
      conversationId: TARGET_CONVERSATION_ID,
    };
    const fixture = await openActor({ profile: inputProfile });
    inputProfile.createdBy = { kind: "user" };

    await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "finish",
      origin: "browser",
    });

    expect(fixture.events.findLast(({ type }) => type === "completion"))
      .toMatchObject({
        type: "completion",
        conversationId: CONVERSATION_ID,
        settlement: { runId: RUN_A, outcome: "completed" },
        createdBy: {
          kind: "conversation",
          conversationId: TARGET_CONVERSATION_ID,
        },
      });
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
