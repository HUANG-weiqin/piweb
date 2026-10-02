import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  type Api,
  type Transport,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createReadTool,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateModelRuntimeOptions,
  type ExtensionAPI,
  type BuildSystemPromptOptions,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoopList } from "../shared/protocol.js";
import { BashBackgroundTaskRegistry, type BashTaskCompletion } from "./bash-execution.js";
import { PiRuntime } from "./pi-runtime.js";
import { projectConversationHistory } from "./conversation-history.js";
import type { ComputerToolResult, WindowsDesktopAdapter } from "./computer-use.js";

initTheme();

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function normalizedPromptOptions(
  cwd: string,
  selectedTools: string[],
): BuildSystemPromptOptions {
  return {
    cwd,
    customPrompt: undefined,
    forceSystemPrompt: undefined,
    selectedTools,
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    contextFiles: [],
    skills: [],
  };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function providerModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 128,
  };
}

async function fixedModelTransportRuntime(
  transport: Transport,
  provider: string,
  api: Api,
): Promise<{ runtime: PiRuntime; constructedTransport(): Transport | undefined }> {
  let constructed: Transport | undefined;
  const credentialStore = new InMemoryCredentialStore();
  const createModelRuntime = async (options: CreateModelRuntimeOptions) => {
    const runtime = await ModelRuntime.create({
      ...options,
      modelsPath: null,
    });
    runtime.registerProvider(provider, {
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      api,
      models: [providerModel("fixed-model")],
    });
    await runtime.refresh({ allowNetwork: false });
    return runtime;
  };
  const options = {
    credentialStore,
    modelsStore: new InMemoryModelsStore(),
    createModelsStore: () => new InMemoryModelsStore(),
    createModelRuntime,
    createSettings: () => SettingsManager.inMemory({ transport }),
  };
  const runtime = await PiRuntime.create({
    ...options,
    createServices: (serviceOptions) => createAgentSessionServices({
      ...serviceOptions,
      agentDir: serviceOptions.cwd,
      resourceLoaderOptions: {
        ...serviceOptions.resourceLoaderOptions,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    }),
    createSessionFromServices: async (sessionOptions) => {
      constructed = sessionOptions.services.settingsManager.getTransport();
      return createAgentSessionFromServices(sessionOptions);
    },
  });

  return { runtime, constructedTransport: () => constructed };
}

function workbenchTool(cwd: string, name = "workbench_meta") {
  return {
    ...createReadTool(cwd),
    name,
    label: name,
    description: "A workbench-owned test tool.",
  };
}

function shadowReadTool(cwd: string, name: string, marker: string) {
  return {
    ...createReadTool(cwd),
    name,
    label: `shadowed ${name}`,
    promptSnippet: marker,
    promptGuidelines: [marker],
  };
}

async function testRuntime(
  extensionsFor: (cwd: string) => InlineExtension[],
  afterCreate?: (
    created: Awaited<ReturnType<typeof createAgentSessionFromServices>>,
    options: Parameters<typeof createAgentSessionFromServices>[0],
  ) => Promise<void>,
  setupModelRuntime?: (runtime: ModelRuntime) => Promise<void> | void,
  createSettings: () => SettingsManager = () => SettingsManager.inMemory(),
  runtimeOptions: Pick<
    Parameters<typeof PiRuntime.create>[0],
    "createWindowsDesktopAdapter"
  > = {},
): Promise<PiRuntime> {
  const credentialStore = new InMemoryCredentialStore();
  return PiRuntime.create({
    ...runtimeOptions,
    credentialStore,
    modelsStore: new InMemoryModelsStore(),
    createModelsStore: () => new InMemoryModelsStore(),
    createModelRuntime: async (options) => {
      const runtime = await ModelRuntime.create({ ...options, modelsPath: null });
      await setupModelRuntime?.(runtime);
      return runtime;
    },
    createSettings,
    createServices: (options) => createAgentSessionServices({
      ...options,
      agentDir: options.cwd,
      resourceLoaderOptions: {
        ...options.resourceLoaderOptions,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: extensionsFor(options.cwd),
      },
    }),
    createSessionFromServices: async (options) => {
      const created = await createAgentSessionFromServices(options);
      await afterCreate?.(created, options);
      return created;
    },
  });
}

describe("PiRuntime session ownership", () => {
  it("installs service tier below the official session request decorator", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-service-tier-");
    const runtime = await testRuntime(() => []);
    const created = await runtime.createSession(cwd, {
      getServiceTier: () => "priority",
    });
    const officialSessionStream = created.session.agent.streamFunction;
    expect(Object.hasOwn(created.modelRuntime, "streamSimple")).toBe(true);
    const lowLevelStream = vi.spyOn(created.modelRuntime, "stream")
      .mockReturnValue({ source: "official-low-level-stream" } as never);
    const model = {
      provider: "test",
      id: "future-model",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      contextWindow: 100_000,
      maxTokens: 8_192,
    };
    const context = normalizeContext({ systemPrompt: "", messages: [], tools: [] });

    await officialSessionStream(model as never, context as never, {
      maxRetries: 4,
      websocketConnectTimeoutMs: 222,
    });
    expect(lowLevelStream).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        serviceTier: "priority",
        timeoutMs: expect.any(Number),
        websocketConnectTimeoutMs: 222,
        maxRetries: 4,
        maxRetryDelayMs: expect.any(Number),
        transformHeaders: expect.any(Function),
      }),
    );
    const lowLevelOptions = lowLevelStream.mock.calls[0]?.[2];
    expect(await lowLevelOptions?.transformHeaders?.({ "x-test": "kept" }))
      .toMatchObject({ "x-test": "kept" });

    await created.dispose();
    expect(created.session.agent.streamFunction).toBe(officialSessionStream);
    expect(Object.hasOwn(created.modelRuntime, "streamSimple")).toBe(false);
  });

  it("attributes an out-of-loop session stream request to its OpenCode session", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-opencode-attribution-");
    const runtime = await testRuntime(() => []);
    const created = await runtime.createSession(cwd);
    const sessionStream = created.session.agent.streamFunction;
    const streamSimple = vi.spyOn(created.modelRuntime, "streamSimple")
      .mockReturnValue({ source: "raw-session-stream" } as never);
    const model = {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
    const context = normalizeContext({ systemPrompt: "", messages: [], tools: [] });

    await sessionStream(model as never, context as never, {
      sessionId: created.session.sessionId,
      transport: created.session.agent.transport,
    });

    const options = streamSimple.mock.calls[0]?.[2];
    expect(await options?.transformHeaders?.({ "x-kept": "1" })).toMatchObject({
      "x-kept": "1",
      "x-opencode-session": created.session.sessionId,
      "x-opencode-client": "pi",
    });

    streamSimple.mockClear();
    await sessionStream(
      { ...model, provider: "test", baseUrl: "https://example.invalid" } as never,
      context as never,
      { sessionId: created.session.sessionId },
    );
    expect(await streamSimple.mock.calls[0]?.[2]?.transformHeaders?.({}))
      .toEqual({});

    await created.dispose();
  });

  it("does not resolve an explicit compaction model when Pi's manual hook supplies the summary", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-compaction-hook-");
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first message ".repeat(100) }],
      timestamp: 1,
    });
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second message ".repeat(100) }],
      timestamp: 2,
    });
    let hookCalls = 0;
    const runtime = await testRuntime(
      () => [
        (pi) => {
          pi.on("session_before_compact", (event) => {
            hookCalls++;
            return {
              compaction: {
                summary: "extension summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        },
      ],
      undefined,
      async (modelRuntime) => {
        modelRuntime.registerProvider("compaction-test", {
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [
            providerModel("main-model"),
            { ...providerModel("summary-model"), contextWindow: 2_048 },
          ],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
      () => SettingsManager.inMemory({
        compaction: { reserveTokens: 1, keepRecentTokens: 1 },
      }),
    );
    const created = await runtime.createSession(cwd, {
      sessionManager: manager,
      model: { provider: "compaction-test", id: "main-model" },
      compactionModel: { provider: "compaction-test", id: "summary-model" },
    });
    await created.activateExtensions();
    const getModel = vi.spyOn(created.modelRuntime, "getModel");
    getModel.mockClear();

    await created.session.compact();

    expect(hookCalls).toBe(1);
    expect(getModel).not.toHaveBeenCalled();
    expect(manager.getEntries()).toContainEqual(expect.objectContaining({
      type: "compaction",
      summary: "extension summary",
      fromHook: true,
    }));
    await created.dispose();
  });

  it("routes real manual and automatic default compaction through the frozen target request", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-compaction-default-");
    const manager = SessionManager.inMemory(cwd);
    const appendMessages = () => {
      manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "first message ".repeat(100) }],
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "second message ".repeat(100) }],
        timestamp: Date.now() + 1,
      });
    };
    appendMessages();
    const reference = { provider: "compact-provider", id: "compact-model" };
    const authRequests: Array<{ provider: string; id: string }> = [];
    const providerRequests: Array<{ model: unknown; options: unknown }> = [];
    const compactionAttemptEvents: unknown[] = [];
    const runtime = await testRuntime(
      () => [],
      async (result) => {
        const modelRuntime = result.session.modelRuntime;
        vi.spyOn(modelRuntime, "getAuth").mockImplementation(async (model) => {
          authRequests.push({ provider: model.provider, id: model.id });
          if (model.provider === "main-provider") {
            return {
              auth: {
                apiKey: "main-api-key-sentinel",
                baseUrl: "https://main.invalid/v1",
                headers: { "x-main-sentinel": "must-not-leak" },
              },
              env: { MAIN_ENV_SENTINEL: "must-not-leak" },
            } as never;
          }
          return {
            auth: {
              apiKey: "compact-api-key-sentinel",
              baseUrl: "https://compact-auth.invalid/v1",
              headers: { "x-compact": "kept" },
            },
            env: { COMPACT_ENV: "kept" },
          } as never;
        });
        vi.spyOn(modelRuntime, "streamSimple").mockImplementation((
          requestModel,
          _context,
          requestOptions,
        ) => {
          providerRequests.push({ model: requestModel, options: requestOptions });
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.end({
            role: "assistant",
            content: [{ type: "text", text: "provider summary" }],
            api: "openai-completions",
            provider: "compact-provider",
            model: "compact-model",
            stopReason: "stop",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          } as never));
          return stream;
        });
        reference.id = "mutated-after-create";
      },
      async (modelRuntime) => {
        modelRuntime.registerProvider("main-provider", {
          baseUrl: "https://main.invalid/v1",
          apiKey: "main-api-key",
          api: "openai-completions",
          models: [providerModel("main-model")],
        });
        modelRuntime.registerProvider("compact-provider", {
          baseUrl: "https://compact.invalid/v1",
          apiKey: "compact-api-key",
          api: "openai-completions",
          models: [{ ...providerModel("compact-model"), contextWindow: 2_048 }],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
      () => SettingsManager.inMemory({
        compaction: { reserveTokens: 1, keepRecentTokens: 1 },
      }),
    );
    const created = await runtime.createSession(cwd, {
      sessionManager: manager,
      model: { provider: "main-provider", id: "main-model" },
      compactionModel: reference,
      compactionAttemptObserver: (event) => compactionAttemptEvents.push(event),
    });

    await created.session.compact();
    appendMessages();
    await (created.session as AgentSession & {
      _runAutoCompaction(reason: string, willRetry: boolean): Promise<boolean>;
    })._runAutoCompaction("threshold", false);

    expect(providerRequests).toHaveLength(2);
    expect(compactionAttemptEvents.map((event) => (event as { type: string }).type)).toEqual([
      "started",
      "ended",
      "started",
      "ended",
    ]);
    expect(compactionAttemptEvents[0]).toMatchObject({
      type: "started",
      attempt: {
        generator: "default",
        policy: "explicit",
        requestTarget: { provider: "compact-provider", id: "compact-model" },
      },
    });
    expect(compactionAttemptEvents[1]).toEqual({
      type: "ended",
      id: (compactionAttemptEvents[0] as { attempt: { id: string } }).attempt.id,
    });
    expect(manager.getEntries().filter((entry) => entry.type === "compaction"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            "piweb.compaction_provenance.v1": expect.objectContaining({
              generator: "default",
              policy: "explicit",
            }),
          }),
        }),
      ]));
    expect(authRequests).toEqual([
      { provider: "compact-provider", id: "compact-model" },
      { provider: "compact-provider", id: "compact-model" },
    ]);
    for (const request of providerRequests) {
      expect(request.model).toMatchObject({
        provider: "compact-provider",
        id: "compact-model",
        baseUrl: "https://compact-auth.invalid/v1",
      });
      expect(request.options).not.toMatchObject({
        apiKey: "main-api-key-sentinel",
        headers: expect.objectContaining({ "x-main-sentinel": "must-not-leak" }),
        env: expect.objectContaining({ MAIN_ENV_SENTINEL: "must-not-leak" }),
      });
    }
    expect(providerRequests.map((request) => request.options)).toEqual([
      expect.objectContaining({
        apiKey: "compact-api-key-sentinel",
        headers: { "x-compact": "kept" },
        env: { COMPACT_ENV: "kept" },
      }),
      expect.objectContaining({
        apiKey: "compact-api-key-sentinel",
        headers: { "x-compact": "kept" },
        env: { COMPACT_ENV: "kept" },
      }),
    ]);
    await created.dispose();
  });

  it("recalculates context usage at each completed tool-turn boundary", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-turn-boundary-");
    const checks: unknown[] = [];
    let upstreamReceiver: unknown;
    let upstreamFinishTurn: AgentSession["agent"]["finishTurn"];
    const runtime = await testRuntime(
      () => [],
      async (result) => {
        const agent = result.session.agent;
        upstreamFinishTurn = async function (turn, signal) {
          upstreamReceiver = this;
          return undefined;
        };
        agent.finishTurn = upstreamFinishTurn;
      },
    );
    const created = await runtime.createSession(cwd, {
      turnBoundaryCheck: (input) => {
        checks.push(input);
        return true;
      },
    });
    const getContextUsage = vi.spyOn(created.session, "getContextUsage")
      .mockReturnValue({ tokens: 700, contextWindow: 1_000, percent: 70 });
    const agent = created.session.agent;
    agent.steer({
      role: "user",
      content: [{ type: "text", text: "queued guidance" }],
      timestamp: Date.now(),
    });
    expect(agent.hasQueuedMessages()).toBe(true);
    const toolTurn = {
      message: { stopReason: "toolUse" },
      toolResults: [{}],
      context: { messages: [] },
      newMessages: [],
    } as Parameters<NonNullable<AgentSession["agent"]["finishTurn"]>>[0];

    await expect(agent.finishTurn?.(toolTurn)).resolves.toEqual({ action: "end" });
    expect(created.session.agent.hasQueuedMessages()).toBe(false);
    expect(getContextUsage).toHaveBeenCalledOnce();
    expect(checks).toEqual([{
      contextUsage: { tokens: 700, contextWindow: 1_000, percent: 70 },
      hasToolResults: true,
    }]);
    expect(upstreamReceiver).toBe(agent);
    created.releaseTurnBoundaryPause?.();
    expect(agent.hasQueuedMessages()).toBe(true);
    await created.dispose();
    expect(agent.finishTurn).toBe(upstreamFinishTurn);
  });

  it("isolates concurrent async steering identity captures before enqueue", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-steering-identity-");
    const runtime = await testRuntime(() => []);
    const created = await runtime.createSession(cwd);
    const first: Parameters<typeof created.session.agent.steer>[0] = {
      role: "user",
      content: [{ type: "text", text: "same queued guidance" }],
      timestamp: 1,
    };
    const second: Parameters<typeof created.session.agent.steer>[0] = {
      role: "user",
      content: [{ type: "text", text: "same queued guidance" }],
      timestamp: 2,
    };
    const captured: unknown[] = [];

    await Promise.all([
      created.captureSteeringMessage((message) => captured.push(message), async () => {
        await Promise.resolve();
        created.session.agent.steer(first);
      }),
      created.captureSteeringMessage((message) => captured.push(message), async () => {
        await Promise.resolve();
        created.session.agent.steer(second);
      }),
    ]);

    expect(captured).toEqual([first, second]);
    expect(created.session.agent.hasQueuedMessages()).toBe(true);
    await created.dispose();
  });

  it("disables session cache warming without changing the configured user preference", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-cache-warming-");
    const runtime = await testRuntime(
      () => [],
      undefined,
      undefined,
      () => SettingsManager.inMemory({ cacheWarming: "idle" }),
    );
    const created = await runtime.createSession(cwd);
    const settings = created.settings;

    expect(settings.getCacheWarmingMode()).toBe("off");
    expect(settings.getSettings().cacheWarming).toBe("idle");
    expect(created.session.cacheWarmingStatus).toMatchObject({
      state: "inactive",
      reason: "cache warming disabled",
    });

    await created.dispose();
    expect(settings.getCacheWarmingMode()).toBe("idle");
    expect(settings.getSettings().cacheWarming).toBe("idle");
  });

  it("owns the supplied manager compaction boundary for the session lifetime", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-compaction-boundary-");
    const manager = SessionManager.inMemory(cwd);
    const nativeAppendCompaction = manager.appendCompaction;
    const runtime = await testRuntime(() => []);

    const created = await runtime.createSession(cwd, { sessionManager: manager });
    expect(Object.hasOwn(manager, "appendCompaction")).toBe(true);
    expect(manager.appendCompaction).not.toBe(nativeAppendCompaction);

    await created.dispose();
    expect(Object.hasOwn(manager, "appendCompaction")).toBe(false);
    expect(manager.appendCompaction).toBe(nativeAppendCompaction);
  });

  it("persists the context-budget hint as hidden history and restores the converter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cwd = await temporaryDirectory("piweb-runtime-context-budget-");
    const manager = SessionManager.inMemory(cwd);
    const projectMessage = {
      role: "custom" as const,
      customType: "test.project_context.v1",
      content: "project context",
      display: false,
      timestamp: 1,
    };
    let originalTransform: unknown;
    let originalConverter: unknown;
    const runtime = await testRuntime(
      () => [
        (pi) => {
          pi.on("context", (event) => ({
            messages: [
              ...event.messages,
              projectMessage as (typeof event.messages)[number],
            ],
          }));
        },
      ],
      async (result) => {
        originalTransform = result.session.agent.transformContext;
        originalConverter = result.session.agent.convertToLlm;
      },
    );
    let thresholdPercent = 70;
    const created = await runtime.createSession(cwd, {
      sessionManager: manager,
      getLoopList: () => ({
        items: [{ id: "work", text: "Active work", status: "active" }],
        armed: true,
      }),
      getCompactionThresholdPercent: () => thresholdPercent,
    });
    await created.activateExtensions();
    vi.spyOn(created.session, "getContextUsage").mockReturnValue({
      tokens: 10_000,
      contextWindow: 100_000,
      percent: 10,
    });
    const input = [{
      role: "user",
      content: [{ type: "text", text: "input" }],
      timestamp: 1,
    }] as Parameters<NonNullable<
      typeof created.session.agent.transformContext
    >>[0];
    const sessionMessagesBefore = [...created.session.messages];
    const entriesBefore = manager.getEntries();

    const firstTransformed = await created.session.agent.transformContext!(input);
    const first = await created.session.agent.convertToLlm(firstTransformed);
    thresholdPercent = 80;
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const secondTransformed = await created.session.agent.transformContext!(input);
    const second = await created.session.agent.convertToLlm(secondTransformed);

    expect(firstTransformed).toEqual([input[0], projectMessage]);
    expect(secondTransformed).toEqual([input[0], projectMessage]);
    const converted = [
      input[0],
      {
        role: "user",
        content: [{ type: "text", text: "project context" }],
        timestamp: 1,
      },
    ];
    expect(first).toEqual(converted);
    expect(second).toEqual(converted);
    const hints = manager.getEntries().filter((entry) => entry.type === "custom_message");
    expect(hints).toHaveLength(2);
    expect(hints[0]).toMatchObject({
      customType: "piweb.context_hint.v1",
      display: false,
      content: [
        "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
        "piweb_work={\"active\":[{\"id\":\"work\",\"text\":\"Active work\"}]}",
      ].join("\n"),
    });
    expect(hints[1]).toMatchObject({
      content: [
        "<piweb_ctx used=\"10k/100k\" auto_compact=\"80%\" remaining=\"70k\" />",
        "piweb_work={\"active\":[{\"id\":\"work\",\"text\":\"Active work\"}]}",
      ].join("\n"),
    });
    expect(created.session.messages.length).toBe(sessionMessagesBefore.length + 2);
    expect(created.session.agent.transformContext).toBe(originalTransform);
    expect(created.session.agent.convertToLlm).not.toBe(originalConverter);

    await created.dispose();
    expect(created.session.agent.transformContext).toBe(originalTransform);
    expect(created.session.agent.convertToLlm).toBe(originalConverter);
    vi.useRealTimers();
  });

  it("persists the latest active LoopList hint and skips it without active work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cwd = await temporaryDirectory("piweb-runtime-work-hint-");
    const manager = SessionManager.inMemory(cwd);
    let originalConverter: unknown;
    const runtime = await testRuntime(
      () => [],
      async (result) => {
        originalConverter = result.session.agent.convertToLlm;
      },
    );
    let loopList: LoopList = {
      items: [
        { id: "waiting", text: "Wait", status: "pending" },
        { id: "first", text: "First active item", status: "active" },
      ],
      armed: true,
    };
    const getLoopList = vi.fn(() => loopList);
    let elapsedMinutes = { activeMin: 4, listMin: 12 };
    const getLoopListElapsedMinutes = vi.fn(() => elapsedMinutes);
    const created = await runtime.createSession(cwd, {
      sessionManager: manager,
      getLoopList,
      getLoopListElapsedMinutes,
    });
    const getContextUsage = vi.spyOn(created.session, "getContextUsage");
    const input = [{
      role: "user" as const,
      content: [{ type: "text" as const, text: "input" }],
      timestamp: 1,
    }];
    const sessionMessagesBefore = [...created.session.messages];

    const first = await created.session.agent.convertToLlm(input);
    elapsedMinutes = { activeMin: 0, listMin: 13 };
    loopList = {
      items: [{ id: "second", text: "Latest active item", status: "active" }],
      armed: true,
    };
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const second = await created.session.agent.convertToLlm(input);
    loopList = {
      items: [{ id: "done", text: "Finished", status: "completed" }],
      armed: false,
    };
    const noActive = await created.session.agent.convertToLlm(input);

    expect(first).toEqual(input);
    expect(second).toEqual(input);
    expect(noActive).toEqual(input);
    const hints = manager.getEntries().filter((entry) => entry.type === "custom_message");
    expect(hints).toHaveLength(2);
    expect(hints[0]).toMatchObject({
      customType: "piweb.context_hint.v1",
      display: false,
      content: "piweb_work={\"active\":[{\"id\":\"first\",\"text\":\"First active item\"}],\"activeElapsedMinutes\":4,\"loopListElapsedMinutes\":12}",
    });
    expect(hints[1]).toMatchObject({
      content: "piweb_work={\"active\":[{\"id\":\"second\",\"text\":\"Latest active item\"}],\"activeElapsedMinutes\":0,\"loopListElapsedMinutes\":13}",
    });
    expect(getLoopList).toHaveBeenCalledTimes(3);
    expect(getLoopListElapsedMinutes).toHaveBeenCalledTimes(2);
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(created.session.messages.length).toBe(sessionMessagesBefore.length + 2);
    expect(created.session.agent.convertToLlm).not.toBe(originalConverter);

    await created.dispose();
    expect(created.session.agent.convertToLlm).toBe(originalConverter);
    vi.useRealTimers();
  });

  it("activates Pi's structured read-only tools by default", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-read-tools-");
    const runtime = await testRuntime(() => []);

    const created = await runtime.createSession(cwd);

    expect(created.session.getActiveToolNames()).toEqual(expect.arrayContaining([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
    ]));
    await created.dispose();
  });

  it("projects Actor-owned Bash tools with exact SDK source and effective read-only shell", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-owned-bash-");
    const settings = SettingsManager.inMemory();
    settings.setShellPath(join(cwd, "configured-bash.exe"));
    let tools: ToolDefinition[] = [];
    const runtime = await testRuntime(() => [], async (_created, options) => {
      tools = options.customTools ?? [];
    }, undefined, () => settings);
    const owner = Object.freeze({ conversationId: "owned-conversation", runId: "owned-run" });
    const created = await runtime.createSession(cwd, {
      toolMode: "read_only",
      bashExecutions: { conversationId: owner.conversationId, getOwner: () => owner },
    });
    try {
      expect(created.bashExecutions).toBeDefined();
      for (const name of ["bash", "bash_output", "bash_stop"]) {
        expect(created.session.getActiveToolNames()).toContain(name);
        expect(created.session.getAllTools().find((tool) => tool.name === name)?.sourceInfo.source).toBe("sdk");
      }
      const bash = tools.find((tool) => tool.name === "bash")!;
      await expect(bash.execute("unsafe", { command: "rm victim", timeout: 120_000 } as never, undefined, undefined, undefined as never))
        .rejects.toThrow(/read-only/i);
      await expect(bash.execute("effective-shell", { command: "pwd", timeout: 120_000 } as never, undefined, undefined, undefined as never))
        .rejects.toThrow(/Custom shell path not found:.*configured-bash\.exe/i);
      expect(created.session.systemPrompt).toContain("reviewed");
    } finally {
      await created.dispose();
    }
  });

  it("uses the effective full-access command prefix while preserving native quick output", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-owned-bash-prefix-");
    const settings = SettingsManager.inMemory({ shellCommandPrefix: "printf prefix-marker;" });
    let bash: ToolDefinition | undefined;
    const runtime = await testRuntime(() => [], async (_created, options) => {
      bash = options.customTools?.find((tool) => tool.name === "bash");
    }, undefined, () => settings);
    const owner = Object.freeze({ conversationId: "prefix-conversation", runId: "prefix-run" });
    const created = await runtime.createSession(cwd, {
      toolMode: "full_access",
      bashExecutions: { conversationId: owner.conversationId, getOwner: () => owner },
    });
    try {
      const result = await bash!.execute("prefix", { command: "printf command-marker", timeout: 120_000 } as never, undefined, undefined, undefined as never);
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("prefix-markercommand-marker") }),
      ]));
      expect(created.bashExecutions?.activity(owner)).toEqual({ running: 0, stopping: 0, cleanupUnknown: false });
    } finally {
      await created.dispose();
    }
  }, 15_000);

  it("keeps registry-owned Bash tasks across Pi runtime sessions and preserves the launch prefix", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-owned-bash-output-");
    let tools: ToolDefinition[] = [];
    let settingsCreationCount = 0;
    const completions: BashTaskCompletion[] = [];
    const observed: string[] = [];
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => completions.push(task),
      onObserved: (taskId) => observed.push(taskId),
    });
    const runtime = await testRuntime(
      () => [],
      async (_created, options) => {
        tools = options.customTools ?? [];
      },
      undefined,
      () => SettingsManager.inMemory({
        shellCommandPrefix: settingsCreationCount++ === 0
          ? "printf old-prefix;"
          : "printf new-prefix;",
      }),
    );
    const firstOwner = Object.freeze({ conversationId: "output-conversation", runId: "output-run" });
    const first = await runtime.createSession(cwd, {
      toolMode: "full_access",
      bashExecutions: { conversationId: firstOwner.conversationId, getOwner: () => firstOwner },
      backgroundTasks: registry,
    });
    let firstDisposed = false;
    let second: Awaited<ReturnType<typeof runtime.createSession>> | undefined;
    try {
      const bash = tools.find((tool) => tool.name === "bash")!;
      const started = await bash.execute(
        "background-start",
        { command: "sleep 0.1; printf runtime-background-marker", run_in_background: true } as never,
        undefined,
        undefined,
        undefined as never,
      ) as { content: Array<{ text?: string }>; details?: { piwebBash?: { taskId?: string } } };
      const taskId = started.details?.piwebBash?.taskId;
      expect(taskId).toBeTruthy();
      expect(started.content[0]?.text).toContain("do not poll");

      await first.dispose();
      firstDisposed = true;
      const secondOwner = Object.freeze({ conversationId: firstOwner.conversationId, runId: "replacement-run" });
      second = await runtime.createSession(cwd, {
        toolMode: "full_access",
        bashExecutions: { conversationId: secondOwner.conversationId, getOwner: () => secondOwner },
        backgroundTasks: registry,
      });
      const output = tools.find((tool) => tool.name === "bash_output")!;
      const result = await output.execute(
        "background-output",
        { task_id: taskId, timeout: 30_000 } as never,
        undefined,
        undefined,
        undefined as never,
      ) as { content: Array<{ text?: string }> };
      const resultText = result.content.map(({ text }) => text ?? "").join("\n");
      expect(resultText).toContain("old-prefix");
      expect(resultText).toContain("runtime-background-marker");
      expect(resultText).not.toContain("new-prefix");
      // The blocking read returned the final result itself, so no notification is due.
      expect(completions).toEqual([]);
      expect(observed).toEqual([taskId]);
    } finally {
      if (second) await second.dispose();
      if (!firstDisposed) await first.dispose();
      await registry.close("dispose");
    }
  }, 15_000);

  it("requires an exact active owner before Actor-owned Bash can start", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-owned-bash-owner-");
    let bash: ToolDefinition | undefined;
    const runtime = await testRuntime(() => [], async (_created, options) => {
      bash = options.customTools?.find((tool) => tool.name === "bash");
    });
    const created = await runtime.createSession(cwd, {
      bashExecutions: { conversationId: "idle-conversation", getOwner: () => undefined },
    });
    try {
      await expect(bash!.execute("no-owner", { command: "printf never", timeout: 120_000 } as never, undefined, undefined, undefined as never))
        .rejects.toThrow(/active.*run/i);
    } finally {
      await created.dispose();
    }
  });

  it("builds read-only Bash with the effective SettingsManager shell path", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-read-only-shell-path-");
    const configuredShell = join(cwd, "configured-bash.exe");
    const settings = SettingsManager.inMemory();
    settings.setShellPath(configuredShell);
    let bashTool: ToolDefinition | undefined;
    const runtime = await testRuntime(
      () => [],
      async (_created, options) => {
        bashTool = options.customTools?.find((tool) => tool.name === "bash");
      },
      undefined,
      () => settings,
    );

    const created = await runtime.createSession(cwd, { toolMode: "read_only" });
    expect(bashTool).toBeDefined();
    await expect(bashTool!.execute(
      "configured-shell",
      { command: "pwd" } as never,
      undefined,
      undefined,
      undefined as never,
    )).rejects.toThrow(/Custom shell path not found:.*configured-bash\.exe/i);
    await created.dispose();
  });

  it("projects only safe native and host tools for read-only sessions", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-read-only-tools-");
    const runtime = await testRuntime(() => [
      (pi) => {
        const originalRead = createReadTool(cwd);
        pi.registerTool({
          name: "extension_only",
          label: "extension only",
          description: originalRead.description,
          parameters: originalRead.parameters,
          execute: (toolCallId, params, signal, onUpdate) => (
            originalRead.execute(toolCallId, params, signal, onUpdate)
          ),
        });
      },
    ]);

    const created = await runtime.createSession(cwd, {
      toolMode: "read_only",
      workbenchCustomTools: [
        workbenchTool(cwd, "notebook_list"),
        workbenchTool(cwd, "notebook_grep"),
        workbenchTool(cwd, "notebook_read"),
        workbenchTool(cwd, "notebook_write"),
        workbenchTool(cwd, "list_sessions"),
      ],
    });

    const allTools = created.session.getAllTools();
    const expectedToolNames = new Set([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "notebook_write",
      "notebook_list",
      "notebook_grep",
      "notebook_read",
    ]);
    expect(new Set(created.session.getActiveToolNames())).toEqual(expectedToolNames);
    expect(new Set(allTools.map((tool) => tool.name))).toEqual(expectedToolNames);
    expect(allTools.find((tool) => tool.name === "read")?.sourceInfo.source)
      .toBe("builtin");
    expect(allTools.find((tool) => tool.name === "bash")?.sourceInfo.source)
      .toBe("sdk");
    expect(created.session.systemPrompt).toContain(
      "Run reviewed Git, rg, and file queries",
    );
    expect(created.session.systemPrompt).not.toContain("Execute bash commands");
    expect(allTools.find((tool) => tool.name === "notebook_write")?.sourceInfo.source)
      .toBe("sdk");
    await created.dispose();
  });

  it("freezes the prompt-affecting tool topology after extension startup", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-dynamic-read-only-tools-");
    const staticMarker = "STATIC_SHADOW_TOOL_MARKER";
    const startMarker = "SESSION_START_SHADOW_TOOL_MARKER";
    const dynamicMarker = "DYNAMIC_SHADOW_TOOL_MARKER";
    let extensionApi: ExtensionAPI | undefined;
    let sessionStarted = false;
    let shutdownActiveTools: string[] | undefined;
    let shutdownSystemPrompt: string | undefined;
    const runtime = await testRuntime(() => [
      (pi) => {
        extensionApi = pi;
        pi.registerTool(shadowReadTool(cwd, "find", staticMarker));
        pi.on("session_start", () => {
          sessionStarted = true;
          pi.registerTool(shadowReadTool(cwd, "read", startMarker));
          pi.setActiveTools(["read", "find", "grep", "ls", "bash"]);
        });
        pi.on("session_shutdown", (_event, context) => {
          shutdownActiveTools = pi.getActiveTools();
          shutdownSystemPrompt = context.getSystemPrompt();
        });
      },
    ]);

    const created = await runtime.createSession(cwd, {
      toolMode: "read_only",
    });
    expect(created.session.getActiveToolNames()).not.toContain("find");
    expect(created.session.systemPrompt).not.toContain(staticMarker);

    await created.activateExtensions();
    expect(sessionStarted).toBe(true);
    expect(created.session.getActiveToolNames()).not.toContain("read");
    expect(created.session.getActiveToolNames()).not.toContain("find");
    expect(created.session.getActiveToolNames()).toContain("bash");
    expect(created.session.systemPrompt).not.toContain(staticMarker);
    expect(created.session.systemPrompt).not.toContain(startMarker);

    const activeToolNames = created.session.getActiveToolNames();
    const allTools = created.session.getAllTools();
    const systemPrompt = created.session.systemPrompt;
    expect(extensionApi).toBeDefined();
    expect(() => extensionApi!.registerTool(shadowReadTool(cwd, "grep", dynamicMarker)))
      .toThrow("Runtime system prompt changes are not supported");
    expect(() => extensionApi!.setActiveTools(["read", "find", "grep", "ls", "bash"]))
      .toThrow("Runtime system prompt changes are not supported");
    expect(() => created.session.setActiveToolsByName(["bash"]))
      .toThrow("Runtime system prompt changes are not supported");
    expect(created.session.getActiveToolNames()).toEqual(activeToolNames);
    expect(created.session.getAllTools()).toEqual(allTools);
    expect(created.session.systemPrompt).toBe(systemPrompt);
    expect(created.session.systemPrompt).not.toContain(dynamicMarker);

    const projectedSetter = created.session.setActiveToolsByName;
    await created.dispose();
    expect(shutdownActiveTools).toEqual(activeToolNames);
    expect(shutdownSystemPrompt).toBe(systemPrompt);
    expect(created.session.setActiveToolsByName).not.toBe(projectedSetter);
  });

  it("keeps system prompt overrides rejected while extension startup configures tools", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-startup-prompt-override-");
    let startupOverrideError: unknown;
    const runtime = await testRuntime(
      () => [
        (pi) => {
          pi.on("before_agent_start", () => ({
            systemPrompt: "UNSUPPORTED_STARTUP_PROMPT_OVERRIDE",
          }));
        },
      ],
      async (created) => {
        const nativeBindExtensions = created.session.bindExtensions.bind(created.session);
        created.session.bindExtensions = async (bindings) => {
          await nativeBindExtensions(bindings);
          try {
            await created.session.extensionRunner.emitBeforeAgentStart(
              "request",
              undefined,
              normalizedPromptOptions(cwd, created.session.getActiveToolNames()),
            );
          } catch (error) {
            startupOverrideError = error;
          }
        };
      },
    );
    const created = await runtime.createSession(cwd);
    await created.activateExtensions();

    expect(startupOverrideError).toBeInstanceOf(Error);
    expect((startupOverrideError as Error).message)
      .toBe("Runtime system prompt changes are not supported");
    expect(created.session.systemPrompt).not.toContain("UNSUPPORTED_STARTUP_PROMPT_OVERRIDE");

    await created.dispose();
  });

  it("rejects extension per-turn system prompt overrides after activation", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-prompt-override-");
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("before_agent_start", () => ({
          systemPrompt: "UNSUPPORTED_RUNTIME_PROMPT_OVERRIDE",
        }));
      },
    ]);
    const created = await runtime.createSession(cwd);
    await created.activateExtensions();
    const systemPrompt = created.session.systemPrompt;

    await expect(created.session.extensionRunner.emitBeforeAgentStart(
      "request",
      undefined,
      normalizedPromptOptions(cwd, created.session.getActiveToolNames()),
    )).rejects.toThrow("Runtime system prompt changes are not supported");
    expect(created.session.systemPrompt).toBe(systemPrompt);

    await created.dispose();
  });

  const promptTopologyMutations: Array<[
    string,
    (options: BuildSystemPromptOptions) => void,
  ]> = [
    ["selectedTools", (options) => options.selectedTools!.push("unexpected-tool")],
    ["forceSystemPrompt", (options) => { options.forceSystemPrompt = "unexpected"; }],
    ["customPrompt", (options) => { options.customPrompt = "unexpected"; }],
    ["appendSystemPrompt", (options) => { options.appendSystemPrompt = "unexpected"; }],
    ["sections", (options) => { options.sections!.piweb_test = "unexpected"; }],
    ["contextFiles", (options) => options.contextFiles!.push({ path: "test.md", content: "unexpected" })],
    ["skills", (options) => options.skills!.push({} as never)],
    ["toolSnippets", (options) => { options.toolSnippets!.test = "unexpected"; }],
    ["toolGuidelines", (options) => { options.toolGuidelines!.test = ["unexpected"]; }],
    ["promptGuidelines", (options) => options.promptGuidelines!.push("unexpected")],
  ];

  it.each(promptTopologyMutations)(
    "rejects in-place before_agent_start mutation of %s",
    async (_field, mutate) => {
      const cwd = await temporaryDirectory("piweb-runtime-prompt-topology-");
      const runtime = await testRuntime(() => [
        (pi) => {
          pi.on("before_agent_start", (event) => {
            mutate(event.systemPromptOptions);
          });
        },
      ]);
      const created = await runtime.createSession(cwd);
      await created.activateExtensions();
      const options = normalizedPromptOptions(cwd, created.session.getActiveToolNames());
      const before = structuredClone(options);

      await expect(created.session.extensionRunner.emitBeforeAgentStart(
        "request",
        undefined,
        options,
      )).rejects.toThrow("Runtime system prompt changes are not supported");
      expect(options).toEqual(before);

      await created.dispose();
    },
  );

  it("allows before_agent_start mutations that restore the normalized prompt topology", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-prompt-topology-noop-");
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("before_agent_start", (event) => {
          event.systemPromptOptions.sections.piweb_test = "temporary";
          delete event.systemPromptOptions.sections.piweb_test;
        });
      },
    ]);
    const created = await runtime.createSession(cwd);
    await created.activateExtensions();
    const options = normalizedPromptOptions(cwd, created.session.getActiveToolNames());

    const result = await created.session.extensionRunner.emitBeforeAgentStart(
      "request",
      undefined,
      options,
    );
    expect(result.systemPromptOptions).toEqual(options);

    await created.dispose();
  });

  it("reports an extension that shadows read as a non-builtin tool", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-shadowed-read-");
    const runtime = await testRuntime(() => [
      (pi) => {
        const originalRead = createReadTool(cwd);
        pi.registerTool({
          name: "read",
          label: "shadowed read",
          description: originalRead.description,
          parameters: originalRead.parameters,
          execute: (toolCallId, params, signal, onUpdate) => (
            originalRead.execute(toolCallId, params, signal, onUpdate)
          ),
        });
      },
    ]);
    let toolSource = "";
    const created = await runtime.createSession(cwd, {
      toolCallGate: (input) => {
        toolSource = input.toolSource;
        return { block: true, reason: "source captured" };
      },
    });
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    const hook = created.session.agent.beforeToolCall;
    if (!hook) throw new Error("tool hook was not installed");
    type HookContext = Parameters<typeof hook>[0];

    await hook({
      toolCall: {
        type: "toolCall",
        id: "tool-shadowed-read",
        name: "read",
        arguments: { path: "README.md" },
      },
      args: { path: "README.md" },
    } as unknown as HookContext, new AbortController().signal);

    expect(toolSource).not.toBe("builtin");
    await created.dispose();
  });

  it("installs tool result compression without changing the executed result", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-tool-result-compression-");
    const runtime = await testRuntime(() => []);
    const originalText = Array.from(
      { length: 160 },
      (_, index) => `grep ${String(index).padStart(3, "0")} ${"x".repeat(100)}`,
    ).join("\n");
    const original = {
      content: [{ type: "text" as const, text: originalText }],
      details: { executed: true },
    };
    const created = await runtime.createSession(cwd);
    const afterToolCall = created.session.agent.afterToolCall;
    if (!afterToolCall) throw new Error("tool result hook was not installed");

    const patch = await afterToolCall({
      toolCall: { id: "grep-call", name: "grep" },
      args: { pattern: "x" },
      result: original,
      isError: false,
    } as Parameters<typeof afterToolCall>[0]);

    expect(patch?.content).toEqual([{
      type: "text",
      text: expect.stringContaining("[... omitted"),
    }]);
    expect(patch?.details).toBeUndefined();
    expect(original.content).toEqual([{ type: "text", text: originalText }]);
    await created.dispose();
  });

  it("sets steeringMode=all so queued prompts drain in one model turn", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-steering-mode-");
    const runtime = await testRuntime(() => []);

    const created = await runtime.createSession(cwd);
    expect(created.session.agent.steeringMode).toBe("all");
    expect(created.settings.getSteeringMode()).toBe("one-at-a-time");
    await created.dispose();
  });

  it("defaults to an in-memory manager and passes an explicit manager through", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-manager-");
    const managers: SessionManager[] = [];
    const runtime = await testRuntime(
      () => [],
      async (_created, options) => {
        if (!options.sessionManager) throw new Error("session manager was not provided");
        managers.push(options.sessionManager);
      },
    );

    const defaultSession = await runtime.createSession(cwd);
    expect(managers[0]?.isPersisted()).toBe(false);
    expect(managers[0]?.getCwd()).toBe(cwd);
    await defaultSession.dispose();

    const manager = SessionManager.inMemory(cwd, { id: "explicit-manager" });
    const explicitSession = await runtime.createSession(cwd, { sessionManager: manager });
    expect(managers[1]).toBe(manager);
    expect(explicitSession.session.sessionManager).toBe(manager);
    await explicitSession.dispose();
  });

  it("keeps extension model changes within the configured fixed identity through shutdown", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-fixed-extension-model-");
    const manager = SessionManager.inMemory(cwd);
    let nativeSetModel: AgentSession["setModel"];
    let shutdownDifferentModelError: string | undefined;
    let sameIdentityResult: boolean | undefined;
    const runtime = await testRuntime(
      () => [
        (pi) => {
          pi.on("session_start", async (_event, context) => {
            const alternate = context.modelRegistry.find(
              "fixed-extension-provider",
              "alternate-model",
            );
            if (!alternate) throw new Error("alternate test model missing");
            await pi.setModel(alternate);
          });
          pi.on("session_shutdown", async (_event, context) => {
            const alternate = context.modelRegistry.find(
              "fixed-extension-provider",
              "alternate-model",
            );
            const fixed = context.modelRegistry.find(
              "fixed-extension-provider",
              "fixed-model",
            );
            if (!alternate || !fixed) throw new Error("shutdown test model missing");
            try {
              await pi.setModel(alternate);
            } catch (error) {
              shutdownDifferentModelError = error instanceof Error
                ? error.message
                : String(error);
            }
            sameIdentityResult = await pi.setModel(fixed);
          });
        },
      ],
      async (result) => {
        nativeSetModel = result.session.setModel;
      },
      async (modelRuntime) => {
        modelRuntime.registerProvider("fixed-extension-provider", {
          baseUrl: "https://example.invalid/v1",
          apiKey: "fixed-extension-key",
          api: "openai-completions",
          models: [
            providerModel("fixed-model"),
            providerModel("alternate-model"),
          ],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
    );

    const created = await runtime.createSession(cwd, {
      sessionManager: manager,
      model: {
        provider: "fixed-extension-provider",
        id: "fixed-model",
      },
    });
    expect(created.session.setModel).not.toBe(nativeSetModel);
    const modelChangesBeforeActivation = manager.getEntries().filter(
      (entry) => entry.type === "model_change",
    );

    await created.activateExtensions();
    expect(created.activateExtensionErrors(() => undefined)).toEqual([
      expect.objectContaining({
        event: "session_start",
        error: expect.stringContaining("fixed-extension-provider/alternate-model"),
      }),
    ]);
    expect(created.session.model).toMatchObject({
      provider: "fixed-extension-provider",
      id: "fixed-model",
    });
    expect(manager.getEntries().filter((entry) => entry.type === "model_change"))
      .toEqual(modelChangesBeforeActivation);

    await created.dispose();
    expect(shutdownDifferentModelError).toContain(
      "fixed-extension-provider/alternate-model",
    );
    expect(sameIdentityResult).toBe(true);
    expect(manager.getEntries().filter((entry) => entry.type === "model_change"))
      .toEqual([
        ...modelChangesBeforeActivation,
        expect.objectContaining({
          provider: "fixed-extension-provider",
          modelId: "fixed-model",
        }),
      ]);
    expect(created.session.setModel).toBe(nativeSetModel);
  });

  it("gives extension contexts a defensive readonly session manager facade", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-extension-manager-");
    const manager = SessionManager.inMemory(cwd);
    manager.appendCustomEntry("readonly-facade-test", {
      nested: { value: "original" },
    });
    let startFacade: unknown;
    let startProjection: unknown;
    let shutdownFacade: unknown;
    let facadeKeys: string[] = [];
    let startHasMutator = true;
    let shutdownHasMutator = true;
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("session_start", (_event, context) => {
          startFacade = context.sessionManager;
          startProjection = context.sessionManager.buildSessionProjection();
          facadeKeys = Object.keys(context.sessionManager).sort();
          startHasMutator = "appendCustomEntry" in context.sessionManager;
          const entry = context.sessionManager.getEntries().find(
            (candidate) => candidate.type === "custom"
              && candidate.customType === "readonly-facade-test",
          );
          if (!entry || entry.type !== "custom") {
            throw new Error("readonly facade test entry missing");
          }
          (entry.data as { nested: { value: string } }).nested.value = "mutated";
        });
        pi.on("session_shutdown", (_event, context) => {
          shutdownFacade = context.sessionManager;
          shutdownHasMutator = "appendCustomEntry" in context.sessionManager;
        });
      },
    ]);

    const created = await runtime.createSession(cwd, { sessionManager: manager });
    const runner = created.session.extensionRunner as unknown as {
      sessionManager: unknown;
    };
    expect(created.session.sessionManager).toBe(manager);
    expect(runner.sessionManager).not.toBe(manager);

    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    expect(startFacade).toBe(runner.sessionManager);
    expect(startFacade).not.toBe(manager);
    expect(startProjection).toEqual(manager.buildSessionProjection());
    expect(startHasMutator).toBe(false);
    expect(facadeKeys).toEqual([
      "buildContextEntries",
      "buildSessionProjection",
      "getBranch",
      "getCwd",
      "getEntries",
      "getEntry",
      "getHeader",
      "getLabel",
      "getLeafEntry",
      "getLeafId",
      "getSessionDir",
      "getSessionFile",
      "getSessionId",
      "getSessionName",
      "getTree",
    ]);
    expect(manager.getEntries().find(
      (entry) => entry.type === "custom"
        && entry.customType === "readonly-facade-test",
    )).toMatchObject({
      type: "custom",
      customType: "readonly-facade-test",
      data: { nested: { value: "original" } },
    });

    await created.dispose();
    expect(shutdownFacade).toBe(startFacade);
    expect(shutdownHasMutator).toBe(false);
    expect(runner.sessionManager).toBe(manager);
    expect(created.session.sessionManager).toBe(manager);
  });

  it.each([
    ["openai-codex", "openai-codex-responses", "auto", "sse"],
    ["openai-codex", "openai-codex-responses", "websocket", "websocket"],
    ["openai-codex", "openai-codex-responses", "websocket-cached", "websocket-cached"],
    ["openai-codex", "openai-codex-responses", "sse", "sse"],
    ["openai", "openai-responses", "auto", "auto"],
  ] as const)(
    "constructs a fixed %s session with transport resolved from %s/%s",
    async (provider, api, transport, expectedTransport) => {
      const cwd = await temporaryDirectory("piweb-runtime-transport-");
      const fixture = await fixedModelTransportRuntime(transport, provider, api);

      const created = await fixture.runtime.createSession(cwd, {
        model: { provider, id: "fixed-model" },
      });

      expect(fixture.constructedTransport()).toBe(expectedTransport);
      expect(created.settings.getTransport()).toBe(expectedTransport);
      expect(created.session.agent.transport).toBe(expectedTransport);
      await created.dispose();
    },
  );



  it("passes a fixed authenticated model and workbench tools through session creation", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-role-");
    const tools = [workbenchTool(cwd)];
    let received: Parameters<typeof createAgentSessionFromServices>[0] | undefined;
    const runtime = await testRuntime(
      () => [],
      async (_created, options) => {
        received = options;
      },
      async (modelRuntime) => {
        modelRuntime.registerProvider("role-provider", {
          baseUrl: "https://example.invalid/v1",
          apiKey: "role-key",
          api: "openai-completions",
          models: [{ ...providerModel("role-model"), reasoning: true }],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
    );

    const created = await runtime.createSession(cwd, {
      model: { provider: "role-provider", id: "role-model" },
      thinkingLevel: "high",
      workbenchCustomTools: tools,
    });

    expect(received?.model).toMatchObject({
      provider: "role-provider",
      id: "role-model",
    });
    expect(received?.thinkingLevel).toBe("high");
    expect(received?.customTools).toBe(tools);
    expect(created.session.model).toMatchObject({
      provider: "role-provider",
      id: "role-model",
    });
    expect(created.session.thinkingLevel).toBe("high");
    expect(created.session.getActiveToolNames()).toContain("workbench_meta");

    created.modelRegistry.unregisterProvider("role-provider");
    await runtime.refreshConfiguration();
    expect(created.session.model).toBeUndefined();
    await created.dispose();
  });

  it("exposes computer only to a full-access exact-run session without loading Windows FFI", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-computer-");
    const received: Array<Parameters<typeof createAgentSessionFromServices>[0]> = [];
    const runtime = await testRuntime(
      () => [],
      async (_created, options) => {
        received.push(options);
      },
    );
    const owner = {};

    const full = await runtime.createSession(cwd, {
      toolMode: "full_access",
      computerUse: { getOwner: () => owner },
    });
    expect(received.at(-1)?.customTools?.map((tool) => tool.name)).toContain("computer");
    expect(full.session.getActiveToolNames()).toContain("computer");
    const computer = full.session.getToolDefinition("computer");
    if (!computer) throw new Error("Computer tool was not installed");
    expect(computer.description).toContain("mouseHold{x,y,button?,holdMs?}");
    expect(computer.description).toContain("drag{fromX,fromY,toX,toY,button?,durationMs?}");
    expect(computer.description).toContain("button is left or right");
    expect(computer.description).toContain("batch of at most 8 actions");
    expect(computer.description).toContain("foregroundWindow:true");
    expect(computer.description).toContain("at least one nonzero scroll delta");
    expect(computer.description).toContain("settleMs 0-2000");
    expect(computer.description).toContain("immediately preceding computer result");
    expect(computer.description).toContain("stored in its tool result and replayed until compaction");
    expect(computer.description).toContain("one post-action image");
    expect(computer.description).toContain("foreground_mismatch");
    expect(computer.description).toContain("sent means Windows accepted host dispatch");
    expect(computer.promptGuidelines).toContain(
      "foregroundWindow?: boolean defaults false and requires observe:true. It captures only the current foreground window's intersection with the primary display; a post-action capture uses the then-current foreground window. observe:true stores one durable image in the tool result (default post-action settle is 150ms), so later provider requests replay identical image content until compaction. observe:false does not capture. Actions are sequential; sent is host dispatch, not UI/business success.",
    );
    expect(computer.promptGuidelines).toContain(
      "Call observe first before coordinate actions. Only the current/after image from the immediately preceding computer result authorizes coordinates for the next assistant decision. Coordinates are image-local pixels: (0,0) is that image's top-left, including a foreground-window crop; never use desktop-global coordinates.",
    );
    expect(computer.promptGuidelines).toContain(
      "A foreground_mismatch may follow prior sent actions; its first not_started action and all remaining actions were not dispatched. Inspect per-action statuses, then re-observe before any coordinate retry.",
    );
    await full.dispose();

    const readOnly = await runtime.createSession(cwd, {
      toolMode: "read_only",
      computerUse: { getOwner: () => owner },
    });
    expect(received.at(-1)?.customTools?.map((tool) => tool.name)).not.toContain("computer");
    expect(readOnly.session.getActiveToolNames()).not.toContain("computer");
    await readOnly.dispose();

    const implicit = await runtime.createSession(cwd, {
      computerUse: { getOwner: () => owner },
    });
    expect(received.at(-1)?.customTools?.map((tool) => tool.name) ?? [])
      .not.toContain("computer");
    expect(implicit.session.getActiveToolNames()).not.toContain("computer");
    await implicit.dispose();
  });

  it("rejects a non-vision computer invocation before adapter creation", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-computer-novision-");
    let factoryCalls = 0;
    const runtime = await testRuntime(
      () => [],
      undefined,
      async (modelRuntime) => {
        modelRuntime.registerProvider("computer-text", {
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [{ ...providerModel("computer-text"), input: ["text"] }],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
      undefined,
      {
        createWindowsDesktopAdapter: async () => {
          factoryCalls += 1;
          throw new Error("adapter must not be created");
        },
      },
    );
    const created = await runtime.createSession(cwd, {
      toolMode: "full_access",
      model: { provider: "computer-text", id: "computer-text" },
      computerUse: { getOwner: () => ({}) },
    });
    const computer = created.session.getToolDefinition("computer");
    if (!computer) throw new Error("Computer tool was not installed");
    const execute = computer.execute as (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>;

    try {
      await expect(execute("no-vision", { actions: [], observe: true }, new AbortController().signal))
        .rejects.toThrow("supports image input");
      expect(factoryCalls).toBe(0);
    } finally {
      await created.dispose();
    }
  });

  it("rejects computer use before capture when image delivery is blocked", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-computer-blocked-images-");
    let factoryCalls = 0;
    const runtime = await testRuntime(
      () => [],
      undefined,
      async (modelRuntime) => {
        modelRuntime.registerProvider("computer-vision-blocked", {
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [{
            ...providerModel("computer-vision-blocked"),
            input: ["text", "image"],
          }],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
      () => {
        const settings = SettingsManager.inMemory();
        settings.setBlockImages(true);
        return settings;
      },
      {
        createWindowsDesktopAdapter: async () => {
          factoryCalls += 1;
          throw new Error("adapter must not be created");
        },
      },
    );
    const created = await runtime.createSession(cwd, {
      toolMode: "full_access",
      model: { provider: "computer-vision-blocked", id: "computer-vision-blocked" },
      computerUse: { getOwner: () => ({}) },
    });
    const computer = created.session.getToolDefinition("computer");
    if (!computer) throw new Error("Computer tool was not installed");
    const execute = computer.execute as (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>;

    try {
      await expect(execute(
        "blocked-images",
        { actions: [], observe: true },
        new AbortController().signal,
      )).rejects.toThrow("image delivery to be enabled");
      expect(factoryCalls).toBe(0);
    } finally {
      await created.dispose();
    }
  });

  it("persists computer images append-only while preserving exact-decision frame authority", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-computer-frame-");
    const sessionManager = SessionManager.create(cwd, cwd);
    let captureIndex = 0;
    const primaryBounds = { x: 0, y: 0, width: 30, height: 20 };
    const windowBinding = {
      foreground: { hwnd: "10", processId: 10 },
      rawBounds: { x: 0, y: 0, width: 10, height: 10 },
      captureBounds: { x: 0, y: 0, width: 10, height: 10 },
      inputBounds: primaryBounds,
    };
    const popupBinding = {
      foreground: { hwnd: "20", processId: 20 },
      rawBounds: { x: 5, y: 2, width: 20, height: 5 },
      captureBounds: { x: 5, y: 2, width: 20, height: 5 },
      inputBounds: primaryBounds,
    };
    const settings = SettingsManager.inMemory();
    let stripComputerResult = false;
    const clickedPoints: Array<{ x: number; y: number }> = [];
    const adapter: WindowsDesktopAdapter = {
      capture: async (scope) => {
        const index = ++captureIndex;
        const foregroundWindow = scope === "foreground_window"
          ? index === 2 ? popupBinding : windowBinding
          : undefined;
        const captureBounds = foregroundWindow?.captureBounds ?? primaryBounds;
        return {
          png: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index]),
          width: captureBounds.width,
          height: captureBounds.height,
          scope,
          captureBounds,
          inputBounds: primaryBounds,
          foreground: foregroundWindow?.foreground ?? windowBinding.foreground,
          ...(foregroundWindow === undefined ? {} : { foregroundWindow }),
        };
      },
      getForegroundIdentity: async () => ({ hwnd: "10", processId: 10 }),
      getForegroundWindowBinding: async () => windowBinding,
      click: async ({ point }) => {
        clickedPoints.push({ x: point.x, y: point.y });
        return "sent";
      },
      move: async () => "sent",
      mouseHold: async () => "sent",
      drag: async () => "sent",
      type: async () => "sent",
      keypress: async () => "sent",
      scroll: async () => "sent",
      wait: async () => "sent",
    };
    const runtime = await testRuntime(
      () => [(pi) => {
        pi.on("tool_result", (event) => {
          if (stripComputerResult && event.toolName === "computer") {
            return { content: [{ type: "text", text: "extension removed observation" }] };
          }
        });
      }],
      undefined,
      async (modelRuntime) => {
        modelRuntime.registerProvider("computer-vision", {
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [{
            ...providerModel("computer-vision"),
            input: ["text", "image"],
          }],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
      () => settings,
      { createWindowsDesktopAdapter: async () => adapter },
    );
    const owner = {};
    const created = await runtime.createSession(cwd, {
      toolMode: "full_access",
      model: { provider: "computer-vision", id: "computer-vision" },
      computerUse: { getOwner: () => owner },
      sessionManager,
    });
    const computer = created.session.getToolDefinition("computer");
    if (!computer || !created.computerUse) throw new Error("Computer tool was not installed");
    const execute = computer.execute as (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
    ) => Promise<ComputerToolResult>;
    const signal = new AbortController().signal;
    const installedComputerConverter = created.session.agent.convertToLlm;

    try {
      const beforePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString("base64");
      const afterPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]).toString("base64");
      const observed = await execute("observe-call", {
        actions: [],
        observe: true,
        foregroundWindow: true,
      }, signal);
      expect(observed.content).toEqual([
        expect.objectContaining({ type: "text" }),
        {
          type: "text",
          text: "[computer observation current; scope=foreground_window; size=10x10 px]",
        },
        { type: "image", mimeType: "image/png", data: beforePng },
      ]);
      const observeCall = {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "observe-call",
          name: "computer",
          arguments: { actions: [], observe: true, foregroundWindow: true },
        }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "toolUse",
        timestamp: 0,
      };
      const source = {
        role: "toolResult",
        toolCallId: "observe-call",
        toolName: "computer",
        content: observed.content,
        isError: false,
        timestamp: 1,
      };
      const persistedSource = { ...source, details: observed.details };
      created.session.sessionManager.appendMessage(observeCall as never);
      const imageEntryId = created.session.sessionManager.appendMessage(
        persistedSource as never,
      );

      // JSONL/provider context owns the bytes, while bounded wire history keeps
      // only a locator and a shape-only image marker.
      expect(JSON.stringify(persistedSource)).toContain(beforePng);
      const historyJson = JSON.stringify(projectConversationHistory(created.session.sessionManager));
      expect(historyJson).not.toContain(beforePng);
      expect(historyJson).toContain("resultImageRefs");
      expect(historyJson).toContain(imageEntryId);

      const providerInput = await created.session.agent.convertToLlm([
        observeCall,
        persistedSource,
      ] as never);
      const providerJson = JSON.stringify(providerInput);
      expect(providerJson).toContain(beforePng);
      expect(providerJson).toContain("[computer observation current; scope=foreground_window; size=10x10 px]");
      expect(providerJson).not.toContain("\\\"hwnd\\\"");
      expect(providerJson).not.toContain("\\\"rawBounds\\\"");

      const sessionFile = sessionManager.getSessionFile();
      if (!sessionFile) throw new Error("Computer image session was not persisted");
      expect(await readFile(sessionFile, "utf8")).toContain(beforePng);
      const reopened = SessionManager.open(sessionFile, cwd, cwd);
      expect(await created.session.agent.convertToLlm(
        reopened.buildSessionContext().messages,
      )).toEqual(providerInput);

      created.computerUse.completeAssistantDecision([
        "rejected-before-execute",
        "admitted-sibling",
      ]);

      // Promoting the transient coordinate capability must not rewrite durable
      // history: a retry converts to byte-for-byte equivalent model input.
      expect(await created.session.agent.convertToLlm([
        observeCall,
        persistedSource,
      ] as never)).toEqual(providerInput);

      // A malformed sibling reaches no primitive and leaves the same exact
      // assistant decision's authorized frame intact.
      await expect(execute("rejected-before-execute", {
        actions: [{ kind: "click", x: "not-a-coordinate", y: 1 }],
        observe: false,
      }, signal)).rejects.toThrow("integer");
      const after = await execute("admitted-sibling", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: true,
        foregroundWindow: true,
        settleMs: 0,
      }, signal);
      expect(after.details).toMatchObject({
        outcome: "completed",
        observation: { status: "captured", width: 20, height: 5 },
      });
      expect(after.content).toContainEqual({
        type: "text",
        text: "[computer observation after action batch; scope=foreground_window; size=20x5 px]",
      });
      expect(after.content).toContainEqual({
        type: "image",
        mimeType: "image/png",
        data: afterPng,
      });
      expect(JSON.stringify(after.content)).not.toContain(beforePng);

      const actionCall = {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "admitted-sibling",
          name: "computer",
          arguments: {
            actions: [{ kind: "click", x: 1, y: 1 }],
            observe: true,
            foregroundWindow: true,
            settleMs: 0,
          },
        }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "toolUse",
        timestamp: 2,
      };
      const afterSource = {
        ...persistedSource,
        toolCallId: "admitted-sibling",
        content: after.content,
        details: after.details,
        timestamp: 3,
      };
      const extendedProviderInput = await created.session.agent.convertToLlm([
        observeCall,
        persistedSource,
        actionCall,
        afterSource,
      ] as never);
      expect(extendedProviderInput.slice(0, providerInput.length)).toEqual(providerInput);
      const extendedJson = JSON.stringify(extendedProviderInput);
      expect(extendedJson.split(beforePng)).toHaveLength(2);
      expect(extendedJson.split(afterPng)).toHaveLength(2);
      expect(extendedJson).not.toContain("\"hwnd\"");
      expect(extendedJson).not.toContain("\"processId\"");
      await expect(execute("sibling-after-admission", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }, signal)).resolves.toMatchObject({
        details: { outcome: "rejected", reason: "decision_consumed" },
      });

      // A new assistant decision can use B. If its exact call is rejected before
      // controller admission, the following decision retires B rather than
      // carrying stale coordinates forward.
      created.computerUse.completeAssistantDecision(["unexecuted-next-decision"]);
      await expect(execute("unexecuted-next-decision", {
        actions: [{ kind: "click", x: "not-a-coordinate", y: 1 }],
        observe: false,
      }, signal)).rejects.toThrow("integer");
      created.computerUse.completeAssistantDecision(["stale-frame-call"]);
      await expect(execute("stale-frame-call", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }, signal)).rejects.toThrow("authorized current observation");

      // An already-aborted invocation reaches no primitive and leaves another
      // exact sibling from the same decision usable.
      const observedThird = await execute("observe-aborted", { actions: [], observe: true }, signal);
      await created.session.agent.convertToLlm([{
        ...source,
        toolCallId: "observe-aborted",
        content: observedThird.content,
      }] as never);
      created.computerUse.completeAssistantDecision([
        "aborted-before-admission",
        "after-abort-sibling",
      ]);
      const aborted = new AbortController();
      aborted.abort();
      await expect(execute("aborted-before-admission", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }, aborted.signal)).resolves.toMatchObject({ details: { outcome: "interrupted" } });
      await expect(execute("after-abort-sibling", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }, signal)).resolves.toMatchObject({ details: { outcome: "completed" } });

      // Blocking image delivery at either decision completion or execution
      // retires any frame that the model can no longer be trusted to have seen.
      created.computerUse.completeAssistantDecision(["observe-before-policy-block"]);
      await execute("observe-before-policy-block", { actions: [], observe: true }, signal);
      settings.setBlockImages(true);
      created.computerUse.completeAssistantDecision(["not-authorized-while-blocked"]);
      settings.setBlockImages(false);
      await expect(execute("not-authorized-while-blocked", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }, signal)).rejects.toThrow("authorized current observation");

      created.computerUse.completeAssistantDecision(["observe-before-execution-block"]);
      await execute("observe-before-execution-block", { actions: [], observe: true }, signal);
      created.computerUse.completeAssistantDecision([
        "blocked-after-authorization",
        "sibling-after-block",
      ]);
      settings.setBlockImages(true);
      await expect(execute("blocked-after-authorization", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }, signal)).rejects.toThrow("image delivery to be enabled");
      settings.setBlockImages(false);
      await expect(execute("sibling-after-block", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }, signal)).rejects.toThrow("authorized current observation");

      // Normalize before Pi's own afterToolCall pass so a >2000px capture is
      // persisted unchanged by the SDK and coordinates use displayed pixels.
      const largePng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAB9EAAAABCAYAAABpP15DAAAAH0lEQVR4nO3DAQ0AAADCoPcvrUVgo2qqqqqqqqqqmjuIfsmZmN+U4AAAAABJRU5ErkJggg==",
        "base64",
      );
      const largeBounds = { x: 0, y: 0, width: 2001, height: 1 };
      adapter.capture = async (scope) => ({
        png: largePng,
        width: largeBounds.width,
        height: largeBounds.height,
        scope,
        captureBounds: largeBounds,
        inputBounds: largeBounds,
        foreground: windowBinding.foreground,
      });
      created.computerUse.clearObservation();
      const normalizedResult = await execute(
        "large-observe",
        { actions: [], observe: true },
        signal,
      );
      expect(normalizedResult.details.observation).toEqual({
        status: "captured",
        width: 2000,
        height: 1,
      });
      expect(normalizedResult.content).toContainEqual({
        type: "text",
        text: "[computer observation current; scope=primary_display; size=2000x1 px]",
      });
      const afterToolCall = created.session.agent.afterToolCall;
      if (!afterToolCall) throw new Error("Computer result boundary was not installed");
      const normalizedPatch = await afterToolCall({
        toolCall: { id: "large-observe", name: "computer" },
        args: { actions: [], observe: true },
        result: normalizedResult,
        isError: false,
      } as Parameters<typeof afterToolCall>[0], signal);
      expect(normalizedPatch?.content ?? normalizedResult.content).toEqual(
        normalizedResult.content,
      );
      await created.session.agent.convertToLlm([{
        ...source,
        toolCallId: "large-observe",
        content: normalizedResult.content,
      }] as never);
      created.computerUse.completeAssistantDecision([
        "outside-normalized-image",
        "normalized-image-edge",
      ]);
      await expect(execute("outside-normalized-image", {
        actions: [{ kind: "click", x: 2000, y: 0 }],
        observe: false,
      }, signal)).rejects.toThrow("outside the current observation");
      await execute("normalized-image-edge", {
        actions: [{ kind: "click", x: 1999, y: 0 }],
        observe: false,
      }, signal);
      expect(clickedPoints.at(-1)).toEqual({ x: 2000, y: 0 });

      // A context/message-end rewrite is detected at the final converter
      // boundary even when the earlier tool-result hook kept the image.
      created.computerUse.completeAssistantDecision(["presentation-source"]);
      const presentationSource = await execute(
        "presentation-source",
        { actions: [], observe: true },
        signal,
      );
      await created.session.agent.convertToLlm([{
        ...source,
        toolCallId: "presentation-source",
        content: [{ type: "text", text: "image removed before provider conversion" }],
      }] as never);
      created.computerUse.completeAssistantDecision(["after-missing-presentation"]);
      await expect(execute("after-missing-presentation", {
        actions: [{ kind: "click", x: 1, y: 0 }],
        observe: false,
      }, signal)).rejects.toThrow("authorized current observation");
      expect(presentationSource.content.some((part) => part.type === "image")).toBe(true);

      // Keeping the same details/label/MIME is insufficient when the image
      // bytes differ from the exact pending frame.
      created.computerUse.completeAssistantDecision(["hash-source"]);
      const hashSource = await execute("hash-source", {
        actions: [],
        observe: true,
      }, signal);
      const changedImageContent = hashSource.content.map((part) => (
        part.type === "image"
          ? { ...part, data: largePng.toString("base64") }
          : { ...part }
      ));
      await created.session.agent.convertToLlm([{
        ...source,
        toolCallId: "hash-source",
        content: changedImageContent,
      }] as never);
      created.computerUse.completeAssistantDecision(["after-changed-image"]);
      await expect(execute("after-changed-image", {
        actions: [{ kind: "click", x: 1, y: 0 }],
        observe: false,
      }, signal)).rejects.toThrow("authorized current observation");

      // The structured details text is part of the same coordinate contract.
      created.computerUse.completeAssistantDecision(["details-source"]);
      const detailsSource = await execute("details-source", {
        actions: [],
        observe: true,
      }, signal);
      const changedDetailsContent = detailsSource.content.map((part, index) => (
        index === 0 && part.type === "text"
          ? { ...part, text: "{}" }
          : { ...part }
      ));
      await created.session.agent.convertToLlm([{
        ...source,
        toolCallId: "details-source",
        content: changedDetailsContent,
      }] as never);
      created.computerUse.completeAssistantDecision(["after-changed-details"]);
      await expect(execute("after-changed-details", {
        actions: [{ kind: "click", x: 1, y: 0 }],
        observe: false,
      }, signal)).rejects.toThrow("authorized current observation");

      // Project hooks may alter ordinary tool results, but a changed computer
      // image/label cannot leave authority for coordinates the model did not see.
      created.computerUse.completeAssistantDecision(["observe-before-result-hook"]);
      const guardedResult = await execute(
        "observe-before-result-hook",
        { actions: [], observe: true },
        signal,
      );
      stripComputerResult = true;
      await expect(afterToolCall({
        toolCall: { id: "observe-before-result-hook", name: "computer" },
        args: { actions: [], observe: true },
        result: guardedResult,
        isError: false,
      } as Parameters<typeof afterToolCall>[0], signal)).rejects.toThrow(
        "Computer observation content was modified after capture",
      );
      stripComputerResult = false;
      created.computerUse.completeAssistantDecision(["after-modified-result"]);
      await expect(execute("after-modified-result", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }, signal)).rejects.toThrow("authorized current observation");

      // An oversized capture that cannot be decoded must never fall through
      // to Pi's pass-through-on-normalization-failure behavior.
      adapter.capture = async (scope) => ({
        png: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 99]),
        width: largeBounds.width,
        height: largeBounds.height,
        scope,
        captureBounds: largeBounds,
        inputBounds: largeBounds,
        foreground: windowBinding.foreground,
      });
      created.computerUse.completeAssistantDecision(["invalid-large-observe"]);
      await expect(execute("invalid-large-observe", {
        actions: [],
        observe: true,
      }, signal)).rejects.toThrow(
        "Computer observation could not be normalized for image delivery",
      );
      created.computerUse.completeAssistantDecision(["after-invalid-large"]);
      await expect(execute("after-invalid-large", {
        actions: [{ kind: "click", x: 1, y: 0 }],
        observe: false,
      }, signal)).rejects.toThrow("authorized current observation");
    } finally {
      await created.dispose();
      expect(created.session.agent.convertToLlm).not.toBe(installedComputerConverter);
    }
  });

  it("loads project providers before resolving a fixed role model and appends the role prompt", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-services-role-");
    const credentialStore = new InMemoryCredentialStore();
    const tools = [workbenchTool(cwd)];
    let received: Parameters<typeof createAgentSessionFromServices>[0] | undefined;
    const runtime = await PiRuntime.create({
      credentialStore,
      modelsStore: new InMemoryModelsStore(),
      createModelsStore: () => new InMemoryModelsStore(),
      createSettings: () => SettingsManager.inMemory(),
      createServices: (options) => createAgentSessionServices({
        ...options,
        agentDir: cwd,
        resourceLoaderOptions: {
          ...options.resourceLoaderOptions,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          appendSystemPrompt: ["project append prompt"],
          extensionFactories: [
            (pi) => {
              pi.registerProvider("project-role-provider", {
                baseUrl: "https://example.invalid/v1",
                apiKey: "project-role-key",
                api: "openai-completions",
                models: [{
                  ...providerModel("project-role-model"),
                  reasoning: true,
                }],
              });
            },
          ],
        },
      }),
      createSessionFromServices: async (options) => {
        received = options;
        return createAgentSessionFromServices(options);
      },
    });

    const created = await runtime.createSession(cwd, {
      model: { provider: "project-role-provider", id: "project-role-model" },
      thinkingLevel: "high",
      roleSystemPrompt: "role append prompt",
      workbenchCustomTools: tools,
    });

    expect(received?.model).toMatchObject({
      provider: "project-role-provider",
      id: "project-role-model",
    });
    expect(received?.thinkingLevel).toBe("high");
    expect(received?.customTools).toBe(tools);
    expect(created.session.systemPrompt).toContain("project append prompt");
    expect(created.session.systemPrompt).toContain("role append prompt");
    expect(created.session.thinkingLevel).toBe("high");
    expect(created.session.systemPrompt.indexOf("project append prompt")).toBeLessThan(
      created.session.systemPrompt.indexOf("role append prompt"),
    );
    expect(created.session.getActiveToolNames()).toContain("workbench_meta");
    await created.dispose();
  });

  it("loads a project model catalog without creating or activating an AgentSession", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-project-catalog-");
    const credentialStore = new InMemoryCredentialStore();
    let catalogRefreshes = 0;
    let sessionCreations = 0;
    let sessionStarts = 0;
    const createModelRuntime = async (options: CreateModelRuntimeOptions) => {
      const runtime = await ModelRuntime.create({ ...options, modelsPath: null });
      const nativeRefresh = runtime.refresh.bind(runtime);
      runtime.refresh = async (refreshOptions) => {
        catalogRefreshes++;
        return nativeRefresh(refreshOptions);
      };
      return runtime;
    };
    const runtime = await PiRuntime.create({
      credentialStore,
      modelsStore: new InMemoryModelsStore(),
      createModelsStore: () => new InMemoryModelsStore(),
      createModelRuntime,
      createSettings: () => SettingsManager.inMemory(),
      createServices: (options) => createAgentSessionServices({
        ...options,
        agentDir: cwd,
        resourceLoaderOptions: {
          ...options.resourceLoaderOptions,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [
            (pi) => {
              pi.registerProvider("catalog-provider", {
                baseUrl: "https://example.invalid/v1",
                apiKey: "catalog-key",
                api: "openai-completions",
                models: [providerModel("catalog-model")],
              });
              pi.on("session_start", () => {
                sessionStarts++;
              });
            },
          ],
        },
      }),
      createSessionFromServices: async (options) => {
        sessionCreations++;
        return createAgentSessionFromServices(options);
      },
    });

    const catalog = await runtime.createProjectModelCatalog(cwd);
    expect(catalog.modelRegistry.find(
      "catalog-provider",
      "catalog-model",
    )).toBeDefined();
    expect(catalog.modelRegistry.getAvailable()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "catalog-provider",
        id: "catalog-model",
      }),
    ]));
    expect(catalog.dynamicProviderNames()).toContain("catalog-provider");
    expect({ sessionCreations, sessionStarts }).toEqual({
      sessionCreations: 0,
      sessionStarts: 0,
    });

    catalogRefreshes = 0;
    await runtime.refreshConfiguration();
    expect(catalogRefreshes).toBe(2);
    expect(catalog.modelRegistry.find(
      "catalog-provider",
      "catalog-model",
    )).toBeDefined();

    await catalog.dispose();
    await catalog.dispose();
    await runtime.refreshConfiguration();
    expect(catalogRefreshes).toBe(3);
  });

  it("fails closed before session creation when the fixed model is missing or unauthenticated", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-role-model-guard-");
    let factoryCalls = 0;
    const runtime = await testRuntime(
      () => [],
      async () => {
        factoryCalls++;
      },
      async (modelRuntime) => {
        modelRuntime.registerProvider("unconfigured-role-provider", {
          baseUrl: "https://example.invalid/v1",
          apiKey: "$PIWEB_RUNTIME_TEST_KEY_THAT_IS_NOT_CONFIGURED",
          api: "openai-completions",
          models: [providerModel("unconfigured-role-model")],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
    );

    await expect(runtime.createSession(cwd, {
      model: { provider: "missing-provider", id: "missing-model" },
    })).rejects.toThrow("is not available");
    await expect(runtime.createSession(cwd, {
      model: {
        provider: "unconfigured-role-provider",
        id: "unconfigured-role-model",
      },
    })).rejects.toThrow("has no configured authentication");
    expect(factoryCalls).toBe(0);
  });

  it("tears down when session creation falls back from the fixed role model", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-role-fallback-");
    let disposals = 0;
    const runtime = await testRuntime(
      () => [],
      async (created) => {
        const fallback = created.session.modelRuntime.getModel(
          "fixed-role-provider",
          "fallback-model",
        );
        if (!fallback) throw new Error("fallback model missing");
        created.session.agent.state.model = fallback;
        const nativeDispose = created.session.dispose.bind(created.session);
        created.session.dispose = () => {
          disposals++;
          nativeDispose();
        };
      },
      async (modelRuntime) => {
        modelRuntime.registerProvider("fixed-role-provider", {
          baseUrl: "https://example.invalid/v1",
          apiKey: "fixed-key",
          api: "openai-completions",
          models: [
            providerModel("fixed-role-model"),
            providerModel("fallback-model"),
          ],
        });
        await modelRuntime.refresh({ allowNetwork: false });
      },
    );

    await expect(runtime.createSession(cwd, {
      model: { provider: "fixed-role-provider", id: "fixed-role-model" },
    })).rejects.toThrow("did not retain its fixed model");
    expect(disposals).toBe(1);
  });

  it("resolves project trust before loading protected project resources", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-trust-project-");
    const agentDir = await temporaryDirectory("piweb-runtime-trust-agent-");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), "{}\n", "utf8");
    const remembered = new Map<string, boolean>();
    let offeredOptions: string[] = [];
    const credentialStore = new InMemoryCredentialStore();
    const runtime = await PiRuntime.create({
      credentialStore,
      modelsStore: new InMemoryModelsStore(),
      createModelsStore: () => new InMemoryModelsStore(),
      createSettings: (projectCwd) => SettingsManager.create(
        projectCwd,
        agentDir,
        { projectTrusted: false },
      ),
      createServices: (options) => createAgentSessionServices({
        ...options,
        agentDir,
      }),
      projectTrustStore: {
        get: (projectCwd) => remembered.get(projectCwd) ?? null,
        set: (projectCwd, trusted) => {
          if (trusted === null) remembered.delete(projectCwd);
          else remembered.set(projectCwd, trusted);
        },
      },
    });
    const created = await runtime.createSession(cwd, {
      extensionUI: {
        select: async (_title, options) => {
          offeredOptions = options;
          return options.find((option) => option === "信任此项目并记住");
        },
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
        notify: () => undefined,
      },
    });

    expect(offeredOptions).toEqual([
      "信任此项目并记住",
      "仅本次信任",
      "不信任此项目并记住",
      "仅本次不信任",
    ]);
    expect(remembered.get(cwd)).toBe(true);
    expect(created.settings.isProjectTrusted()).toBe(true);
    await created.dispose();
  });

  it("fails project trust closed when protected resources have no interactive decision", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-untrusted-project-");
    const agentDir = await temporaryDirectory("piweb-runtime-untrusted-agent-");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), "{}\n", "utf8");
    const credentialStore = new InMemoryCredentialStore();
    const runtime = await PiRuntime.create({
      credentialStore,
      modelsStore: new InMemoryModelsStore(),
      createModelsStore: () => new InMemoryModelsStore(),
      createSettings: (projectCwd) => SettingsManager.create(
        projectCwd,
        agentDir,
        { projectTrusted: false },
      ),
      createServices: (options) => createAgentSessionServices({
        ...options,
        agentDir,
      }),
      projectTrustStore: {
        get: () => null,
        set: () => undefined,
      },
    });

    const created = await runtime.createSession(cwd);

    expect(created.settings.isProjectTrusted()).toBe(false);
    await created.dispose();
  });

  it("registers project providers before restoring a persisted model", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-restore-provider-");
    const credentialStore = new InMemoryCredentialStore();
    const manager = SessionManager.inMemory(cwd);
    manager.appendModelChange("restored-provider", "restored-model");
    manager.appendCustomMessageEntry("restore-test", "saved context", false);
    const runtime = await PiRuntime.create({
      credentialStore,
      modelsStore: new InMemoryModelsStore(),
      createModelsStore: () => new InMemoryModelsStore(),
      createSettings: () => SettingsManager.inMemory(),
      createServices: (options) => createAgentSessionServices({
        ...options,
        agentDir: cwd,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [
            (pi) => {
              pi.registerProvider("restored-provider", {
                baseUrl: "https://example.invalid/v1",
                apiKey: "dummy",
                api: "openai-completions",
                models: [providerModel("restored-model")],
              });
            },
          ],
        },
      }),
    });

    const created = await runtime.createSession(cwd, { sessionManager: manager });

    expect(created.session.model).toMatchObject({
      provider: "restored-provider",
      id: "restored-model",
    });
    expect(created.modelRegistry.find("restored-provider", "restored-model")).toBeDefined();
    expect(runtime.modelRegistry.find("restored-provider", "restored-model")).toBeUndefined();
    await created.dispose();
  });

  it("releases the isolated registry when two-stage session creation fails", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-create-failure-");
    const manager = SessionManager.inMemory(cwd);
    const nativeAppendCompaction = manager.appendCompaction;
    const credentialStore = new InMemoryCredentialStore();
    let ownerRefreshes = 0;
    const createModelRuntime = async (options: CreateModelRuntimeOptions) => {
      const runtime = await ModelRuntime.create({ ...options, modelsPath: null });
      const refresh = runtime.refresh.bind(runtime);
      runtime.refresh = async (refreshOptions) => {
        ownerRefreshes++;
        return refresh(refreshOptions);
      };
      return runtime;
    };
    const runtime = await PiRuntime.create({
      credentialStore,
      modelsStore: new InMemoryModelsStore(),
      createModelsStore: () => new InMemoryModelsStore(),
      createModelRuntime,
      createSettings: () => SettingsManager.inMemory(),
      createServices: (options) => createAgentSessionServices({
        ...options,
        agentDir: cwd,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      }),
      createSessionFromServices: async () => {
        throw new Error("second-stage creation failed");
      },
    });

    await expect(runtime.createSession(cwd, { sessionManager: manager })).rejects.toThrow(
      "second-stage creation failed",
    );
    expect(Object.hasOwn(manager, "appendCompaction")).toBe(false);
    expect(manager.appendCompaction).toBe(nativeAppendCompaction);
    ownerRefreshes = 0;
    await runtime.refreshConfiguration();
    expect(ownerRefreshes).toBe(1);
  });

  it.each([
    {
      stage: "model binding",
      expectedError: "model binding failed",
      installFailure(created: Awaited<ReturnType<typeof createAgentSession>>) {
        created.session.modelRuntime.getModel = () => {
          throw new Error("model binding failed");
        };
      },
      toolCallGate: undefined,
      contextBudget: false,
    },
    {
      stage: "tool result compression installation",
      expectedError: "tool result compression installation failed",
      installFailure(created: Awaited<ReturnType<typeof createAgentSession>>) {
        const nativeAgent = created.session.agent;
        Object.defineProperty(created.session, "agent", {
          configurable: true,
          value: new Proxy(nativeAgent, {
            set(target, property, value, receiver) {
              if (property === "afterToolCall") {
                throw new Error("tool result compression installation failed");
              }
              return Reflect.set(target, property, value, receiver);
            },
          }),
        });
      },
      toolCallGate: undefined,
      contextBudget: false,
    },
    {
      stage: "context budget installation",
      expectedError: "context budget installation failed",
      installFailure(created: Awaited<ReturnType<typeof createAgentSession>>) {
        const nativeAgent = created.session.agent;
        Object.defineProperty(created.session, "agent", {
          configurable: true,
          value: new Proxy(nativeAgent, {
            set(target, property, value, receiver) {
              if (property === "convertToLlm") {
                throw new Error("context budget installation failed");
              }
              return Reflect.set(target, property, value, receiver);
            },
          }),
        });
      },
      toolCallGate: undefined,
      contextBudget: true,
    },
    {
      stage: "tool gate installation",
      expectedError: "tool gate installation failed",
      installFailure(created: Awaited<ReturnType<typeof createAgentSession>>) {
        const nativeAgent = created.session.agent;
        Object.defineProperty(created.session, "agent", {
          configurable: true,
          value: new Proxy(nativeAgent, {
            set(target, property, value, receiver) {
              if (property === "beforeToolCall") {
                throw new Error("tool gate installation failed");
              }
              return Reflect.set(target, property, value, receiver);
            },
          }),
        });
      },
      toolCallGate: async () => undefined,
      contextBudget: false,
    },
    {
      stage: "extension load error projection",
      expectedError: "extension error projection failed",
      installFailure(created: Awaited<ReturnType<typeof createAgentSession>>) {
        Object.defineProperty(created.extensionsResult, "errors", {
          configurable: true,
          get: () => {
            throw new Error("extension error projection failed");
          },
        });
      },
      toolCallGate: undefined,
      contextBudget: true,
    },
  ])("cleans up a created session when $stage fails", async ({
    expectedError,
    installFailure,
    toolCallGate,
    contextBudget,
  }) => {
    const cwd = await temporaryDirectory("piweb-runtime-assembly-failure-");
    let disposals = 0;
    let ownerRefreshes = 0;
    let originalConverter: unknown;
    const runtime = await testRuntime(
      () => [],
      async (created) => {
        originalConverter = created.session.agent.convertToLlm;
        const nativeDispose = created.session.dispose.bind(created.session);
        created.session.dispose = () => {
          expect(created.session.agent.convertToLlm).toBe(originalConverter);
          disposals++;
          nativeDispose();
        };
        const modelRuntime = created.session.modelRuntime;
        const nativeRefresh = modelRuntime.refresh.bind(modelRuntime);
        modelRuntime.refresh = async (refreshOptions) => {
          ownerRefreshes++;
          return nativeRefresh(refreshOptions);
        };
        installFailure(created);
      },
    );

    await expect(runtime.createSession(cwd, {
      toolCallGate,
      getLoopList: contextBudget
        ? () => ({
            items: [{ id: "test", text: "Test", status: "active" }],
            armed: true,
          })
        : undefined,
      getCompactionThresholdPercent: contextBudget ? () => 70 : undefined,
    })).rejects.toThrow(expectedError);
    const refreshError = await runtime.refreshConfiguration().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect({ disposals, ownerRefreshes, refreshError }).toEqual({
      disposals: 1,
      ownerRefreshes: 0,
      refreshError: undefined,
    });
  });

  it("binds extension lifecycle, surfaces errors, and isolates project providers", async () => {
    const cwdA = await temporaryDirectory("piweb-runtime-a-");
    const cwdB = await temporaryDirectory("piweb-runtime-b-");
    let starts = 0;
    let shutdowns = 0;
    const runtime = await testRuntime((cwd) => cwd === cwdA
      ? [
          (pi) => {
            pi.registerProvider("project-a", {
              baseUrl: "https://example.invalid/v1",
              apiKey: "dummy",
              api: "openai-completions",
              models: [providerModel("project-a-model")],
            });
            pi.on("session_start", () => {
              starts++;
            });
            pi.on("session_shutdown", () => {
              shutdowns++;
            });
            pi.registerCommand("boom", {
              description: "throw from an extension command",
              handler: () => {
                throw new Error("extension exploded");
              },
            });
          },
        ]
      : []);

    const sessionA = await runtime.createSession(cwdA);
    await sessionA.activateExtensions();
    const extensionErrors: string[] = [];
    expect(sessionA.activateExtensionErrors((error) => extensionErrors.push(error.error))).toEqual([]);
    expect(starts).toBe(1);
    expect(sessionA.modelRegistry.find("project-a", "project-a-model")).toBeDefined();
    expect(runtime.modelRegistry.find("project-a", "project-a-model")).toBeUndefined();

    const sessionB = await runtime.createSession(cwdB);
    await sessionB.activateExtensions();
    sessionB.activateExtensionErrors(() => undefined);
    expect(sessionB.modelRegistry.find("project-a", "project-a-model")).toBeUndefined();

    await sessionA.session.prompt("/boom");
    expect(extensionErrors).toContain("extension exploded");

    await sessionA.dispose();
    expect(shutdowns).toBe(1);
    await sessionB.dispose();
  });

  it("binds portable extension UI in rpc mode and fails closed for host-owned session actions", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-extension-ui-");
    const observations: unknown[] = [];
    const runtime = await testRuntime(() => [
      (pi: ExtensionAPI) => {
        pi.on("session_start", async (_event, ctx) => {
          observations.push(ctx.mode, ctx.hasUI);
          observations.push(await ctx.ui.select("Profile", ["safe", "fast"]));
          observations.push(await ctx.ui.confirm("Confirm", "Continue?"));
          observations.push(await ctx.ui.input("Name"));
          observations.push(await ctx.ui.editor("Draft", "seed"));
          ctx.ui.notify("ready", "info");
        });
        pi.registerCommand("host-actions", {
          description: "exercise host-owned actions",
          handler: async (_args, ctx) => {
            observations.push(await ctx.newSession());
            observations.push(await ctx.fork("entry"));
            observations.push(await ctx.navigateTree("entry"));
            observations.push(await ctx.switchSession("session.jsonl"));
            try {
              await ctx.reload();
            } catch (error) {
              observations.push(error instanceof Error ? error.message : String(error));
            }
          },
        });
      },
    ]);
    const notifications: string[] = [];
    const created = await runtime.createSession(cwd, {
      extensionUI: {
        select: async () => "safe",
        confirm: async () => true,
        input: async () => "Ada",
        editor: async (_title, prefill) => `${prefill}:edited`,
        notify: (message) => notifications.push(message),
      },
    });

    await created.activateExtensions();
    await created.session.prompt("/host-actions");

    expect(observations).toEqual([
      "rpc",
      true,
      "safe",
      true,
      "Ada",
      "seed:edited",
      { cancelled: true },
      { cancelled: true },
      { cancelled: true },
      { cancelled: true },
      "Extension reload is not supported by this workbench",
    ]);
    expect(notifications).toEqual(["ready"]);
    await created.dispose();
  });

  it("fails initialization when an extension requests a process-global provider", async () => {
    const cwdA = await temporaryDirectory("piweb-runtime-global-");
    const cwdB = await temporaryDirectory("piweb-runtime-clean-");
    const runtime = await testRuntime((cwd) => cwd === cwdA
      ? [
          (pi) => {
            pi.registerProvider("unsafe-stream", {
              baseUrl: "https://example.invalid/v1",
              apiKey: "dummy",
              api: "piweb-test-stream",
              streamSimple: () => {
                throw new Error("not called");
              },
              models: [providerModel("unsafe-model")],
            });
          },
        ]
      : []);

    await expect(runtime.createProjectModelCatalog(cwdA)).rejects.toThrow(
      "Pi session services reported errors",
    );
    await expect(runtime.createSession(cwdA)).rejects.toThrow(
      "Pi session services reported errors",
    );

    const clean = await runtime.createSession(cwdB);
    await clean.activateExtensions();
    clean.activateExtensionErrors(() => undefined);
    expect(clean.modelRegistry.find("unsafe-stream", "unsafe-model")).toBeUndefined();
    await clean.dispose();
  });

  it("rejects native provider registrations before session creation", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-unsafe-native-");
    const runtime = await PiRuntime.create({
      credentialStore: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      createModelsStore: () => new InMemoryModelsStore(),
      createSettings: () => SettingsManager.inMemory(),
      createServices: async (options) => {
        options.modelRuntime.registerNativeProvider({ id: "unsafe-native" } as never);
        return createAgentSessionServices(options);
      },
    });

    await expect(runtime.createProjectModelCatalog(cwd)).rejects.toThrow(
      "Extension native provider",
    );
  });

  it("rejects refreshModels provider registrations before session creation", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-unsafe-refresh-");
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.registerProvider("unsafe-refresh", {
          models: [providerModel("unsafe-refresh-model")],
          refreshModels: async () => [],
        });
      },
    ]);

    await expect(runtime.createProjectModelCatalog(cwd)).rejects.toThrow(
      "Pi session services reported errors",
    );
  });

  it("commits only the latest one-shot credential intent per provider", async () => {
    const runtime = await testRuntime(() => []);
    const applied: string[] = [];
    const older = runtime.beginCredentialChange("provider-a");
    const independent = runtime.beginCredentialChange("provider-b");
    const newer = runtime.beginCredentialChange("provider-a");

    await expect(runtime.commitCredentialChange(older, () => {
      applied.push("older");
    })).resolves.toBe(false);
    await expect(runtime.commitCredentialChange(independent, () => {
      applied.push("independent");
    })).resolves.toBe(true);
    await expect(runtime.commitCredentialChange(newer, () => {
      applied.push("newer");
    })).resolves.toBe(true);
    await expect(runtime.commitCredentialChange(newer, () => {
      applied.push("reused");
    })).resolves.toBe(false);

    const failing = runtime.beginCredentialChange("provider-a");
    await expect(runtime.commitCredentialChange(failing, () => {
      throw new Error("credential write failed");
    })).rejects.toThrow("credential write failed");
    await expect(runtime.commitCredentialChange(failing, () => {
      applied.push("retried-failure");
    })).resolves.toBe(false);
    const recovery = runtime.beginCredentialChange("provider-a");
    await expect(runtime.commitCredentialChange(recovery, () => {
      applied.push("recovery");
    })).resolves.toBe(true);

    expect(applied).toEqual(["independent", "newer", "recovery"]);
  });

  it("does not let a long configuration flow block session creation or disposal", async () => {
    const cwdA = await temporaryDirectory("piweb-runtime-lock-a-");
    const cwdB = await temporaryDirectory("piweb-runtime-lock-b-");
    const runtime = await testRuntime(() => []);
    const first = await runtime.createSession(cwdA);
    await first.activateExtensions();
    first.activateExtensionErrors(() => undefined);
    const changeStarted = deferred();
    const changeGate = deferred();
    const configuration = runtime.updateConfiguration(async () => {
      changeStarted.resolve();
      await changeGate.promise;
    });
    await changeStarted.promise;

    let second;
    try {
      [second] = await within(Promise.all([
        runtime.createSession(cwdB),
        first.dispose(),
      ]), 500);
    } finally {
      changeGate.resolve();
      await configuration;
    }

    await second.activateExtensions();
    second.activateExtensionErrors(() => undefined);
    await second.dispose();
  });

  it("does not rebind a disposed session when an in-flight refresh settles", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-dispose-refresh-");
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.registerProvider("dispose-refresh", {
          baseUrl: "https://before.invalid/v1",
          apiKey: "dummy",
          api: "openai-completions",
          models: [providerModel("dispose-refresh-model")],
        });
      },
    ]);
    const created = await runtime.createSession(cwd);
    const original = created.session.model;
    const refreshStarted = deferred();
    const refreshGate = deferred();
    const refresh = vi.spyOn(created.modelRuntime, "refresh")
      .mockImplementationOnce(async () => {
        refreshStarted.resolve();
        await refreshGate.promise;
        created.modelRuntime.unregisterProvider("dispose-refresh");
        return { aborted: false, errors: new Map() };
      });

    const pendingRefresh = runtime.refreshConfiguration();
    await refreshStarted.promise;
    await within(created.dispose(), 500);
    refreshGate.resolve();
    await pendingRefresh;

    expect(created.session.model).toBe(original);
    refresh.mockRestore();
  });

  it("refreshes every model registry and notifies after one registry fails", async () => {
    const cwdA = await temporaryDirectory("piweb-runtime-refresh-a-");
    const cwdB = await temporaryDirectory("piweb-runtime-refresh-b-");
    const runtime = await testRuntime(() => []);
    const first = await runtime.createSession(cwdA);
    const second = await runtime.createSession(cwdB);
    const owners = [...(runtime as unknown as {
      sessionRegistries: Set<{ refresh(): void }>;
    }).sessionRegistries];
    const firstRefresh = vi.spyOn(owners[0]!, "refresh")
      .mockImplementationOnce(() => {
        throw new Error("first registry refresh failed");
      });
    const secondRefresh = vi.spyOn(owners[1]!, "refresh");
    const baselineRefresh = vi.spyOn(runtime.modelRuntime, "refresh");
    const notified = vi.fn();
    const unsubscribe = runtime.subscribe(notified);

    try {
      await expect(runtime.refreshConfiguration())
        .rejects.toThrow("first registry refresh failed");
      expect(firstRefresh).toHaveBeenCalledOnce();
      expect(secondRefresh).toHaveBeenCalledOnce();
      expect(baselineRefresh).toHaveBeenCalledOnce();
      expect(notified).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      firstRefresh.mockRestore();
      secondRefresh.mockRestore();
      baselineRefresh.mockRestore();
      await first.dispose();
      await second.dispose();
    }
  });

  it("snapshots extension provider config before the extension can mutate it", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-snapshot-");
    let retained: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
    const runtime = await testRuntime(() => [
      (pi) => {
        retained = {
          baseUrl: "https://example.invalid/v1",
          apiKey: "dummy",
          api: "openai-completions",
          models: [providerModel("stable-model")],
        };
        pi.registerProvider("retained-provider", retained);
        pi.on("session_start", () => {
          if (!retained) return;
          retained.models![0]!.id = "mutated-model";
          retained.oauth = {
            name: "Late OAuth",
            login: async () => {
              throw new Error("not called");
            },
            refreshToken: async () => {
              throw new Error("not called");
            },
            getApiKey: () => "late",
          };
        });
      },
    ]);

    const created = await runtime.createSession(cwd);
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    await runtime.refreshConfiguration();

    expect(created.modelRegistry.find("retained-provider", "stable-model")).toBeDefined();
    expect(created.modelRegistry.find("retained-provider", "mutated-model")).toBeUndefined();
    expect(runtime.modelRuntime.isUsingOAuth("retained-provider")).toBe(false);
    await created.dispose();
  });

  it("rebinds the selected model object after registry refresh", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-model-refresh-");
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.registerProvider("refreshable", {
          baseUrl: "https://before.invalid/v1",
          apiKey: "dummy",
          api: "openai-completions",
          models: [providerModel("refreshable-model")],
        });
      },
    ]);
    const created = await runtime.createSession(cwd);
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    const original = created.modelRegistry.find("refreshable", "refreshable-model");
    if (!original) throw new Error("test model was not registered");
    await created.session.setModel(original);

    created.modelRegistry.registerProvider("refreshable", {
      baseUrl: "https://after.invalid/v1",
      apiKey: "dummy",
      api: "openai-completions",
      models: [providerModel("refreshable-model")],
    });
    expect(created.session.model).toBe(original);

    const projectCatalog = await runtime.createProjectModelCatalog(cwd);
    const owners = [...(runtime as unknown as {
      sessionRegistries: Set<{ refresh(options?: unknown): Promise<void> }>;
    }).sessionRegistries];
    const ownerRefreshes = owners.map((owner) => vi.spyOn(owner, "refresh"));
    const baselineRefresh = vi.spyOn(runtime.modelRuntime, "refresh");
    const signal = new AbortController().signal;
    await runtime.refreshConfiguration({ allowNetwork: true, force: true, signal });
    expect(baselineRefresh).toHaveBeenCalledWith({
      allowNetwork: true,
      force: true,
      signal,
    });
    expect(ownerRefreshes).toHaveLength(2);
    for (const ownerRefresh of ownerRefreshes) {
      expect(ownerRefresh).toHaveBeenCalledWith({
        allowNetwork: false,
        force: true,
        signal,
      });
    }
    expect(created.session.model).not.toBe(original);
    expect(created.session.model?.baseUrl).toBe("https://after.invalid/v1");

    const refreshed = created.session.model;
    created.modelRegistry.unregisterProvider("refreshable");
    await runtime.refreshConfiguration();
    expect(created.modelRegistry.find("refreshable", "refreshable-model")).toBeUndefined();
    expect(created.session.model).not.toBe(refreshed);
    for (const ownerRefresh of ownerRefreshes) ownerRefresh.mockRestore();
    baselineRefresh.mockRestore();
    await projectCatalog.dispose();
    await created.dispose();
  });

  it("reconciles a model refreshed while the session factory is still resolving", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-bind-race-");
    const factoryReached = deferred();
    const factoryGate = deferred();
    let nativeSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let originalModel: NonNullable<typeof nativeSession>["model"];
    const runtime = await testRuntime(
      () => [
        (pi) => {
          pi.registerProvider("bind-race", {
            baseUrl: "https://before.invalid/v1",
            apiKey: "dummy",
            api: "openai-completions",
            models: [providerModel("bind-race-model")],
          });
        },
      ],
      async (created) => {
        nativeSession = created.session;
        const model = created.session.modelRuntime.getModel("bind-race", "bind-race-model");
        if (!model) throw new Error("test model was not registered");
        await created.session.setModel(model);
        originalModel = created.session.model;
        factoryReached.resolve();
        await factoryGate.promise;
      },
    );

    const pending = runtime.createSession(cwd);
    await factoryReached.promise;
    nativeSession!.modelRuntime.registerProvider("bind-race", {
      baseUrl: "https://after.invalid/v1",
      apiKey: "dummy",
      api: "openai-completions",
      models: [providerModel("bind-race-model")],
    });
    await runtime.refreshConfiguration();
    expect(nativeSession!.model).toBe(originalModel);

    factoryGate.resolve();
    const created = await pending;
    expect(created.session.model).not.toBe(originalModel);
    expect(created.session.model?.baseUrl).toBe("https://after.invalid/v1");
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    await created.dispose();
  });

  it("does not emit shutdown for a prepared session that was never activated", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-unactivated-");
    let starts = 0;
    let shutdowns = 0;
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("session_start", () => {
          starts++;
        });
        pi.on("session_shutdown", () => {
          shutdowns++;
        });
      },
    ]);

    const created = await runtime.createSession(cwd);
    await created.dispose();
    expect(starts).toBe(0);
    expect(shutdowns).toBe(0);
  });

  it("surfaces extension load errors after the session becomes active", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-load-error-");
    const runtime = await testRuntime(() => [
      () => {
        throw new Error("extension failed to load");
      },
    ]);

    const created = await runtime.createSession(cwd);
    await created.activateExtensions();
    const pending = created.activateExtensionErrors(() => undefined);
    expect(pending).toEqual([
      expect.objectContaining({
        event: "load",
        error: expect.stringContaining("extension failed to load"),
      }),
    ]);
    await created.dispose();
  });

  it("rejects disposal when a shutdown handler fails but still releases the session", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-shutdown-error-");
    let shutdowns = 0;
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("session_shutdown", () => {
          shutdowns++;
          throw new Error("shutdown cleanup failed");
        });
      },
    ]);
    const created = await runtime.createSession(cwd);
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);

    await expect(created.dispose()).rejects.toThrow("Failed to dispose Pi session");
    expect(shutdowns).toBe(1);
    await runtime.refreshConfiguration();
  });

  it("continues teardown when extension error listener registration fails", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-listener-cleanup-");
    let aborts = 0;
    let waits = 0;
    let disposals = 0;
    let ownerRefreshes = 0;
    const runtime = await testRuntime(
      () => [],
      async (created) => {
        const nativeAbort = created.session.abort.bind(created.session);
        created.session.abort = async () => {
          aborts++;
          await nativeAbort();
        };
        const nativeWait = created.session.waitForIdle.bind(created.session);
        created.session.waitForIdle = async () => {
          waits++;
          await nativeWait();
        };
        const nativeDispose = created.session.dispose.bind(created.session);
        created.session.dispose = () => {
          disposals++;
          nativeDispose();
        };
        Object.defineProperty(created.session, "isStreaming", {
          configurable: true,
          get: () => true,
        });
        created.session.extensionRunner.onError = () => {
          throw new Error("extension error listener registration failed");
        };
        const modelRuntime = created.session.modelRuntime;
        const nativeRefresh = modelRuntime.refresh.bind(modelRuntime);
        modelRuntime.refresh = async (refreshOptions) => {
          ownerRefreshes++;
          return nativeRefresh(refreshOptions);
        };
      },
    );
    const created = await runtime.createSession(cwd);

    const disposalError = await created.dispose().then(
      () => undefined,
      (error: unknown) => error,
    );
    await runtime.refreshConfiguration();

    expect(disposalError).toBeInstanceOf(AggregateError);
    expect({ aborts, waits, disposals, ownerRefreshes }).toEqual({
      aborts: 1,
      waits: 1,
      disposals: 1,
      ownerRefreshes: 0,
    });
  });

  it("runs extension tool hooks before the host gate and forces sequential execution", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-tool-gate-");
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("tool_call", (event) => {
          if (event.toolName === "write") event.input.path = "changed-by-extension.ts";
          if (event.toolName === "bash") {
            return { block: true, reason: "blocked by project extension" };
          }
        });
      },
    ]);
    const gated: Array<{ toolName: string; args: unknown }> = [];
    const created = await runtime.createSession(cwd, {
      toolCallGate: async (input) => {
        gated.push({ toolName: input.toolName, args: input.args });
        return { block: true, reason: "blocked by host" };
      },
    });
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    const hook = created.session.agent.beforeToolCall;
    if (!hook) throw new Error("tool hook was not installed");
    type HookContext = Parameters<typeof hook>[0];

    const writeArgs = { path: "original.ts", content: "content" };
    const writeResult = await hook({
      toolCall: {
        type: "toolCall",
        id: "tool-write",
        name: "write",
        arguments: writeArgs,
      },
      args: writeArgs,
    } as unknown as HookContext, new AbortController().signal);

    expect(created.session.agent.toolExecution).toBe("sequential");
    expect(gated).toEqual([{
      toolName: "write",
      args: { path: "changed-by-extension.ts", content: "content" },
    }]);
    expect(writeResult).toEqual({ block: true, reason: "blocked by host" });

    const bashResult = await hook({
      toolCall: {
        type: "toolCall",
        id: "tool-bash",
        name: "bash",
        arguments: { command: "echo unsafe" },
      },
      args: { command: "echo unsafe" },
    } as unknown as HookContext, new AbortController().signal);
    expect(bashResult).toEqual({ block: true, reason: "blocked by project extension" });
    expect(gated).toHaveLength(1);

    const missingSignal = await hook({
      toolCall: {
        type: "toolCall",
        id: "tool-no-signal",
        name: "write",
        arguments: writeArgs,
      },
      args: writeArgs,
    } as unknown as HookContext);
    expect(missingSignal).toEqual({
      block: true,
      reason: "Tool execution guard is unavailable",
    });
    expect(gated).toHaveLength(1);
    await created.dispose();
  });

  it("skips extension hooks when the tool signal is missing or already aborted", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-tool-abort-");
    let extensionCalls = 0;
    let gateCalls = 0;
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("tool_call", async () => {
          extensionCalls++;
          await new Promise<void>(() => undefined);
        });
      },
    ]);
    const created = await runtime.createSession(cwd, {
      toolCallGate: async () => {
        gateCalls++;
        return undefined;
      },
    });
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    const hook = created.session.agent.beforeToolCall;
    if (!hook) throw new Error("tool hook was not installed");
    type HookContext = Parameters<typeof hook>[0];
    const context = {
      toolCall: {
        type: "toolCall",
        id: "tool-aborted",
        name: "bash",
        arguments: { command: "echo unsafe" },
      },
      args: { command: "echo unsafe" },
    } as unknown as HookContext;

    const controller = new AbortController();
    controller.abort();
    await expect(within(hook(context, controller.signal), 200)).resolves.toEqual({
      block: true,
      reason: "Run cancelled before tool execution",
    });
    await expect(within(hook(context), 200)).resolves.toEqual({
      block: true,
      reason: "Tool execution guard is unavailable",
    });
    expect(extensionCalls).toBe(0);
    expect(gateCalls).toBe(0);
    await created.dispose();
  });

  it("deep-freezes extension-mutated JSON args before the host gate", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-tool-freeze-");
    const mutationAttempted = deferred();
    let retained: {
      path: string;
      metadata: { owner: string };
      tags: string[];
    } | undefined;
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("tool_call", (event) => {
          retained = event.input as typeof retained;
          setTimeout(() => {
            try {
              retained!.path = "../outside.txt";
            } catch {
              // Frozen arguments reject retained-reference mutation.
            }
            try {
              retained!.metadata.owner = "mutated";
            } catch {
              // Frozen arguments reject retained-reference mutation.
            }
            try {
              retained!.tags.push("mutated");
            } catch {
              // Frozen arguments reject retained-reference mutation.
            }
            mutationAttempted.resolve();
          }, 0);
        });
      },
    ]);
    let gatedArgs: unknown;
    const created = await runtime.createSession(cwd, {
      toolCallGate: async (input) => {
        expect(input.args).toBe(retained);
        await mutationAttempted.promise;
        gatedArgs = input.args;
        return { block: true, reason: "test complete" };
      },
    });
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    const hook = created.session.agent.beforeToolCall;
    if (!hook) throw new Error("tool hook was not installed");
    type HookContext = Parameters<typeof hook>[0];
    const args = {
      path: "inside.txt",
      metadata: { owner: "extension" },
      tags: ["stable"],
    };

    await expect(within(hook({
      toolCall: {
        type: "toolCall",
        id: "tool-freeze",
        name: "write",
        arguments: args,
      },
      args,
    } as unknown as HookContext, new AbortController().signal), 500)).resolves.toEqual({
      block: true,
      reason: "test complete",
    });

    expect(gatedArgs).toEqual({
      path: "inside.txt",
      metadata: { owner: "extension" },
      tags: ["stable"],
    });
    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.isFrozen(args.metadata)).toBe(true);
    expect(Object.isFrozen(args.tags)).toBe(true);
    await created.dispose();
  });

  it("blocks non-JSON or unstable tool arguments before the host gate", async () => {
    const cwd = await temporaryDirectory("piweb-runtime-tool-json-");
    let gateCalls = 0;
    const runtime = await testRuntime(() => []);
    const created = await runtime.createSession(cwd, {
      toolCallGate: async () => {
        gateCalls++;
        return undefined;
      },
    });
    await created.activateExtensions();
    created.activateExtensionErrors(() => undefined);
    const hook = created.session.agent.beforeToolCall;
    if (!hook) throw new Error("tool hook was not installed");
    type HookContext = Parameters<typeof hook>[0];

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "unstable",
    });
    const hidden = Object.defineProperty({}, "value", {
      enumerable: false,
      value: "hidden",
    });
    const throwingProxy = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("proxy trap must not run");
      },
    });
    const cases: Array<[string, unknown]> = [
      ["undefined", { value: undefined }],
      ["function", { value: () => undefined }],
      ["symbol", { value: Symbol("value") }],
      ["bigint", { value: 1n }],
      ["non-finite number", { value: Number.POSITIVE_INFINITY }],
      ["cycle", circular],
      ["accessor", accessor],
      ["hidden property", hidden],
      ["non-plain object", { value: new Date() }],
      ["sparse array", new Array(1)],
      ["proxy", throwingProxy],
    ];

    for (const [label, args] of cases) {
      const result = await hook({
        toolCall: {
          type: "toolCall",
          id: `tool-invalid-${label}`,
          name: "custom",
          arguments: args,
        },
        args,
      } as unknown as HookContext, new AbortController().signal);
      expect(result, label).toEqual({
        block: true,
        reason: "Tool arguments must be stable plain JSON data",
      });
    }

    expect(gateCalls).toBe(0);
    await created.dispose();
  });
});
