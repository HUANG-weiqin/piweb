import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Transport,
} from "@earendil-works/pi-ai";
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
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { LoopList } from "../shared/protocol.js";
import { PiRuntime } from "./pi-runtime.js";

initTheme();

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
): Promise<PiRuntime> {
  const credentialStore = new InMemoryCredentialStore();
  return PiRuntime.create({
    credentialStore,
    modelsStore: new InMemoryModelsStore(),
    createModelsStore: () => new InMemoryModelsStore(),
    createModelRuntime: async (options) => {
      const runtime = await ModelRuntime.create({ ...options, modelsPath: null });
      await setupModelRuntime?.(runtime);
      return runtime;
    },
    createSettings: () => SettingsManager.inMemory(),
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-service-tier-"));
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
    const context = { systemPrompt: "", messages: [], tools: [] };

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

  it("recalculates context usage at each completed tool-turn boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-turn-boundary-"));
    const checks: unknown[] = [];
    let upstreamReceiver: unknown;
    let originalCreateLoopConfig: unknown;
    const runtime = await testRuntime(
      () => [],
      async (result) => {
        const loopOwner = result.session.agent as unknown as {
          createLoopConfig(...args: unknown[]): Record<string, unknown>;
        };
        const nativeCreateLoopConfig = loopOwner.createLoopConfig;
        loopOwner.createLoopConfig = function (...args) {
          return {
            ...nativeCreateLoopConfig.apply(this, args),
            marker: "upstream-config",
            shouldStopAfterTurn: function () {
              upstreamReceiver = this;
              return false;
            },
          };
        };
        originalCreateLoopConfig = loopOwner.createLoopConfig;
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
    const loopOwner = created.session.agent as unknown as {
      createLoopConfig(): {
        shouldStopAfterTurn?: (input: { toolResults: unknown[] }) => Promise<boolean>;
      };
    };
    const shouldStop = loopOwner.createLoopConfig().shouldStopAfterTurn;
    created.session.agent.steer({
      role: "user",
      content: [{ type: "text", text: "queued guidance" }],
      timestamp: Date.now(),
    });
    expect(created.session.agent.hasQueuedMessages()).toBe(true);

    await expect(shouldStop?.({ toolResults: [{}] })).resolves.toBe(true);
    expect(created.session.agent.hasQueuedMessages()).toBe(false);
    expect(getContextUsage).toHaveBeenCalledOnce();
    expect(checks).toEqual([{
      contextUsage: { tokens: 700, contextWindow: 1_000, percent: 70 },
      hasToolResults: true,
    }]);
    expect(upstreamReceiver).toMatchObject({ marker: "upstream-config" });
    created.releaseTurnBoundaryPause?.();
    expect(created.session.agent.hasQueuedMessages()).toBe(true);
    await created.dispose();
    expect(loopOwner.createLoopConfig).toBe(originalCreateLoopConfig);
  });

  it("captures the exact synchronous user message queued through agent.steer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-steering-identity-"));
    const runtime = await testRuntime(() => []);
    const created = await runtime.createSession(cwd);
    const message: Parameters<typeof created.session.agent.steer>[0] = {
      role: "user",
      content: [{ type: "text", text: "queued guidance" }],
      timestamp: 1,
    };

    const captured = created.captureSteeringMessage(() =>
      created.session.agent.steer(message)
    );

    expect(captured?.message).toBe(message);
    expect(created.session.agent.hasQueuedMessages()).toBe(true);
    await created.dispose();
  });

  it("owns the supplied manager compaction boundary for the session lifetime", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-compaction-boundary-"));
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

  it("projects live context-budget telemetry without creating a trailing user turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-context-budget-"));
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
    const secondTransformed = await created.session.agent.transformContext!(input);
    const second = await created.session.agent.convertToLlm(secondTransformed);

    expect(firstTransformed).toEqual([input[0], projectMessage]);
    expect(secondTransformed).toEqual([input[0], projectMessage]);
    expect(first).toEqual([
      input[0],
      {
        role: "user",
        content: [
          { type: "text", text: "project context" },
          {
            type: "text",
            text: "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
          },
        ],
        timestamp: 1,
      },
    ]);
    expect(second.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "project context" },
        {
          type: "text",
          text: "<piweb_ctx used=\"10k/100k\" auto_compact=\"80%\" remaining=\"70k\" />",
        },
      ],
    });
    expect(second).toHaveLength(secondTransformed.length);
    expect(created.session.messages).toEqual(sessionMessagesBefore);
    expect(manager.getEntries()).toEqual(entriesBefore);
    expect(created.session.agent.transformContext).toBe(originalTransform);
    expect(created.session.agent.convertToLlm).not.toBe(originalConverter);

    await created.dispose();
    expect(created.session.agent.transformContext).toBe(originalTransform);
    expect(created.session.agent.convertToLlm).toBe(originalConverter);
  });

  it("projects the latest active LoopList without telemetry and restores the converter", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-work-hint-"));
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
    const created = await runtime.createSession(cwd, { getLoopList });
    const getContextUsage = vi.spyOn(created.session, "getContextUsage");
    const input = [{
      role: "user" as const,
      content: [{ type: "text" as const, text: "input" }],
      timestamp: 1,
    }];
    const sessionMessagesBefore = [...created.session.messages];

    const first = await created.session.agent.convertToLlm(input);
    loopList = {
      items: [{ id: "second", text: "Latest active item", status: "active" }],
      armed: true,
    };
    const second = await created.session.agent.convertToLlm(input);
    loopList = {
      items: [{ id: "done", text: "Finished", status: "completed" }],
      armed: false,
    };
    const noActive = await created.session.agent.convertToLlm(input);

    expect(first.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "input" },
        {
          type: "text",
          text: "piweb_work={\"active\":[{\"id\":\"first\",\"text\":\"First active item\"}],\"omitted\":0,\"onStatusChange\":\"todo_write\"}",
        },
      ],
    });
    expect(second.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "input" },
        {
          type: "text",
          text: "piweb_work={\"active\":[{\"id\":\"second\",\"text\":\"Latest active item\"}],\"omitted\":0,\"onStatusChange\":\"todo_write\"}",
        },
      ],
    });
    expect(noActive.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "input" }],
    });
    expect(getLoopList).toHaveBeenCalledTimes(3);
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(created.session.messages).toEqual(sessionMessagesBefore);
    expect(created.session.agent.convertToLlm).not.toBe(originalConverter);

    await created.dispose();
    expect(created.session.agent.convertToLlm).toBe(originalConverter);
  });

  it("activates Pi's structured read-only tools by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-read-tools-"));
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

  it("projects only safe native and host tools for read-only sessions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-read-only-tools-"));
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
        workbenchTool(cwd, "git_status"),
        workbenchTool(cwd, "git_diff"),
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
      "git_status",
      "git_diff",
      "notebook_write",
      "notebook_list",
      "notebook_grep",
      "notebook_read",
    ]);
    expect(new Set(created.session.getActiveToolNames())).toEqual(expectedToolNames);
    expect(new Set(allTools.map((tool) => tool.name))).toEqual(expectedToolNames);
    expect(allTools.find((tool) => tool.name === "read")?.sourceInfo.source)
      .toBe("builtin");
    expect(allTools.find((tool) => tool.name === "git_status")?.sourceInfo.source)
      .toBe("sdk");
    expect(allTools.find((tool) => tool.name === "git_diff")?.sourceInfo.source)
      .toBe("sdk");
    expect(allTools.find((tool) => tool.name === "notebook_write")?.sourceInfo.source)
      .toBe("sdk");
    await created.dispose();
  });

  it("keeps read-only projection across extension tool refreshes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-dynamic-read-only-tools-"));
    const staticMarker = "STATIC_SHADOW_TOOL_MARKER";
    const startMarker = "SESSION_START_SHADOW_TOOL_MARKER";
    const dynamicMarker = "DYNAMIC_SHADOW_TOOL_MARKER";
    const shutdownMarker = "SHUTDOWN_SHADOW_TOOL_MARKER";
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
          pi.setActiveTools(["read", "find", "grep", "ls", "git_status", "git_diff"]);
        });
        pi.on("session_shutdown", (_event, context) => {
          pi.registerTool(shadowReadTool(cwd, "ls", shutdownMarker));
          pi.setActiveTools(["read", "find", "grep", "ls", "git_status", "git_diff"]);
          shutdownActiveTools = pi.getActiveTools();
          shutdownSystemPrompt = context.getSystemPrompt();
        });
      },
    ]);

    const created = await runtime.createSession(cwd, {
      toolMode: "read_only",
      workbenchCustomTools: [
        workbenchTool(cwd, "git_status"),
        workbenchTool(cwd, "git_diff"),
      ],
    });
    expect(created.session.getActiveToolNames()).not.toContain("find");
    expect(created.session.systemPrompt).not.toContain(staticMarker);

    await created.activateExtensions();
    expect(sessionStarted).toBe(true);
    expect(created.session.getActiveToolNames()).not.toContain("read");
    expect(created.session.getActiveToolNames()).not.toContain("find");
    expect(created.session.systemPrompt).not.toContain(staticMarker);
    expect(created.session.systemPrompt).not.toContain(startMarker);

    extensionApi?.registerTool(shadowReadTool(cwd, "grep", dynamicMarker));
    extensionApi?.setActiveTools(["read", "find", "grep", "ls", "git_status", "git_diff"]);
    expect(created.session.getActiveToolNames()).toEqual(["ls", "git_status", "git_diff"]);
    expect(created.session.systemPrompt).not.toContain(dynamicMarker);

    const projectedSetter = created.session.setActiveToolsByName;
    await created.dispose();
    expect(shutdownActiveTools).toEqual(["git_status", "git_diff"]);
    expect(shutdownSystemPrompt).not.toContain(shutdownMarker);
    expect(created.session.setActiveToolsByName).not.toBe(projectedSetter);
  });

  it("reports an extension that shadows read as a non-builtin tool", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-shadowed-read-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-tool-result-compression-"));
    const runtime = await testRuntime(() => []);
    const originalText = Array.from(
      { length: 160 },
      (_, index) => `grep ${String(index).padStart(3, "0")} ${"x".repeat(100)}`,
    ).join("\n");
    const original = {
      content: [{ type: "text" as const, text: originalText }],
      details: { executed: true },
    };
    const completed = vi.fn((input: { details: unknown }) => ({
      details: {
        ...(input.details as Record<string, unknown>),
        observed: true,
      },
    }));
    const created = await runtime.createSession(cwd, {
      toolCallCompleted: completed,
    });
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
    expect(patch?.details).toEqual({ executed: true, observed: true });
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: "grep-call",
      toolName: "grep",
      toolSource: "builtin",
      args: { pattern: "x" },
      isError: false,
      details: { executed: true },
    }));
    expect(original.content).toEqual([{ type: "text", text: originalText }]);
    await created.dispose();
  });

  it("reports the original execution to completion accounting when an extension result hook fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-tool-completion-error-"));
    const extensionError = new Error("extension result hook failed");
    const runtime = await testRuntime(
      () => [],
      async (result) => {
        result.session.agent.afterToolCall = async () => {
          throw extensionError;
        };
      },
    );
    const completed = vi.fn();
    const created = await runtime.createSession(cwd, {
      toolCallCompleted: completed,
    });
    const afterToolCall = created.session.agent.afterToolCall;
    if (!afterToolCall) throw new Error("tool result hook was not installed");

    await expect(afterToolCall({
      toolCall: { id: "edit-call", name: "edit" },
      args: { path: "src/index.ts" },
      result: { content: [], details: { executed: true } },
      isError: false,
    } as Parameters<typeof afterToolCall>[0])).rejects.toBe(extensionError);

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: "edit-call",
      toolName: "edit",
      isError: false,
      details: { executed: true },
    }));
    await created.dispose();
  });

  it("sets steeringMode=all so queued prompts drain in one model turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-steering-mode-"));
    const runtime = await testRuntime(() => []);

    const created = await runtime.createSession(cwd);
    expect(created.session.agent.steeringMode).toBe("all");
    expect(created.settings.getSteeringMode()).toBe("one-at-a-time");
    await created.dispose();
  });

  it("defaults to an in-memory manager and passes an explicit manager through", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-manager-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-fixed-extension-model-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-extension-manager-"));
    const manager = SessionManager.inMemory(cwd);
    manager.appendCustomEntry("readonly-facade-test", {
      nested: { value: "original" },
    });
    let startFacade: unknown;
    let shutdownFacade: unknown;
    let facadeKeys: string[] = [];
    let startHasMutator = true;
    let shutdownHasMutator = true;
    const runtime = await testRuntime(() => [
      (pi) => {
        pi.on("session_start", (_event, context) => {
          startFacade = context.sessionManager;
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
    expect(startHasMutator).toBe(false);
    expect(facadeKeys).toEqual([
      "buildContextEntries",
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
      const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-transport-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-role-"));
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

  it("loads project providers before resolving a fixed role model and appends the role prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-services-role-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-project-catalog-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-role-model-guard-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-role-fallback-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-trust-project-"));
    const agentDir = await mkdtemp(join(tmpdir(), "piweb-runtime-trust-agent-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-untrusted-project-"));
    const agentDir = await mkdtemp(join(tmpdir(), "piweb-runtime-untrusted-agent-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-restore-provider-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-create-failure-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-assembly-failure-"));
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
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-runtime-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-runtime-b-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-extension-ui-"));
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
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-runtime-global-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-runtime-clean-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-unsafe-native-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-unsafe-refresh-"));
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
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-runtime-lock-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-runtime-lock-b-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-dispose-refresh-"));
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
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-runtime-refresh-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-runtime-refresh-b-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-snapshot-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-model-refresh-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-bind-race-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-unactivated-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-load-error-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-shutdown-error-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-listener-cleanup-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-tool-gate-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-tool-abort-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-tool-freeze-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-tool-json-"));
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
