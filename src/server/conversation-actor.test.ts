import type {
  AgentMessage,
  AgentSession,
  AgentSessionEvent,
  ExtensionError,
  ModelRuntime,
  ModelRegistry,
  SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import {
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  MAX_PROMPT_CHARACTERS,
  parseServerEvent,
  type ConversationSummary,
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
  createConversationMetaEntry,
  createLoopListContinueEntry,
  createLoopListEntry,
  createServiceTierSelectionEntry,
  LEGACY_LOOP_LIST_CUSTOM_TYPE,
  LOOP_LIST_CUSTOM_TYPE,
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

const SESSION_ID = "f74fedb8-ea07-49a6-bd47-3036f7b06a27";
const FOCUS_ID = "cab0af06-a001-45f7-9084-2a4ac5a1ed56";
const CONVERSATION_ID = "0dd23f7c-80c8-4713-b7a7-33c00177a101";
const TARGET_CONVERSATION_ID =
  "e15c861c-e18f-4290-bc22-8932f3caaf4e";
const ROLE_ID = "b17204b1-6155-4fea-9be5-a70aaa670bf3";
const RUN_A = "ba39f161-b67f-47c9-9285-e391427ed7d0";
const RUN_B = "65feacc3-00b4-45bd-80ee-5e18bc32f7dc";
const RELOAD_REQUEST_ID = "a73ba106-664e-4915-85d8-f82d12ed9658";
const OTHER_RELOAD_REQUEST_ID = "5e2e5f95-8434-4a25-a760-428d929e7d6a";

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
  contextTokens?: number | null;
  clearQueueCalls: number;
  disposeCalls: number;
  eventListener?: (event: AgentSessionEvent) => void;
  steerCalls: string[];
  /** Real text steering queue mirroring the SDK (admission verification reads it). */
  steeringMessages: string[];
  /** Simulated SDK queued text for steers (may differ from the submitted text). */
  steerExpandedText?: string;
  /** Simulated input-extension handlers (admission precheck). */
  hasInputExtensionHandlers?: boolean;
  toolCallGate?: ToolCallGate;
  promptCalls: Array<{ text: string; streamingBehavior?: "steer" | "followUp" }>;
  promptImplementation(text: string, options?: Parameters<AgentSession["prompt"]>[1]): Promise<void>;
  setSessionNameImplementation(name: string): void;
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
    agent: {
      state: {
        messages: [],
        thinkingLevel: "off",
      },
    },
    model: {
      provider: "test",
      id: "model",
      contextWindow: 1_000,
      cost: { input: 10, output: 1, cacheRead: 1, cacheWrite: 1 },
    },
    thinkingLevel: "off",
    extensionRunner: {
      getCommand: () => undefined,
    },
    promptImplementation: async () => undefined,
    setSessionNameImplementation: () => undefined,
    resumeCalls: 0,
    turnBoundaryPaused: false,
    turnBoundaryPauseReleases: 0,
    resumeImplementation: async () => undefined,
    steeringMessages: [],
    promptCalls: [],
    prompt: function (text: string, options?: Parameters<AgentSession["prompt"]>[1]) {
      this.promptCalls.push({ text, streamingBehavior: options?.streamingBehavior });
      return this.promptImplementation(text, options);
    },
    setSessionName: function (name: string) {
      this.setSessionNameImplementation(name);
    },
    getSteeringMessages: function () {
      return this.steeringMessages;
    },
    hasExtensionHandlers: function (eventType: string) {
      return eventType === "input" && this.hasInputExtensionHandlers === true;
    },
    sendCustomMessage: function (message, options) {
      this.resumeCalls++;
      return this.resumeImplementation(message, options);
    },
    steer: async function (text: string) {
      this.steerCalls.push(text);
      this.steeringMessages.push(this.steerExpandedText ?? text);
    },
    clearQueue: function () {
      this.clearQueueCalls++;
      this.steeringMessages.splice(0);
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
      if (this.contextTokens !== undefined) {
        return {
          tokens: this.contextTokens,
          contextWindow: 200_000,
          percent: this.contextTokens === null
            ? null
            : this.contextTokens / 2_000,
        };
      }
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
  readonly credentialStore = new InMemoryCredentialStore();
  titleImplementation: ModelRuntime["completeSimple"] = async () =>
    automaticTitleMessage("测试任务");
  readonly titleCalls: Array<Parameters<ModelRuntime["completeSimple"]>> = [];
  readonly modelRuntime = {
    completeSimple: (...args: Parameters<ModelRuntime["completeSimple"]>) => {
      this.titleCalls.push(args);
      return this.titleImplementation(...args);
    },
  } as unknown as ModelRuntime;
  readonly modelRegistry = {} as ModelRegistry;
  readonly session = fakeSession();
  readonly settings = fakeSettings();
  createOptions?: CreatePiSessionOptions;
  disposeCalls = 0;
  activationError?: Error;
  pendingExtensionErrors: ExtensionError[] = [];
  extensionErrorHandler?: (error: ExtensionError) => void;
  nextSteeringCapture?: AgentMessage;
  readonly steeringCaptures: AgentMessage[] = [];
  private nextSteeringTimestamp = 1;

  takeSteeringCapture(expectedText: string): AgentMessage {
    const index = this.steeringCaptures.findIndex((message) =>
      message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((part) =>
        part.type === "text" && part.text === expectedText
      )
    );
    if (index < 0) {
      throw new Error(`No captured steering message for: ${expectedText}`);
    }
    return this.steeringCaptures.splice(index, 1)[0]!;
  }

  async createProjectModelCatalog() {
    return {
      modelRuntime: this.modelRuntime,
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
    const thinkingLevel = options.thinkingLevel ?? "off";
    this.session.agent.state.thinkingLevel = thinkingLevel;
    Object.assign(this.session, { thinkingLevel });
    this.session.setSessionNameImplementation = (name) => {
      options.sessionManager?.appendSessionInfo(name);
    };
    this.session.setThinkingLevel = (level) => {
      this.session.agent.state.thinkingLevel = level;
      Object.assign(this.session, { thinkingLevel: level });
      options.sessionManager?.appendThinkingLevelChange(level);
    };
    return {
      session: this.session,
      settings: this.settings,
      modelRuntime: this.modelRuntime,
      modelRegistry: this.modelRegistry,
      releaseTurnBoundaryPause: () => {
        if (!this.session.turnBoundaryPaused) return;
        this.session.turnBoundaryPaused = false;
        this.session.turnBoundaryPauseReleases++;
      },
      captureSteeringMessage: (operation) => {
        const before = [...this.session.steeringMessages];
        const explicitMessage = this.nextSteeringCapture;
        this.nextSteeringCapture = undefined;
        const result = operation();
        const remaining = [...before];
        const queuedText = this.session.steeringMessages.find((text) => {
          const index = remaining.indexOf(text);
          if (index < 0) return true;
          remaining.splice(index, 1);
          return false;
        });
        const message = explicitMessage ?? (queuedText === undefined
          ? undefined
          : agentMessage({
              role: "user",
              content: [{ type: "text", text: queuedText }],
              timestamp: this.nextSteeringTimestamp++,
            }));
        if (message !== undefined) this.steeringCaptures.push(message);
        return {
          result,
          ...(message === undefined ? {} : { message }),
        };
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
    change: () => Promise<void> | void,
  ): Promise<boolean> {
    return Promise.resolve(change()).then(() => true);
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
    hasPersistedConversationNameIntent(): Promise<boolean>;
    refreshConversations(): Promise<ConversationSummary[]>;
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
    hasPersistedConversationNameIntent: async () =>
      hasPersistedConversationNameIntent(manager),
    refreshConversations: async () => conversationSummaries(manager),
  };
  const actor = await ConversationActor.open({
    conversationId: CONVERSATION_ID,
    profile: profile(),
    project,
    sessionManager: manager,
    conversationLease: lease,
    runtime,
    ...overrides,
    createSessionOptionsForProfile:
      overrides.createSessionOptionsForProfile ?? (() => ({})),
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

function automaticTitleMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function hasPersistedConversationNameIntent(
  manager: SessionManagerType,
): boolean {
  return manager.getEntries().some((entry) => entry.type === "session_info");
}

function conversationSummaries(
  manager: SessionManagerType,
): ConversationSummary[] {
  const name = manager.getSessionName();
  return [{
    id: manager.getSessionId(),
    ...(name === undefined ? {} : { name }),
    preview: "",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    messageCount: 0,
  }];
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
  describe("initial automatic title", () => {
    it("acknowledges an eligible first prompt before naming, then names it before the Agent starts", async () => {
      const runtime = new FakeRuntime();
      const manager = SessionManager.inMemory(process.cwd(), {
        id: CONVERSATION_ID,
      });
      const titleResult = deferred<AssistantMessage>();
      const order: string[] = [];
      runtime.titleImplementation = async () => {
        order.push("title");
        return titleResult.promise;
      };
      const project = {
        cwd: process.cwd(),
        toolMode: "full_access" as ToolMode,
        hasPersistedConversationNameIntent: async () => {
          order.push("verify");
          return hasPersistedConversationNameIntent(manager);
        },
        refreshConversations: async () => {
          order.push("refresh");
          return conversationSummaries(manager);
        },
      };
      const fixture = await openActor({
        runtime,
        sessionManager: manager,
        project,
      });
      runtime.session.setSessionNameImplementation = (name) => {
        order.push("name");
        manager.appendSessionInfo(name);
      };
      runtime.session.promptImplementation = async () => {
        order.push("prompt");
      };

      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "让首轮会话自动生成简短标题",
        origin: "browser",
      });

      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "session_event",
        runId: RUN_A,
        event: { type: "run_queued" },
      }));
      expect(fixture.actor.getActivity()).toEqual({
        kind: "queued",
        runId: RUN_A,
      });
      await vi.waitFor(() => expect(runtime.titleCalls).toHaveLength(1));

      expect(runtime.session.promptCalls).toEqual([]);
      expect(manager.getSessionName()).toBeUndefined();
      expect(runtime.titleCalls[0]?.[1]).toMatchObject({
        messages: [{
          role: "user",
          content: "让首轮会话自动生成简短标题",
        }],
      });
      expect(runtime.titleCalls[0]?.[1].tools).toBeUndefined();

      titleResult.resolve(automaticTitleMessage(
        "  会话首轮自动命名  \n这行解释不应进入标题",
      ));
      await expect(running).resolves.toMatchObject({ outcome: "completed" });

      expect(manager.getSessionName()).toBe("会话首轮自动命名");
      expect(order.slice(0, 5)).toEqual([
        "title",
        "name",
        "verify",
        "refresh",
        "prompt",
      ]);
      expect(fixture.events.filter((event) => (
        event.type === "session_event"
        && event.runId === RUN_A
        && event.event.type === "run_queued"
      ))).toHaveLength(1);
      await fixture.actor.dispose();
    });

    it("bounds and sanitizes a generated title", async () => {
      const runtime = new FakeRuntime();
      runtime.titleImplementation = async () => automaticTitleMessage(
        `标题：${"界".repeat(30)}\u0000ignored`,
      );
      const fixture = await openActor({ runtime });

      await fixture.actor.startPrompt({
        runId: RUN_A,
        text: "generate a bounded title",
        origin: "browser",
      });

      expect(fixture.manager.getSessionName()).toBe("界".repeat(24));
      await fixture.actor.dispose();
    });

    it("uses a generic durable fallback when title generation fails", async () => {
      const runtime = new FakeRuntime();
      runtime.titleImplementation = async () => {
        throw new Error("title provider unavailable");
      };
      const fixture = await openActor({ runtime });

      await expect(fixture.actor.startPrompt({
        runId: RUN_A,
        text: "continue despite title failure",
        origin: "browser",
      })).resolves.toMatchObject({ outcome: "completed" });

      expect(fixture.manager.getSessionName()).toBe("新任务");
      expect(runtime.session.promptCalls).toEqual([{
        text: "continue despite title failure",
        streamingBehavior: undefined,
      }]);
      await fixture.actor.dispose();
    });

    it("lets a durably proved explicit name win while generation is pending", async () => {
      const runtime = new FakeRuntime();
      const manager = SessionManager.inMemory(process.cwd(), {
        id: CONVERSATION_ID,
      });
      const titleStarted = deferred();
      const releaseTitle = deferred<AssistantMessage>();
      let proofCalls = 0;
      runtime.titleImplementation = async () => {
        titleStarted.resolve();
        return releaseTitle.promise;
      };
      const fixture = await openActor({
        runtime,
        sessionManager: manager,
        project: {
          cwd: process.cwd(),
          toolMode: "full_access",
          hasPersistedConversationNameIntent: async () => {
            proofCalls += 1;
            return hasPersistedConversationNameIntent(manager);
          },
          refreshConversations: async () => conversationSummaries(manager),
        },
      });

      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "do not overwrite a manual name",
        origin: "browser",
      });
      await titleStarted.promise;
      manager.appendSessionInfo("人工标题");
      releaseTitle.resolve(automaticTitleMessage("自动标题"));
      await running;

      expect(manager.getSessionName()).toBe("人工标题");
      expect(proofCalls).toBe(1);
      expect(runtime.session.promptCalls).toHaveLength(1);
      await fixture.actor.dispose();
    });

    it("cancels pending title generation without starting the Agent", async () => {
      const runtime = new FakeRuntime();
      const titleStarted = deferred();
      runtime.titleImplementation = async (_model, _context, options) => {
        titleStarted.resolve();
        return new Promise<AssistantMessage>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      };
      const fixture = await openActor({ runtime });

      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "cancel while naming",
        origin: "browser",
      });
      await titleStarted.promise;
      await fixture.actor.abort(RUN_A);
      await expect(running).resolves.toMatchObject({ outcome: "aborted" });

      expect(runtime.session.promptCalls).toEqual([]);
      expect(fixture.manager.getSessionName()).toBeUndefined();
      await fixture.actor.dispose();
    });

    it("does not rename an unnamed conversation that already has transcript content", async () => {
      const manager = SessionManager.inMemory(process.cwd(), {
        id: CONVERSATION_ID,
      });
      manager.appendMessage(agentMessage({
        role: "user",
        content: "existing task",
        timestamp: Date.now(),
      }));
      const runtime = new FakeRuntime();
      const fixture = await openActor({
        sessionManager: manager,
        runtime,
      });

      await fixture.actor.startPrompt({
        runId: RUN_A,
        text: "later task",
        origin: "browser",
      });

      expect(runtime.titleCalls).toEqual([]);
      expect(manager.getSessionName()).toBeUndefined();
      await fixture.actor.dispose();
    });

    it("does not rename an unnamed conversation with custom handoff context", async () => {
      const manager = SessionManager.inMemory(process.cwd(), {
        id: CONVERSATION_ID,
      });
      manager.appendCustomMessageEntry(
        "test.peer_handoff",
        "context supplied before the browser prompt",
        false,
      );
      const runtime = new FakeRuntime();
      const fixture = await openActor({ sessionManager: manager, runtime });

      await fixture.actor.startPrompt({
        runId: RUN_A,
        text: "continue from the handoff",
        origin: "browser",
      });

      expect(runtime.titleCalls).toEqual([]);
      expect(manager.getSessionName()).toBeUndefined();
      await fixture.actor.dispose();
    });

    it("does not auto-title a peer-created normal conversation", async () => {
      const runtime = new FakeRuntime();
      const fixture = await openActor({
        runtime,
        profile: {
          ...profile(),
          createdBy: {
            kind: "conversation",
            conversationId: TARGET_CONVERSATION_ID,
          },
        },
      });

      await fixture.actor.startPrompt({
        runId: RUN_A,
        text: "peer browser follow-up",
        origin: "browser",
      });

      expect(runtime.titleCalls).toEqual([]);
      expect(fixture.manager.getSessionName()).toBeUndefined();
      await fixture.actor.dispose();
    });

    it("treats an explicit cleared title as a user title intent", async () => {
      const manager = SessionManager.inMemory(process.cwd(), {
        id: CONVERSATION_ID,
      });
      manager.appendSessionInfo("");
      const runtime = new FakeRuntime();
      const fixture = await openActor({
        sessionManager: manager,
        runtime,
      });

      await fixture.actor.startPrompt({
        runId: RUN_A,
        text: "do not replace the cleared title",
        origin: "browser",
      });

      expect(runtime.titleCalls).toEqual([]);
      expect(manager.getSessionName()).toBeUndefined();
      expect(runtime.session.promptCalls).toHaveLength(1);
      await fixture.actor.dispose();
    });

    it("fails an acknowledged run before Agent start when title persistence cannot be proved", async () => {
      const runtime = new FakeRuntime();
      const fixture = await openActor({ runtime });
      runtime.session.setSessionNameImplementation = () => {
        throw new Error("simulated title append failure");
      };

      await expect(fixture.actor.startPrompt({
        runId: RUN_A,
        text: "must have a durable title",
        origin: "browser",
      })).rejects.toThrow("not durably persisted");

      expect(runtime.session.promptCalls).toEqual([]);
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "session_event",
        runId: RUN_A,
        event: { type: "run_queued" },
      }));
      expect(
        aggregateReservedConversationEntries(fixture.manager.getEntries())
          .runSettlements,
      ).toEqual([]);
      expect(() => fixture.actor.startPrompt({
        runId: RUN_B,
        text: "cannot reuse a poisoned actor",
        origin: "browser",
      })).toThrow("not durably persisted");
      await fixture.actor.dispose();
    });
  });

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
          fixture.runtime.session.steeringMessages.push(text);
          options?.preflightResult?.(true);
          return;
        }
        emit()?.(nativeEvent({ type: "agent_start" }));
        runStarted.resolve();
        // The SDK run is streaming once agent_start fires.
        fixture.runtime.session.isStreaming = true;
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

    it("admits via SDK steer while a run is active and emits prompt_admitted", async () => {
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
          streamingBehavior: "steer",
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
      }]);

      finishRun.resolve();
      await running;
      await expect(admit).resolves.toEqual({ outcome: "admitted" });
      await fixture.actor.dispose();
    });

    it("rejects a busy admission while the run ticket is still queued", async () => {
      const fixture = await openActor();
      const promptStarted = deferred();
      const promptFinished = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          fixture.runtime.session.steeringMessages.push(text);
          options?.preflightResult?.(true);
          return;
        }
        promptStarted.resolve();
        await promptFinished.promise;
      };

      const completion = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "first prompt",
        origin: "browser",
      });
      // The run ticket is still phase=queued (its operations task has not
      // started): a steering admission must not escape into a second SDK run.
      await expect(fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "second prompt",
      })).rejects.toThrow("not ready to accept a message");
      expect(fixture.runtime.session.promptCalls).toHaveLength(1);
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      await promptStarted.promise;
      promptFinished.resolve();
      await expect(completion).resolves.toMatchObject({
        runId: RUN_A,
        outcome: "completed",
      });
      await fixture.actor.dispose();
    });

    it("clears un-delivered browser admissions when the run ends", async () => {
      const fixture = await openActor();
      const { runStarted, finishRun, running } = busyRun(fixture);
      await runStarted.promise;
      await fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_B,
        text: "follow up",
      });
      await vi.waitFor(() =>
        expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1)
      );

      // The run ends without the raw user delivery: the admission must not
      // leak into a later run.
      finishRun.resolve();
      await running;
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);
      await fixture.actor.dispose();
    });

    it("never lets a busy admission steal the initial raw delivery with the same text", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          fixture.runtime.session.steeringMessages.push(text);
          options?.preflightResult?.(true);
          return;
        }
        emit()?.(nativeEvent({ type: "agent_start" }));
        runStarted.resolve();
        fixture.runtime.session.isStreaming = true;
        await finishRun.promise;
        emit()?.(nativeEvent({ type: "agent_end" }));
      };
      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "shared text",
        origin: "browser",
      });
      await runStarted.promise;

      await fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "shared text",
      });
      const admittedRaw = fixture.runtime.takeSteeringCapture("shared text");
      await vi.waitFor(() =>
        expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1)
      );

      // The first raw end carries the same text as the busy admission: it
      // must settle the INITIAL prompt, never the admission.
      const firstRaw = {
        role: "user",
        content: [{ type: "text", text: "shared text" }],
      };
      fixture.manager.appendMessage(firstRaw as never);
      emit()?.(nativeEvent({ type: "message_end", message: firstRaw }));
      await Promise.resolve();
      expect(fixture.events).not.toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
      }));
      expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1);

      // The second raw end is the admission's: precise promptId delivery.
      fixture.manager.appendMessage(admittedRaw);
      emit()?.(nativeEvent({ type: "message_end", message: admittedRaw }));
      await Promise.resolve();
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
        promptId: PROMPT_ID,
      }));
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("uses queued object identity across extension replacement", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const { runStarted, finishRun, running } = busyRun(fixture);
      await runStarted.promise;

      const initialRaw = agentMessage({
        role: "user",
        content: [{ type: "text", text: "long task" }],
        timestamp: 1,
      });
      fixture.manager.appendMessage(initialRaw);
      emit()?.(nativeEvent({ type: "message_end", message: initialRaw }));

      const queuedMessage = agentMessage({
        role: "user",
        content: [{ type: "text", text: "follow up" }],
        timestamp: 2,
      });
      fixture.runtime.nextSteeringCapture = queuedMessage;
      await fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "follow up",
      });

      const extensionMessage = agentMessage({
        role: "user",
        content: [{ type: "text", text: "follow up" }],
        timestamp: 3,
      });
      fixture.manager.appendMessage(extensionMessage);
      emit()?.(nativeEvent({
        type: "message_end",
        message: extensionMessage,
      }));
      await Promise.resolve();
      expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1);
      expect(fixture.events).not.toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
        promptId: PROMPT_ID,
      }));

      Object.assign(queuedMessage, {
        content: [{ type: "text", text: "extension replacement" }],
      });
      fixture.manager.appendMessage(queuedMessage);
      emit()?.(nativeEvent({ type: "message_end", message: queuedMessage }));
      await Promise.resolve();
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
        promptId: PROMPT_ID,
      }));
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("settles a same-text explicit steer and browser admission in queue order", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          fixture.runtime.session.steeringMessages.push(text);
          options?.preflightResult?.(true);
          return;
        }
        emit()?.(nativeEvent({ type: "agent_start" }));
        runStarted.resolve();
        fixture.runtime.session.isStreaming = true;
        await finishRun.promise;
        emit()?.(nativeEvent({ type: "agent_end" }));
      };
      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "long task",
        origin: "browser",
      });
      await runStarted.promise;

      // Settle the initial prompt first (real SDK order), then queue an
      // explicit steer and a busy browser admission with the SAME text.
      const initialRaw = {
        role: "user",
        content: [{ type: "text", text: "long task" }],
      };
      fixture.manager.appendMessage(initialRaw as never);
      emit()?.(nativeEvent({ type: "message_end", message: initialRaw }));
      await Promise.resolve();

      const steerPromise = fixture.actor.steer(RUN_A, "shared text");
      const steerRaw = fixture.runtime.takeSteeringCapture("shared text");
      await fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "shared text",
      });
      const admittedRaw = fixture.runtime.takeSteeringCapture("shared text");

      // The first raw end resolves ONLY the explicit steer; no browser
      // prompt_delivered fires for it.
      fixture.manager.appendMessage(steerRaw);
      emit()?.(nativeEvent({ type: "message_end", message: steerRaw }));
      await expect(steerPromise).resolves.toBeUndefined();
      expect(fixture.events).not.toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
      }));
      expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1);

      // The second raw end delivers the browser promptId precisely.
      fixture.manager.appendMessage(admittedRaw);
      emit()?.(nativeEvent({ type: "message_end", message: admittedRaw }));
      await Promise.resolve();
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
        promptId: PROMPT_ID,
      }));
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("settles a same-text browser admission and explicit steer in queue order", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          fixture.runtime.session.steeringMessages.push(text);
          options?.preflightResult?.(true);
          return;
        }
        emit()?.(nativeEvent({ type: "agent_start" }));
        runStarted.resolve();
        fixture.runtime.session.isStreaming = true;
        await finishRun.promise;
        emit()?.(nativeEvent({ type: "agent_end" }));
      };
      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "long task",
        origin: "browser",
      });
      await runStarted.promise;
      const initialRaw = {
        role: "user",
        content: [{ type: "text", text: "long task" }],
      };
      fixture.manager.appendMessage(initialRaw as never);
      emit()?.(nativeEvent({ type: "message_end", message: initialRaw }));
      await Promise.resolve();

      // Reverse order: the browser admission queues before the explicit
      // steer with the same text.
      await fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "shared text",
      });
      const admittedRaw = fixture.runtime.takeSteeringCapture("shared text");
      const steerPromise = fixture.actor.steer(RUN_A, "shared text");
      const steerRaw = fixture.runtime.takeSteeringCapture("shared text");

      fixture.manager.appendMessage(admittedRaw);
      emit()?.(nativeEvent({ type: "message_end", message: admittedRaw }));
      await Promise.resolve();
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
        promptId: PROMPT_ID,
      }));
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);
      const steerSettledRace = Promise.race([
        steerPromise.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 150)
        ),
      ]);
      expect(await steerSettledRace).toBe(false);

      fixture.manager.appendMessage(steerRaw);
      emit()?.(nativeEvent({ type: "message_end", message: steerRaw }));
      await expect(steerPromise).resolves.toBeUndefined();

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("does not consume a guidance record for a mismatched raw user message", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          fixture.runtime.session.steeringMessages.push(text);
          options?.preflightResult?.(true);
          return;
        }
        emit()?.(nativeEvent({ type: "agent_start" }));
        runStarted.resolve();
        fixture.runtime.session.isStreaming = true;
        await finishRun.promise;
        emit()?.(nativeEvent({ type: "agent_end" }));
      };
      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "long task",
        origin: "browser",
      });
      await runStarted.promise;
      const initialRaw = {
        role: "user",
        content: [{ type: "text", text: "long task" }],
      };
      fixture.manager.appendMessage(initialRaw as never);
      emit()?.(nativeEvent({ type: "message_end", message: initialRaw }));
      await Promise.resolve();

      const steerPromise = fixture.actor.steer(RUN_A, "real guidance");
      const real = fixture.runtime.takeSteeringCapture("real guidance");
      // An unrelated raw user end (e.g. an extension user message) must not
      // consume the host guidance record.
      const mismatched = {
        role: "user",
        content: [{ type: "text", text: "unrelated extension text" }],
      };
      fixture.manager.appendMessage(mismatched as never);
      emit()?.(nativeEvent({ type: "message_end", message: mismatched }));
      await Promise.resolve();
      const steerSettledRace = Promise.race([
        steerPromise.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 150)
        ),
      ]);
      expect(await steerSettledRace).toBe(false);

      // The matching raw end settles it.
      fixture.manager.appendMessage(real);
      emit()?.(nativeEvent({ type: "message_end", message: real }));
      await expect(steerPromise).resolves.toBeUndefined();

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("rejects a slash-prefixed busy prompt before Pi's async command lookup", async () => {
      const fixture = await openActor();
      const { runStarted, finishRun, running } = busyRun(fixture);
      await runStarted.promise;
      fixture.runtime.session.promptImplementation = async (text, options) => {
        // Pi 0.85.1 awaits slash-command lookup before it reaches agent.steer.
        await Promise.resolve();
        fixture.runtime.session.steeringMessages.push(text);
        options?.preflightResult?.(true);
      };

      await expect(fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "/unknown-command",
      })).rejects.toThrow("Slash-prefixed messages cannot be queued");
      await Promise.resolve();
      await Promise.resolve();

      expect(fixture.runtime.session.promptCalls).toEqual([{
        text: "long task",
        streamingBehavior: undefined,
      }]);
      expect(fixture.runtime.session.steeringMessages).toEqual([]);
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("rejects a busy admission while the SDK run is not streaming yet", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      const steerCalls: string[] = [];
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          steerCalls.push(text);
          fixture.runtime.session.steeringMessages.push(text);
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
        text: "start task",
        origin: "browser",
      });
      await runStarted.promise;
      // The run ticket is running but the SDK has not started streaming: a
      // steer-mode prompt would start an unowned SDK run.
      expect(fixture.runtime.session.isStreaming).toBe(false);
      await expect(fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "pre-stream message",
      })).rejects.toThrow("not streaming");
      expect(steerCalls).toEqual([]);
      expect(fixture.runtime.session.promptCalls).toHaveLength(1);
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("admits a browser prompt when a predecessor queue entry drains before preflight", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      (fixture.runtime.session as { isStreaming: boolean }).isStreaming = true;
      let beforePreflight: (() => void) | undefined;
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          fixture.runtime.session.steeringMessages.push(text);
          beforePreflight?.();
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
        text: "start task",
        origin: "browser",
      });
      await runStarted.promise;
      const initialRaw = {
        role: "user",
        content: [{ type: "text", text: "start task" }],
      };
      fixture.manager.appendMessage(initialRaw as never);
      emit()?.(nativeEvent({ type: "message_end", message: initialRaw }));
      await Promise.resolve();

      // A predecessor queues first; its raw delivery drains the queue front
      // between the admission's own push and its preflight. The length-based
      // proof would falsely reject; own entry is the queue tail.
      const predecessor = fixture.actor.steer(RUN_A, "predecessor text");
      const predRaw = fixture.runtime.takeSteeringCapture("predecessor text");
      let drained = false;
      beforePreflight = () => {
        drained = true;
        fixture.runtime.session.steeringMessages.shift();
      };
      await expect(fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "own text",
      })).resolves.toEqual({ outcome: "admitted" });
      const ownRaw = fixture.runtime.takeSteeringCapture("own text");
      expect(drained).toBe(true);
      expect(fixture.runtime.session.steeringMessages).toEqual(["own text"]);
      expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1);

      // Raw ends arrive in SDK queue order: predecessor first, own second.
      fixture.manager.appendMessage(predRaw);
      emit()?.(nativeEvent({ type: "message_end", message: predRaw }));
      await expect(predecessor).resolves.toBeUndefined();
      fixture.manager.appendMessage(ownRaw);
      emit()?.(nativeEvent({ type: "message_end", message: ownRaw }));
      await Promise.resolve();
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
        promptId: PROMPT_ID,
      }));
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("rejects a busy admission before the SDK call when input extensions are registered", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          fixture.runtime.session.steeringMessages.push(text);
          options?.preflightResult?.(true);
          return;
        }
        emit()?.(nativeEvent({ type: "agent_start" }));
        runStarted.resolve();
        await finishRun.promise;
        emit()?.(nativeEvent({ type: "agent_end" }));
      };
      (fixture.runtime.session as { isStreaming: boolean }).isStreaming = true;
      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "start task",
        origin: "browser",
      });
      await runStarted.promise;

      (fixture.runtime.session as { hasInputExtensionHandlers?: boolean })
        .hasInputExtensionHandlers = true;
      await expect(fixture.actor.admitBrowserPrompt({
        promptId: PROMPT_ID,
        runId: RUN_A,
        text: "extension input",
      })).rejects.toThrow("input extensions");
      expect(fixture.runtime.session.promptCalls).toHaveLength(1);
      expect(fixture.actor.pendingPromptAdmissions()).toEqual([]);

      finishRun.resolve();
      await running;
      await fixture.actor.dispose();
    });

    it("does not burn a guidance record when the host wait callback is stale", async () => {
      const fixture = await openActor();
      const emit = () => fixture.runtime.session.eventListener;
      const runStarted = deferred();
      const finishRun = deferred();
      fixture.runtime.session.promptImplementation = async (text, options) => {
        if (options?.streamingBehavior === "steer") {
          fixture.runtime.session.steeringMessages.push(text);
          options?.preflightResult?.(true);
          return;
        }
        emit()?.(nativeEvent({ type: "agent_start" }));
        runStarted.resolve();
        fixture.runtime.session.isStreaming = true;
        await finishRun.promise;
        emit()?.(nativeEvent({ type: "agent_end" }));
      };
      const running = fixture.actor.startPrompt({
        runId: RUN_A,
        text: "start task",
        origin: "browser",
      });
      await runStarted.promise;
      const initialRaw = {
        role: "user",
        content: [{ type: "text", text: "start task" }],
      };
      fixture.manager.appendMessage(initialRaw as never);
      emit()?.(nativeEvent({ type: "message_end", message: initialRaw }));
      await Promise.resolve();

      // An explicit steer is accepted and remains unobserved.
      const guidance = fixture.actor.steer(RUN_A, "guidance text");
      const rawGuidance = fixture.runtime.takeSteeringCapture("guidance text");
      await Promise.resolve();

      const ownership = fixture.actor.currentRunOwnership(RUN_A);
      expect(ownership).toBeDefined();
      const ownershipValue = ownership!;
      const waitTarget = {
        conversationId: CONVERSATION_ID,
        runId: "dummy-target-run",
      };
      const restore = fixture.actor.enterWaiting(ownershipValue, waitTarget);

      // First wait: the host callback is stale (its waiter was already
      // removed by abort/settlement/message before withWaiting's restore
      // ran). It must NOT burn the record.
      const staleCalls: boolean[] = [];
      fixture.actor.onWaitingSteerAdmitted(
        ownershipValue,
        () => {
          staleCalls.push(true);
          return false;
        },
      );
      restore();

      // Second wait: registers before the raw guidance delivery; the SAME
      // record must wake it immediately.
      const restoreSecond = fixture.actor.enterWaiting(ownershipValue, waitTarget);
      let secondCalls = 0;
      fixture.actor.onWaitingSteerAdmitted(
        ownershipValue,
        () => {
          secondCalls++;
          return true;
        },
      );
      restoreSecond();
      expect(staleCalls).toEqual([true]);
      expect(secondCalls).toBe(1);

      // The raw delivery settles the steer precisely; no further wait wakes
      // on the already-claimed record.
      fixture.manager.appendMessage(rawGuidance);
      emit()?.(nativeEvent({ type: "message_end", message: rawGuidance }));
      await expect(guidance).resolves.toBeUndefined();
      const restoreThird = fixture.actor.enterWaiting(ownershipValue, waitTarget);
      let thirdCalls = 0;
      fixture.actor.onWaitingSteerAdmitted(
        ownershipValue,
        () => {
          thirdCalls++;
          return true;
        },
      );
      restoreThird();
      expect(thirdCalls).toBe(0);

      finishRun.resolve();
      await running;
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
      const rawMessage = fixture.runtime.takeSteeringCapture("follow up");
      await vi.waitFor(() => expect(fixture.actor.pendingPromptAdmissions()).toHaveLength(1));

      // SDK 投递：先结算 initial raw（真实 SDK顺序），再投递 admission。
      const initialRaw = {
        role: "user",
        content: [{ type: "text", text: "long task" }],
      };
      fixture.manager.appendMessage(initialRaw as never);
      emit()?.(nativeEvent({ type: "message_end", message: initialRaw }));
      fixture.manager.appendMessage(rawMessage);
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
          fixture.runtime.session.isStreaming = true;
          await finishRun.promise;
          emit()?.(nativeEvent({ type: "agent_end" }));
          return;
        }
        // admit 的调用：SDK 接受即入队返回
        fixture.runtime.session.steeringMessages.push(text);
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

  it("continues an unfinished LoopList inside the same run and settles once completed", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    expect(todoWrite).toBeDefined();

    fixture.runtime.session.promptImplementation = async () => {
      emit()?.(nativeEvent({ type: "agent_start" }));
      await todoWrite?.execute("todo-call-1", {
        items: [{ id: "verify", text: "Verify the implementation", status: "active" }],
      });
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "implementation drafted" }],
          stopReason: "stop",
        },
      }));
      emit()?.(nativeEvent({ type: "agent_end" }));
    };
    fixture.runtime.session.resumeImplementation = async (message, options) => {
      expect(message).toMatchObject({
        customType: "piweb.loop_list_continue.v2",
        display: false,
        details: {
          runId: RUN_A,
          continuation: 1,
          items: [{
            id: "verify",
            text: "Verify the implementation",
            status: "active",
          }],
        },
      });
      expect(options).toMatchObject({ triggerTurn: true });
      emit()?.(nativeEvent({ type: "agent_start" }));
      await todoWrite?.execute("todo-call-2", {
        items: [{ id: "verify", text: "Verify the implementation", status: "completed" }],
      });
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "verification complete" }],
          stopReason: "stop",
        },
      }));
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    const settlement = await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "implement and verify",
      origin: "browser",
    });

    expect(settlement).toMatchObject({
      runId: RUN_A,
      outcome: "completed",
      finalText: "implementation drafted\n\nverification complete",
    });
    expect(fixture.runtime.session.resumeCalls).toBe(1);
    expect(fixture.events.filter((event) => (
      event.type === "session_event"
      && (event.event.type === "run_started" || event.event.type === "run_finished")
    ))).toHaveLength(2);
    await fixture.actor.dispose();
  });

  it("continues a recovered run after its latest persisted LoopList continuation", async () => {
    const manager = SessionManager.inMemory(process.cwd(), { id: CONVERSATION_ID });
    const items = [{
      id: "recover",
      text: "Continue after restart",
      status: "active" as const,
    }];
    appendReservedCustomEntry(manager, createLoopListEntry({
      items,
      armed: true,
      updatedAt: "2026-07-19T10:00:00.000Z",
    }));
    const previousContinuation = createLoopListContinueEntry({
      runId: RUN_A,
      continuation: 1,
      items,
    });
    manager.appendCustomMessageEntry(
      previousContinuation.customType,
      previousContinuation.content,
      previousContinuation.display,
      previousContinuation.details,
    );
    const fixture = await openActor({ sessionManager: manager });
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    const resumedTypes: string[] = [];
    fixture.runtime.session.resumeImplementation = async (message) => {
      resumedTypes.push(message.customType);
      if (message.customType !== "piweb.loop_list_continue.v2") return;
      expect(message.details).toMatchObject({
        runId: RUN_A,
        continuation: 2,
        items,
      });
      await todoWrite?.execute("todo-complete", {
        items: [{ ...items[0], status: "completed" }],
      });
    };

    await expect(fixture.actor.resumeMessages({ runId: RUN_A })).resolves
      .toMatchObject({ outcome: "completed" });

    expect(resumedTypes).toEqual([
      "workbench.inbox_resume.v1",
      "piweb.loop_list_continue.v2",
    ]);
    await fixture.actor.dispose();
  });

  it("settles without hidden continuation when the LoopList is completed", async () => {
    const fixture = await openActor();
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    expect(todoWrite).toBeDefined();
    fixture.runtime.session.promptImplementation = async () => {
      await todoWrite?.execute("todo-call", {
        items: [{ id: "done", text: "Already done", status: "completed" }],
      });
    };

    await expect(fixture.actor.startPrompt({
      runId: RUN_A,
      text: "record completion",
      origin: "browser",
    })).resolves.toMatchObject({ outcome: "completed" });

    expect(fixture.runtime.session.resumeCalls).toBe(0);
    await fixture.actor.dispose();
  });

  it("pauses an unfinished LoopList after eight same-run continuations", async () => {
    const fixture = await openActor();
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    fixture.runtime.session.promptImplementation = async () => {
      await todoWrite?.execute("todo-call", {
        items: [{ id: "blocked", text: "Still blocked", status: "active" }],
      });
    };
    fixture.runtime.session.resumeImplementation = async () => undefined;

    await expect(fixture.actor.startPrompt({
      runId: RUN_A,
      text: "keep trying",
      origin: "browser",
    })).resolves.toMatchObject({ outcome: "completed" });

    expect(fixture.runtime.session.resumeCalls).toBe(8);
    expect(fixture.actor.getLoopList()).toEqual({
      items: [{ id: "blocked", text: "Still blocked", status: "active" }],
      armed: false,
    });
    await fixture.actor.dispose();
  });

  it("restores the latest LoopList without auto-starting after process restart", async () => {
    const manager = SessionManager.inMemory(process.cwd(), { id: CONVERSATION_ID });
    appendReservedCustomEntry(manager, createLoopListEntry({
      items: [{ id: "restore", text: "Resume explicitly", status: "active" }],
      armed: true,
      updatedAt: "2026-07-19T10:00:00.000Z",
    }));

    const fixture = await openActor({ sessionManager: manager });

    expect(fixture.actor.getLoopList()).toEqual({
      items: [{ id: "restore", text: "Resume explicitly", status: "active" }],
      armed: true,
    });
    expect(fixture.runtime.session.promptCalls).toHaveLength(0);
    expect(fixture.actor.getActivity()).toEqual({ kind: "idle" });
    await fixture.actor.dispose();
  });

  it("restores and updates the two LoopList wall-clock timers", async () => {
    const manager = SessionManager.inMemory(process.cwd(), { id: CONVERSATION_ID });
    appendReservedCustomEntry(manager, createLoopListEntry({
      items: [
        { id: "implement", text: "Implement", status: "pending" },
        { id: "verify", text: "Verify", status: "pending" },
      ],
      armed: true,
      updatedAt: "2026-07-19T10:00:00.000Z",
    }));
    appendReservedCustomEntry(manager, createLoopListEntry({
      items: [
        { id: "implement", text: "Implement", status: "active" },
        { id: "verify", text: "Verify", status: "pending" },
      ],
      armed: true,
      updatedAt: "2026-07-19T10:01:00.000Z",
    }));
    appendReservedCustomEntry(manager, createLoopListEntry({
      items: [
        { id: "verify", text: "Verify thoroughly", status: "active" },
        { id: "implement", text: "Implement carefully", status: "completed" },
      ],
      armed: true,
      updatedAt: "2026-07-19T10:05:00.000Z",
    }));
    let now = new Date("2026-07-19T10:12:59.999Z");
    const fixture = await openActor({
      sessionManager: manager,
      now: () => now,
    });
    const elapsed = () =>
      fixture.runtime.createOptions?.getLoopListElapsedMinutes?.();
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );

    expect(elapsed()).toEqual({ activeMin: 7, listMin: 12 });

    now = new Date("2026-07-19T10:14:00.000Z");
    await todoWrite?.execute("switch-active", {
      items: [
        { id: "implement", text: "Implementation done", status: "active" },
        { id: "verify", text: "Verification done", status: "completed" },
      ],
    });
    expect(elapsed()).toEqual({ activeMin: 0, listMin: 14 });

    now = new Date("2026-07-19T10:15:00.000Z");
    await todoWrite?.execute("replace-plan", {
      items: [{ id: "ship", text: "Ship", status: "active" }],
    });
    expect(elapsed()).toEqual({ activeMin: 0, listMin: 0 });

    now = new Date("2026-07-19T09:00:00.000Z");
    expect(elapsed()).toEqual({ activeMin: 0, listMin: 0 });
    await fixture.actor.dispose();
  });

  it("restores legacy LoopList items as pending or completed without inventing active work", async () => {
    const manager = SessionManager.inMemory(process.cwd(), { id: CONVERSATION_ID });
    manager.appendCustomEntry(LEGACY_LOOP_LIST_CUSTOM_TYPE, {
      items: [
        { id: "legacy-pending", text: "Pending legacy work", checked: false },
        { id: "legacy-done", text: "Completed legacy work", checked: true },
      ],
      armed: true,
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    const entriesBeforeOpen = structuredClone(manager.getEntries());

    const fixture = await openActor({ sessionManager: manager });

    expect(fixture.actor.getLoopList()).toEqual({
      items: [
        { id: "legacy-pending", text: "Pending legacy work", status: "pending" },
        { id: "legacy-done", text: "Completed legacy work", status: "completed" },
      ],
      armed: true,
    });
    expect(fixture.actor.getLoopList().items).not.toContainEqual(
      expect.objectContaining({ status: "active" }),
    );
    expect(manager.getEntries()).toEqual(entriesBeforeOpen);
    await fixture.actor.dispose();
  });

  it("restores LoopList state from the active branch instead of a later inactive branch", async () => {
    const manager = SessionManager.inMemory(process.cwd(), { id: CONVERSATION_ID });
    const rootId = manager.appendMessage({
      role: "user",
      content: "root",
      timestamp: 1,
    });
    const activeLoopListId = appendReservedCustomEntry(
      manager,
      createLoopListEntry({
        items: [{ id: "active", text: "Active branch work", status: "active" }],
        armed: true,
        updatedAt: "2026-07-19T10:00:00.000Z",
      }),
    );
    manager.branch(rootId);
    appendReservedCustomEntry(manager, createLoopListEntry({
      items: [{ id: "inactive", text: "Inactive branch work", status: "pending" }],
      armed: true,
      updatedAt: "2026-07-19T10:01:00.000Z",
    }));
    manager.branch(activeLoopListId);
    manager.appendMessage({
      role: "user",
      content: "active leaf",
      timestamp: 2,
    });

    expect(aggregateReservedConversationEntries(manager.getEntries()).loopList)
      .toMatchObject({ items: [{ id: "inactive" }] });
    const fixture = await openActor({
      sessionManager: manager,
      now: () => new Date("2026-07-19T10:07:00.000Z"),
    });

    expect(fixture.actor.getLoopList()).toEqual({
      items: [{ id: "active", text: "Active branch work", status: "active" }],
      armed: true,
    });
    expect(fixture.runtime.createOptions?.getLoopListElapsedMinutes?.())
      .toEqual({ activeMin: 7, listMin: 7 });
    await fixture.actor.dispose();
  });

  it("re-arms a paused unfinished LoopList on a later browser prompt", async () => {
    const fixture = await openActor();
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    const todoPause = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_pause",
    );
    let promptNumber = 0;
    fixture.runtime.session.promptImplementation = async () => {
      promptNumber += 1;
      if (promptNumber === 1) {
        await todoWrite?.execute("todo-write", {
          items: [{ id: "later", text: "Continue later", status: "active" }],
        });
        await todoPause?.execute("todo-pause", {});
        return;
      }
      expect(fixture.actor.getLoopList().armed).toBe(true);
      await todoWrite?.execute("todo-complete", {
        items: [{ id: "later", text: "Continue later", status: "completed" }],
      });
    };

    await fixture.actor.startPrompt({ runId: RUN_A, text: "pause", origin: "browser" });
    expect(fixture.actor.getLoopList().armed).toBe(false);
    await fixture.actor.startPrompt({ runId: RUN_B, text: "resume", origin: "browser" });
    expect(fixture.actor.getLoopList()).toEqual({
      items: [{ id: "later", text: "Continue later", status: "completed" }],
      armed: false,
    });
    await fixture.actor.dispose();
  });

  it("durably pauses the LoopList before aborting the SDK run", async () => {
    const fixture = await openActor();
    const started = deferred();
    const finished = deferred();
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    fixture.runtime.session.promptImplementation = async () => {
      await todoWrite?.execute("todo-call", {
        items: [{ id: "abort", text: "Preserve this", status: "active" }],
      });
      started.resolve();
      await finished.promise;
    };
    fixture.runtime.session.abort = async () => {
      expect(fixture.actor.getLoopList().armed).toBe(false);
      fixture.runtime.session.abortCalls += 1;
      finished.resolve();
    };

    const completion = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "start",
      origin: "browser",
    });
    await started.promise;
    await fixture.actor.abort(RUN_A);

    await expect(completion).resolves.toMatchObject({ outcome: "aborted" });
    expect(aggregateReservedConversationEntries(fixture.manager.getBranch()).loopList)
      .toMatchObject({ armed: false });
    await fixture.actor.dispose();
  });

  it("still aborts and settles when persisting the LoopList pause fails", async () => {
    const fixture = await openActor();
    const started = deferred();
    const finished = deferred();
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    fixture.runtime.session.promptImplementation = async () => {
      await todoWrite?.execute("todo-call", {
        items: [{ id: "abort", text: "Preserve this", status: "active" }],
      });
      started.resolve();
      await finished.promise;
    };
    fixture.runtime.session.abort = async () => {
      fixture.runtime.session.abortCalls += 1;
      finished.resolve();
    };

    const completion = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "start",
      origin: "browser",
    });
    await started.promise;
    const appendCustomEntry = fixture.manager.appendCustomEntry.bind(
      fixture.manager,
    );
    vi.spyOn(fixture.manager, "appendCustomEntry").mockImplementation(
      (customType, data) => {
        if (customType === LOOP_LIST_CUSTOM_TYPE) {
          throw new Error("LoopList pause persistence failed");
        }
        return appendCustomEntry(customType, data);
      },
    );

    await fixture.actor.abort(RUN_A);

    await expect(completion).resolves.toMatchObject({ outcome: "aborted" });
    expect(fixture.runtime.session.abortCalls).toBe(1);
    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: "error",
      runId: RUN_A,
      message: "LoopList pause persistence failed",
    }));
    await fixture.actor.dispose();
  });

  it("pauses unfinished LoopList state when the model turn fails", async () => {
    const fixture = await openActor();
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    fixture.runtime.session.promptImplementation = async () => {
      await todoWrite?.execute("todo-call", {
        items: [{ id: "recover", text: "Recover later", status: "active" }],
      });
      throw new Error("model interrupted");
    };

    await expect(fixture.actor.startPrompt({
      runId: RUN_A,
      text: "start",
      origin: "browser",
    })).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.actor.getLoopList()).toEqual({
      items: [{ id: "recover", text: "Recover later", status: "active" }],
      armed: false,
    });
    await fixture.actor.dispose();
  });

  it("inherits the frozen role tier while preserving explicit overrides across capability drift", async () => {
    const inheritedProfile = profile();
    inheritedProfile.role.defaultServiceTier = "priority";
    const inheritedRuntime = new FakeRuntime();
    Object.assign(inheritedRuntime.session.model!, {
      api: "openai-codex-responses",
    });
    const inherited = await openActor({
      profile: inheritedProfile,
      runtime: inheritedRuntime,
    });
    expect(inherited.actor.getServiceTier()).toBe("priority");
    await inherited.actor.dispose();

    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    appendReservedCustomEntry(manager, createServiceTierSelectionEntry({
      tier: null,
      updatedAt: "2026-07-19T10:00:00.000Z",
    }));
    const clearedRuntime = new FakeRuntime();
    const cleared = await openActor({
      profile: inheritedProfile,
      sessionManager: manager,
      runtime: clearedRuntime,
    });
    expect(cleared.actor.getServiceTier()).toBeNull();
    await cleared.actor.dispose();

    const driftedManager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    appendReservedCustomEntry(
      driftedManager,
      createServiceTierSelectionEntry({
        tier: "priority",
        updatedAt: "2026-07-19T10:00:00.000Z",
      }),
    );
    const drifted = await openActor({
      sessionManager: driftedManager,
      runtime: new FakeRuntime(),
    });
    expect(drifted.actor.getServiceTier()).toBe("priority");
    await drifted.actor.dispose();
  });

  it("restores, clears, and durably updates the live service tier selection", async () => {
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    appendReservedCustomEntry(manager, createServiceTierSelectionEntry({
      tier: "priority",
      updatedAt: "2026-07-19T10:00:00.000Z",
    }));
    const runtime = new FakeRuntime();
    Object.assign(runtime.session.model!, {
      api: "openai-codex-responses",
    });
    const fixture = await openActor({ sessionManager: manager, runtime });

    expect(fixture.actor.getServiceTier()).toBe("priority");
    expect(runtime.createOptions?.getServiceTier?.()).toBe("priority");

    fixture.actor.setServiceTier(null);
    fixture.actor.setServiceTier("priority");
    expect(runtime.createOptions?.getServiceTier?.()).toBe("priority");
    expect(aggregateReservedConversationEntries(
      manager.getEntries(),
    ).serviceTier?.tier).toBe("priority");

    vi.spyOn(manager, "appendCustomEntry").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => fixture.actor.setServiceTier(null)).toThrow("disk full");
    expect(fixture.actor.getServiceTier()).toBe("priority");
    await fixture.actor.dispose();
  });

  it("switches to the target role default tier and keeps a same-snapshot override", async () => {
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    appendReservedCustomEntry(manager, createConversationMetaEntry(profile()));
    const fixture = await openActor({ sessionManager: manager });
    Object.assign(fixture.runtime.session.model!, {
      api: "openai-codex-responses",
    });
    const nextRole = {
      ...fixture.actor.profile.role,
      revision: fixture.actor.profile.role.revision + 1,
      model: { provider: "test", id: "other-model" },
      defaultServiceTier: "priority" as const,
    };

    await fixture.actor.switchRole(nextRole, {});
    expect(fixture.actor.getServiceTier()).toBe("priority");
    expect(aggregateReservedConversationEntries(
      fixture.manager.getEntries(),
    ).serviceTier?.tier).toBe("priority");

    fixture.actor.setServiceTier(null);
    const disposeCalls = fixture.runtime.disposeCalls;
    await fixture.actor.switchRole({ ...fixture.actor.profile.role }, {});
    expect(fixture.actor.getServiceTier()).toBeNull();
    expect(fixture.runtime.disposeCalls).toBe(disposeCalls);
    await fixture.actor.dispose();
  });

  it("restores branch-owned thinking and persists later changes", async () => {
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    appendReservedCustomEntry(manager, createConversationMetaEntry(profile()));
    manager.appendThinkingLevelChange("high");

    const fixture = await openActor({ sessionManager: manager });
    expect(fixture.runtime.createOptions?.thinkingLevel).toBe("high");
    expect(fixture.actor.session.thinkingLevel).toBe("high");

    await expect(fixture.actor.setThinkingLevel("medium")).resolves.toEqual({
      settingsFailures: [],
    });
    expect(fixture.actor.session.thinkingLevel).toBe("medium");
    expect(fixture.manager.getBranch().at(-1)).toMatchObject({
      type: "thinking_level_change",
      thinkingLevel: "medium",
    });
    await fixture.actor.dispose();
  });

  it("persists and triggers a per-conversation compaction threshold", async () => {
    const fixture = await openActor();

    expect(fixture.actor.getCompactionThresholdPercent()).toBe(70);
    expect(
      fixture.runtime.createOptions?.getCompactionThresholdPercent?.(),
    ).toBe(70);

    fixture.actor.setCompactionThresholdPercent(55);
    expect(
      fixture.runtime.createOptions?.getCompactionThresholdPercent?.(),
    ).toBe(55);
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

  it("lets the Agent request below-threshold compaction at a safe tool-turn boundary", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;
    const requestCompaction = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "request_context_compaction",
    );
    expect(requestCompaction).toBeDefined();

    fixture.runtime.session.promptImplementation = async () => {
      emit()?.(nativeEvent({ type: "agent_start" }));
      const result = await requestCompaction?.execute("compact-call", {});
      expect(result).toMatchObject({ details: { requested: true } });
      expect(fixture.runtime.session.compactCalls).toBe(0);

      fixture.runtime.session.contextPercent = 40;
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
      fixture.runtime.session.contextPercent = 20;
      emit()?.(nativeEvent({ type: "agent_start" }));
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    const settlement = await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "compact before continuing a long task",
      origin: "browser",
    });

    expect(settlement.outcome).toBe("completed");
    expect(fixture.runtime.session.compactCalls).toBe(1);
    expect(fixture.runtime.session.resumeCalls).toBe(1);
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

  it("stops a browser run at the next turn boundary without LoopList continuation", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;
    const runStarted = deferred();
    const releaseRun = deferred();
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    expect(todoWrite).toBeDefined();
    fixture.runtime.session.promptImplementation = async () => {
      emit()?.(nativeEvent({ type: "agent_start" }));
      await todoWrite?.execute("todo-call", {
        items: [{ id: "reload", text: "Continue after reload", status: "active" }],
      });
      runStarted.resolve();
      await releaseRun.promise;
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "reload at a safe boundary",
      origin: "browser",
    });
    await runStarted.promise;

    let reloadReady = false;
    const stopping = fixture.actor.stopForReload(false).then(() => {
      reloadReady = true;
    });
    await Promise.resolve();
    expect(reloadReady).toBe(false);

    const turnBoundaryCheck = fixture.runtime.createOptions?.turnBoundaryCheck;
    expect(turnBoundaryCheck).toBeDefined();
    expect(turnBoundaryCheck?.({
      contextUsage: fixture.runtime.session.getContextUsage(),
      hasToolResults: false,
    })).toBe(true);

    releaseRun.resolve();
    await expect(stopping).resolves.toBeUndefined();
    await expect(running).resolves.toMatchObject({
      runId: RUN_A,
      outcome: "aborted",
    });
    expect(fixture.runtime.session.resumeCalls).toBe(0);
    expect(fixture.events.some((event) => (
      event.type === "session_event" && event.event.type === "run_finished"
    ))).toBe(false);
    expect(fixture.actor.getLoopList()).toEqual({
      items: [{ id: "reload", text: "Continue after reload", status: "active" }],
      armed: false,
    });
    expect(aggregateReservedConversationEntries(fixture.manager.getBranch())
      .runSettlements).toEqual([
        expect.objectContaining({ runId: RUN_A, outcome: "aborted" }),
      ]);
    expect(fixture.manager.getBranch().some((entry) => (
      entry.type === "custom"
      && entry.customType === "piweb.loop_list_continue.v2"
    ))).toBe(false);
    await fixture.actor.dispose();
  });

  it("stops at a safe boundary without settling when settlement is preserved", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;
    const runStarted = deferred();
    const releaseRun = deferred();
    fixture.runtime.session.promptImplementation = async () => {
      emit()?.(nativeEvent({ type: "agent_start" }));
      runStarted.resolve();
      await releaseRun.promise;
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "preserve the unfinished run",
      origin: "inbox",
    });
    await runStarted.promise;

    const stopping = fixture.actor.stopForReload(true);
    const turnBoundaryCheck = fixture.runtime.createOptions?.turnBoundaryCheck;
    expect(turnBoundaryCheck?.({
      contextUsage: fixture.runtime.session.getContextUsage(),
      hasToolResults: false,
    })).toBe(true);
    releaseRun.resolve();

    await expect(stopping).resolves.toBeUndefined();
    expect(fixture.actor.getActivity()).toEqual({
      kind: "running",
      runId: RUN_A,
    });
    expect(aggregateReservedConversationEntries(fixture.manager.getBranch())
      .runSettlements).toEqual([]);
    expect(fixture.runtime.session.resumeCalls).toBe(0);
    // The preserved completion belongs to the process-replacement boundary;
    // the old process must not try to dispose it as a normal run.
    void running;
  });

  it("starts one hidden reload continuation for a duplicate request", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;
    const finishRun = deferred();
    let received: {
      customType: string;
      display: boolean;
      details: unknown;
      triggerTurn: boolean;
    } | undefined;
    fixture.runtime.session.resumeImplementation = async (message, options) => {
      received = {
        customType: message.customType,
        display: message.display,
        details: message.details,
        triggerTurn: options?.triggerTurn === true,
      };
      emit()?.(nativeEvent({ type: "agent_start" }));
      await finishRun.promise;
      emit()?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "reload resumed" }],
          stopReason: "stop",
        },
      }));
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    const input = {
      requestId: RELOAD_REQUEST_ID,
      continuationRunId: RUN_B,
    };
    const continuation = fixture.actor.startReloadContinuation(input);
    expect(fixture.actor.startReloadContinuation(input)).toBe(continuation);
    expect(() => fixture.actor.startReloadContinuation({
      ...input,
      requestId: OTHER_RELOAD_REQUEST_ID,
    })).toThrow("conflicts with its active run");
    finishRun.resolve();
    await expect(continuation).resolves.toMatchObject({
      runId: RUN_B,
      outcome: "completed",
      finalText: "reload resumed",
    });
    expect(received).toEqual({
      customType: "workbench.reload_resume.v1",
      display: false,
      details: {
        ...input,
        adoptedRunId: RUN_B,
      },
      triggerTurn: true,
    });
    expect(fixture.runtime.session.resumeCalls).toBe(1);
    expect(fixture.runtime.session.promptCalls).toEqual([]);
    await fixture.actor.dispose();
  });

  it("uses a generic trigger when recovering a persisted reload marker", async () => {
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    manager.appendCustomMessageEntry(
      "workbench.reload_resume.v1",
      "original reload continuation",
      false,
      {
        requestId: RELOAD_REQUEST_ID,
        continuationRunId: RUN_B,
        adoptedRunId: RUN_B,
      },
    );
    const fixture = await openActor({ sessionManager: manager });
    const emit = () => fixture.runtime.session.eventListener;
    let receivedType: string | undefined;
    fixture.runtime.session.resumeImplementation = async (message) => {
      receivedType = message.customType;
      emit()?.(nativeEvent({ type: "agent_start" }));
      emit()?.(nativeEvent({ type: "agent_end" }));
    };

    expect(() => fixture.actor.startReloadContinuation({
      requestId: OTHER_RELOAD_REQUEST_ID,
      continuationRunId: RUN_B,
    })).toThrow("conflicts with its marker");
    expect(fixture.runtime.session.resumeCalls).toBe(0);

    await fixture.actor.startReloadContinuation({
      requestId: RELOAD_REQUEST_ID,
      continuationRunId: RUN_B,
    });

    expect(receivedType).toBe("workbench.reload_recovery.v1");
    expect(fixture.manager.getBranch().filter((entry) => (
      entry.type === "custom_message"
      && entry.customType === "workbench.reload_resume.v1"
    ))).toHaveLength(1);
    await fixture.actor.dispose();
  });

  it("ignores an uncorrelated legacy marker for a new exact continuation", async () => {
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    manager.appendCustomMessageEntry(
      "workbench.reload_resume.v1",
      "legacy reload continuation",
      false,
    );
    const fixture = await openActor({ sessionManager: manager });

    expect(fixture.actor.reloadContinuationAdoptedRunId({
      requestId: RELOAD_REQUEST_ID,
      continuationRunId: RUN_B,
    })).toBeUndefined();
    expect(fixture.runtime.session.resumeCalls).toBe(0);
    await fixture.actor.dispose();
  });

  it.each([
    [
      "legacy marker without adopted run identity",
      [{
        requestId: RELOAD_REQUEST_ID,
        continuationRunId: RUN_B,
      }],
      "invalid adopted identity",
    ],
    [
      "markers with conflicting adopted run identities",
      [
        {
          requestId: RELOAD_REQUEST_ID,
          continuationRunId: RUN_B,
          adoptedRunId: RUN_A,
        },
        {
          requestId: RELOAD_REQUEST_ID,
          continuationRunId: RUN_B,
          adoptedRunId: "39af7567-b6b6-41cf-af40-bf87385313ea",
        },
      ],
      "conflicting adopted identities",
    ],
  ])("rejects %s", async (_name, details, expectedError) => {
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    for (const markerDetails of details) {
      manager.appendCustomMessageEntry(
        "workbench.reload_resume.v1",
        "reload continuation",
        false,
        markerDetails,
      );
    }
    const fixture = await openActor({ sessionManager: manager });

    expect(() => fixture.actor.reloadContinuationAdoptedRunId({
      requestId: RELOAD_REQUEST_ID,
      continuationRunId: RUN_B,
    })).toThrow(expectedError);
    expect(fixture.runtime.session.resumeCalls).toBe(0);
    await fixture.actor.dispose();
  });

  it("absorbs a duplicate reload continuation into the exact inbox run", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;
    const runStarted = deferred();
    const allowReloadDelivery = deferred();
    const finishRun = deferred();
    const deliveries: Array<{
      customType: string;
      details: unknown;
      deliverAs: string | undefined;
    }> = [];
    fixture.runtime.session.promptImplementation = async () => {
      fixture.runtime.session.isStreaming = true;
      emit()?.(nativeEvent({ type: "agent_start" }));
      runStarted.resolve();
      await finishRun.promise;
      emit()?.(nativeEvent({ type: "agent_end" }));
      fixture.runtime.session.isStreaming = false;
    };
    fixture.runtime.session.resumeImplementation = async (message, options) => {
      deliveries.push({
        customType: message.customType,
        details: message.details,
        deliverAs: options?.deliverAs,
      });
      await allowReloadDelivery.promise;
      fixture.manager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
    };

    const running = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "process durable inbox work",
      origin: "inbox",
    });
    await runStarted.promise;
    const input = {
      requestId: RELOAD_REQUEST_ID,
      continuationRunId: RUN_B,
      runId: RUN_A,
    };
    const first = fixture.actor.queueReloadContinuation(input);
    const duplicate = fixture.actor.queueReloadContinuation(input);
    await expect(fixture.actor.queueReloadContinuation({
      ...input,
      requestId: OTHER_RELOAD_REQUEST_ID,
    })).rejects.toThrow("conflicts with its delivery");
    allowReloadDelivery.resolve();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(fixture.actor.queueReloadContinuation({
      ...input,
      runId: "a88ee8be-5e6b-44ad-9e8a-06bff140ec1f",
    })).rejects.toThrow("exact active inbox run");

    expect(deliveries).toEqual([{
      customType: "workbench.reload_resume.v1",
      details: {
        requestId: RELOAD_REQUEST_ID,
        continuationRunId: RUN_B,
        adoptedRunId: RUN_A,
      },
      deliverAs: "steer",
    }]);
    finishRun.resolve();
    await running;
    const continuation = {
      requestId: RELOAD_REQUEST_ID,
      continuationRunId: RUN_B,
    };
    expect(fixture.actor.reloadContinuationAdoptedRunId(continuation))
      .toBe(RUN_A);
    expect(() => fixture.actor.startReloadContinuation(continuation))
      .toThrow("different adopted run");
    expect(fixture.runtime.session.resumeCalls).toBe(1);
    await fixture.actor.dispose();
  });

  it("projects the first busy user message during a hidden reload continuation", async () => {
    const fixture = await openActor();
    const emit = () => fixture.runtime.session.eventListener;
    const runStarted = deferred();
    const finishRun = deferred();
    fixture.runtime.session.promptImplementation = async (text, options) => {
      if (options?.streamingBehavior === "steer") {
        fixture.runtime.session.steeringMessages.push(text);
        options.preflightResult?.(true);
      }
    };
    fixture.runtime.session.resumeImplementation = async () => {
      fixture.runtime.session.isStreaming = true;
      emit()?.(nativeEvent({ type: "agent_start" }));
      runStarted.resolve();
      await finishRun.promise;
      emit()?.(nativeEvent({ type: "agent_end" }));
      fixture.runtime.session.isStreaming = false;
    };

    const promptId = "prompt-after-reload";
    const running = fixture.actor.startReloadContinuation({
      requestId: RELOAD_REQUEST_ID,
      continuationRunId: RUN_B,
    });
    await runStarted.promise;
    await fixture.actor.admitBrowserPrompt({
      promptId,
      runId: RUN_A,
      text: "guidance after reload",
    });
    const rawMessage = fixture.runtime.takeSteeringCapture(
      "guidance after reload",
    );
    fixture.manager.appendMessage(rawMessage);
    emit()?.(nativeEvent({ type: "message_start", message: rawMessage }));
    emit()?.(nativeEvent({ type: "message_end", message: rawMessage }));

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "session_event",
        runId: RUN_B,
        event: expect.objectContaining({
          type: "user_message",
          text: "guidance after reload",
        }),
      }));
      expect(fixture.events).toContainEqual(expect.objectContaining({
        type: "prompt_delivered",
        promptId,
        runId: RUN_B,
      }));
    });

    finishRun.resolve();
    await running;
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

  it("publishes queued synchronously for a named conversation and permits only one active run", async () => {
    const manager = SessionManager.inMemory(process.cwd(), {
      id: CONVERSATION_ID,
    });
    manager.appendSessionInfo("already named");
    const fixture = await openActor({ sessionManager: manager });
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
    const originalSteer = fixture.runtime.session.steer;
    const sdkError = new Error("SDK steer rejected");
    fixture.runtime.session.steer = () => {
      throw sdkError;
    };
    await expect(fixture.actor.steer(RUN_A, "SDK rejection"))
      .rejects.toBe(sdkError);
    fixture.runtime.session.steer = originalSteer;
    expect(fixture.runtime.session.isStreaming).toBe(false);
    // The SDK queues the EXPANDED steer text; the raw delivery carries it.
    fixture.runtime.session.steerExpandedText = "template-expanded guidance";
    const guidance = fixture.actor.steer(RUN_A, "  change direction  ");
    const transformedGuidance = fixture.runtime.takeSteeringCapture(
      "template-expanded guidance",
    );
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
    await expect(undelivered).rejects.toThrow(
      "Run ended before queued guidance was delivered",
    );
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
    // The SDK queues the EXPANDED text (which is what the raw end carries),
    // so the record matches and the delivery fails on the persistence proof.
    fixture.runtime.session.steerExpandedText = "transformed but not persisted";
    const guidance = fixture.actor.steer(RUN_A, "guidance without append");
    const rawGuidance = fixture.runtime.takeSteeringCapture(
      "transformed but not persisted",
    );
    // Let the SDK acceptance microtask register the observation record
    // before the raw delivery arrives (real SDK order: drain after accept).
    await Promise.resolve();
    fixture.runtime.session.eventListener?.({
      type: "message_end",
      message: rawGuidance,
    } as AgentSessionEvent);
    await expect(guidance).rejects.toThrow(/did not durably append/i);
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
      triggerTurn: true,
    });
    promptFinished.resolve();
    await completion;
    await fixture.actor.dispose();
  });

  it("keeps a queued peer message out of an unowned extension turn", async () => {
    const runtime = new FakeRuntime();
    const titleResult = deferred<AssistantMessage>();
    runtime.titleImplementation = async () => titleResult.promise;
    const fixture = await openActor({ runtime });
    // Model the real SDK abort window: abort() requests cancellation, but
    // isStreaming remains true until the rogue physical run becomes idle.
    runtime.session.abort = async () => {
      runtime.session.abortCalls++;
    };
    const ownedStarted = deferred();
    const ownedFinished = deferred();
    runtime.session.promptImplementation = async () => {
      runtime.session.isStreaming = true;
      runtime.session.eventListener?.(nativeEvent({ type: "agent_start" }));
      ownedStarted.resolve();
      await ownedFinished.promise;
      runtime.session.eventListener?.(nativeEvent({
        type: "agent_end",
        messages: [],
      }));
      runtime.session.isStreaming = false;
    };

    const queued: Array<{
      content: unknown;
      deliverAs: unknown;
      triggerTurn: unknown;
    }> = [];
    runtime.session.resumeImplementation = async (message, options) => {
      queued.push({
        content: message.content,
        deliverAs: options?.deliverAs,
        triggerTurn: options?.triggerTurn,
      });
    };

    const completion = fixture.actor.startPrompt({
      runId: RUN_A,
      text: "name this conversation before starting",
      origin: "browser",
    });
    await vi.waitFor(() => expect(runtime.titleCalls).toHaveLength(1));
    expect(fixture.actor.getActivity()).toEqual({
      kind: "queued",
      runId: RUN_A,
    });
    const delivery = fixture.actor.steerCustomMessage(
      RUN_A,
      {
        customType: "piweb.conversation_message.v1",
        content: "Keep this for the owned run",
        display: true,
        details: {},
      } as ConversationMessageEntry,
    );

    runtime.session.isStreaming = true;
    runtime.session.eventListener?.(nativeEvent({ type: "agent_start" }));
    await vi.waitFor(() => expect(runtime.session.abortCalls).toBe(1));
    expect(runtime.session.resumeCalls).toBe(0);

    // Even while the rogue run is still physically streaming, another
    // delivery must remain attached to the queued workbench ticket.
    const lateDelivery = fixture.actor.steerCustomMessage(
      RUN_A,
      {
        customType: "piweb.conversation_message.v1",
        content: "Also keep this for the owned run",
        display: true,
        details: {},
      } as ConversationMessageEntry,
    );
    await Promise.resolve();
    expect(runtime.session.resumeCalls).toBe(0);
    runtime.session.isStreaming = false;

    titleResult.resolve(automaticTitleMessage("Owned conversation"));
    await ownedStarted.promise;
    await expect(Promise.all([delivery, lateDelivery])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(runtime.session.resumeCalls).toBe(2);
    expect(queued).toEqual([
      {
        content: "Keep this for the owned run",
        deliverAs: "steer",
        triggerTurn: true,
      },
      {
        content: "Also keep this for the owned run",
        deliverAs: "steer",
        triggerTurn: true,
      },
    ]);

    ownedFinished.resolve();
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
      origin: "browser",
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

  it("persists exact final text before publishing terminal", async () => {
    const order: string[] = [];
    const fixture = await openActor({
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
      "persist:exact final",
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
        hasPersistedConversationNameIntent: async () => false,
        refreshConversations: async () => [],
      },
      sessionManager: manager,
      conversationLease: lease,
      runtime,
      createSessionOptionsForProfile: () => ({}),
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
        hasPersistedConversationNameIntent: async () => false,
        refreshConversations: async () => [],
      },
      sessionManager: SessionManager.inMemory(process.cwd(), {
        id: CONVERSATION_ID,
      }),
      conversationLease: lease,
      runtime: new FakeRuntime(),
      createSessionOptionsForProfile: () => ({}),
    })).rejects.toThrow();

    expect(lease.releases).toBe(1);
  });

  it("requires active work, then replaces and consumes a run-scoped edit budget", async () => {
    const fullAccessProfile = {
      ...profile(),
      role: { ...profile().role, toolMode: "full_access" as const },
    };
    const fixture = await openActor({ profile: fullAccessProfile });
    const budgetTool = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "request_edit_budget",
    );
    const todoWrite = fixture.runtime.createOptions?.workbenchCustomTools?.find(
      ({ name }) => name === "todo_write",
    );
    expect(budgetTool).toBeDefined();
    expect(todoWrite).toBeDefined();

    const gate = fixture.runtime.createOptions?.toolCallGate;
    const complete = fixture.runtime.createOptions?.toolCallCompleted;
    const signal = new AbortController().signal;
    const decisions: Array<unknown> = [];
    const completions: Array<unknown> = [];
    const editRemainingFiles: Array<unknown> = [];
    fixture.runtime.session.promptImplementation = async () => {
      await expect(budgetTool!.execute("no-list", {
        fileCount: 1,
        reason: "No task has been selected yet.",
      })).rejects.toThrow(/active LoopList item/i);
      await todoWrite!.execute("pending-list", {
        items: [{ id: "edit", text: "Edit the actor", status: "pending" }],
      });
      await expect(budgetTool!.execute("pending-only", {
        fileCount: 1,
        reason: "Pending work is not current work.",
      })).rejects.toThrow(/active LoopList item/i);
      await todoWrite!.execute("completed-list", {
        items: [{ id: "edit", text: "Edit the actor", status: "completed" }],
      });
      await expect(budgetTool!.execute("completed-only", {
        fileCount: 1,
        reason: "Completed work is not current work.",
      })).rejects.toThrow(/active LoopList item/i);
      await todoWrite!.execute("active-list", {
        items: [{ id: "edit", text: "Edit the actor", status: "active" }],
      });
      editRemainingFiles.push(
        fixture.runtime.createOptions?.getEditBudgetRemainingFiles?.(),
      );

      decisions.push(await gate?.({
        toolCallId: "blocked-before-grant",
        toolName: "edit",
        toolSource: "builtin",
        args: { path: "src/server/conversation-actor.ts" },
        signal,
      }));
      await expect(budgetTool!.execute("invalid-count", {
        fileCount: 101,
        reason: "A transformed request must keep the declared bounds.",
      })).rejects.toThrow("fileCount must be an integer from 1 to 100");
      await expect(budgetTool!.execute("invalid-reason", {
        fileCount: 1,
        reason: ` ${"x".repeat(2_001)} `,
      })).rejects.toThrow("reason exceeds 2000 characters after trimming");
      const grant = await budgetTool?.execute("grant-1", {
        fileCount: 1,
        reason: ` ${"x".repeat(2_000)} `,
      });
      completions.push(grant?.details);
      editRemainingFiles.push(
        fixture.runtime.createOptions?.getEditBudgetRemainingFiles?.(),
      );

      decisions.push(await gate?.({
        toolCallId: "first-edit",
        toolName: "edit",
        toolSource: "builtin",
        args: { path: "src/server/conversation-actor.ts" },
        signal,
      }));
      completions.push(await complete?.({
        toolCallId: "first-edit",
        toolName: "edit",
        toolSource: "builtin",
        args: { path: "src/server/conversation-actor.ts" },
        signal: new AbortController().signal,
        isError: false,
        details: undefined,
      }));
      completions.push(await complete?.({
        toolCallId: "first-edit",
        toolName: "edit",
        toolSource: "builtin",
        args: { path: "src/server/conversation-actor.ts" },
        signal,
        isError: true,
        details: { retained: true },
      }));

      decisions.push(await gate?.({
        toolCallId: "retry-edit",
        toolName: "edit",
        toolSource: "builtin",
        args: { path: "src/server/conversation-actor.ts" },
        signal,
      }));
      completions.push(await complete?.({
        toolCallId: "retry-edit",
        toolName: "edit",
        toolSource: "builtin",
        args: { path: "src/server/conversation-actor.ts" },
        signal,
        isError: false,
        details: undefined,
      }));
      editRemainingFiles.push(
        fixture.runtime.createOptions?.getEditBudgetRemainingFiles?.(),
      );
      const replacement = await budgetTool?.execute("replace-grant", {
        fileCount: 2,
        reason: "Replace the run total after modifying the first file.",
      });
      completions.push(replacement?.details);
      editRemainingFiles.push(
        fixture.runtime.createOptions?.getEditBudgetRemainingFiles?.(),
      );
      await todoWrite!.execute("complete-after-grant", {
        items: [{ id: "edit", text: "Edit the actor", status: "completed" }],
      });

      decisions.push(await gate?.({
        toolCallId: "same-file-alias",
        toolName: "write",
        toolSource: "builtin",
        args: { path: "src/server/../server/conversation-actor.ts" },
        signal,
      }));
      completions.push(await complete?.({
        toolCallId: "same-file-alias",
        toolName: "write",
        toolSource: "builtin",
        args: { path: "src/server/../server/conversation-actor.ts" },
        signal,
        isError: false,
        details: undefined,
      }));

      decisions.push(await gate?.({
        toolCallId: "second-file",
        toolName: "edit",
        toolSource: "builtin",
        args: { path: "src/server/meta-tools.ts" },
        signal,
      }));
      completions.push(await complete?.({
        toolCallId: "second-file",
        toolName: "edit",
        toolSource: "builtin",
        args: { path: "src/server/meta-tools.ts" },
        signal,
        isError: false,
        details: undefined,
      }));
      editRemainingFiles.push(
        fixture.runtime.createOptions?.getEditBudgetRemainingFiles?.(),
      );
      decisions.push(await gate?.({
        toolCallId: "third-file",
        toolName: "write",
        toolSource: "builtin",
        args: { path: "src/server/pi-runtime.ts" },
        signal,
      }));
    };

    await fixture.actor.startPrompt({
      runId: RUN_A,
      text: "edit with an explicit scope",
      origin: "browser",
    });

    expect(decisions[0]).toMatchObject({
      block: true,
      reason: expect.stringContaining("request_edit_budget"),
    });
    expect(completions[0]).toMatchObject({
      outcome: "edit_budget_granted",
      grantedFiles: 1,
      remainingFiles: 1,
      blockedAttempts: 1,
    });
    expect(decisions[1]).toBeUndefined();
    expect(completions[1]).toBeUndefined();
    expect(completions[2]).toMatchObject({
      details: {
        retained: true,
        piwebEditBudget: {
          countedNewFile: false,
          touchedFiles: 0,
          remainingFiles: 1,
        },
      },
    });
    expect(decisions[2]).toBeUndefined();
    expect(completions[3]).toMatchObject({
      details: {
        piwebEditBudget: {
          countedNewFile: true,
          touchedFiles: 1,
          remainingFiles: 0,
        },
      },
    });
    expect(completions[4]).toMatchObject({
      outcome: "edit_budget_granted",
      grantedFiles: 2,
      touchedFiles: 1,
      remainingFiles: 1,
      blockedAttempts: 1,
    });
    expect(decisions[3]).toBeUndefined();
    expect(completions[5]).toMatchObject({
      details: {
        piwebEditBudget: {
          countedNewFile: false,
          touchedFiles: 1,
          remainingFiles: 1,
        },
      },
    });
    expect(decisions[4]).toBeUndefined();
    expect(completions[6]).toMatchObject({
      details: {
        piwebEditBudget: {
          countedNewFile: true,
          touchedFiles: 2,
          remainingFiles: 0,
        },
      },
    });
    expect(decisions[5]).toMatchObject({ block: true });
    expect(editRemainingFiles).toEqual([0, 1, 0, 1, 0]);
    await fixture.actor.dispose();
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

async function startHeldActorRun(fixture: ActorFixture, runId: string) {
  const started = deferred();
  const release = deferred();
  fixture.runtime.session.promptImplementation = async () => {
    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "agent_start",
    }));
    started.resolve();
    await release.promise;
    fixture.runtime.session.eventListener?.(nativeEvent({
      type: "agent_end",
    }));
  };
  const completion = fixture.actor.startPrompt({
    runId,
    text: "hold run for wait-cache policy",
    origin: "browser",
  });
  await started.promise;
  const ownership = fixture.actor.currentRunOwnership(runId);
  if (!ownership) throw new Error("Expected active run ownership");
  return {
    ownership,
    finish: async () => {
      release.resolve();
      await completion;
    },
  };
}

function setWaitCacheInputs(
  session: FakeSession,
  tokens: number | null,
  input: number,
  cacheRead: number,
): void {
  session.contextTokens = tokens;
  const model = session.model;
  if (!model) throw new Error("Expected a test model");
  model.cost = { input, output: 1, cacheRead, cacheWrite: 1 };
}

function waitCacheUsage(
  input: number,
  cacheRead: number,
  cacheWrite: number,
) {
  return {
    input,
    output: 1,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function emitWaitCacheFeedback(
  session: FakeSession,
  usage?: ReturnType<typeof waitCacheUsage>,
): void {
  session.eventListener?.(nativeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "stop",
      ...(usage === undefined ? {} : { usage }),
    },
  }));
}

describe("wait cache checkpoint policy", () => {
  const target = {
    conversationId: TARGET_CONVERSATION_ID,
    runId: RUN_B,
  };

  it("fails closed unless context and model economics qualify", async () => {
    const fixture = await openActor();
    const run = await startHeldActorRun(fixture, RUN_A);
    const restore = fixture.actor.enterWaiting(run.ownership, target);

    const cases = [
      { tokens: 31_999, input: 10, cacheRead: 1, expected: false },
      { tokens: null, input: 10, cacheRead: 1, expected: false },
      { tokens: 50_000, input: 10, cacheRead: 0, expected: false },
      { tokens: 50_000, input: 9, cacheRead: 1, expected: false },
      { tokens: 50_000, input: 10, cacheRead: 1, expected: true },
    ] as const;
    for (const testCase of cases) {
      setWaitCacheInputs(
        fixture.runtime.session,
        testCase.tokens,
        testCase.input,
        testCase.cacheRead,
      );
      expect(fixture.actor.canScheduleWaitCacheCheckpoint(run.ownership))
        .toBe(testCase.expected);
    }

    restore();
    await run.finish();
    await fixture.actor.dispose();
  });

  it("requires positive cache feedback and caps checkpoints per run", async () => {
    const fixture = await openActor();
    const run = await startHeldActorRun(fixture, RUN_A);
    setWaitCacheInputs(fixture.runtime.session, 50_000, 10, 1);

    for (let checkpoint = 0; checkpoint < 8; checkpoint += 1) {
      const restore = fixture.actor.enterWaiting(run.ownership, target);
      expect(fixture.actor.claimWaitCacheCheckpoint(run.ownership)).toBe(true);
      expect(fixture.actor.canScheduleWaitCacheCheckpoint(run.ownership))
        .toBe(false);
      restore();
      emitWaitCacheFeedback(
        fixture.runtime.session,
        waitCacheUsage(20, 80, 10),
      );
    }

    const restore = fixture.actor.enterWaiting(run.ownership, target);
    expect(fixture.actor.canScheduleWaitCacheCheckpoint(run.ownership))
      .toBe(false);
    expect(fixture.actor.claimWaitCacheCheckpoint(run.ownership)).toBe(false);
    restore();

    await run.finish();
    await fixture.actor.dispose();
  });

  it.each([
    ["missing", undefined],
    ["invalid", waitCacheUsage(Number.NaN, 80, 10)],
    ["low-hit", waitCacheUsage(80, 10, 10)],
  ])("disables later checkpoints after %s usage", async (_name, usage) => {
    const fixture = await openActor();
    const run = await startHeldActorRun(fixture, RUN_A);
    setWaitCacheInputs(fixture.runtime.session, 50_000, 10, 1);

    let restore = fixture.actor.enterWaiting(run.ownership, target);
    expect(fixture.actor.claimWaitCacheCheckpoint(run.ownership)).toBe(true);
    restore();
    emitWaitCacheFeedback(fixture.runtime.session, usage);

    restore = fixture.actor.enterWaiting(run.ownership, target);
    expect(fixture.actor.canScheduleWaitCacheCheckpoint(run.ownership))
      .toBe(false);
    restore();

    await run.finish();
    await fixture.actor.dispose();
  });
});
