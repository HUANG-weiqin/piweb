import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  createAgentSessionServices,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiRuntime } from "./pi-runtime.js";

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

function testRuntime(
  extensionsFor: (cwd: string) => InlineExtension[],
  afterCreate?: (
    created: Awaited<ReturnType<typeof createAgentSession>>,
    options: CreateAgentSessionOptions,
  ) => Promise<void>,
): PiRuntime {
  const authStorage = AuthStorage.inMemory();
  return new PiRuntime({
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    createModelRegistry: (storage) => ModelRegistry.inMemory(storage),
    createSettings: () => SettingsManager.inMemory(),
    createSession: async (options) => {
      const cwd = options.cwd ?? process.cwd();
      const settingsManager = options.settingsManager ?? SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: extensionsFor(cwd),
      });
      await resourceLoader.reload();
      const created = await createAgentSession({ ...options, resourceLoader });
      await afterCreate?.(created, options);
      return created;
    },
  });
}

describe("PiRuntime session ownership", () => {
  it("defaults to an in-memory manager and passes an explicit manager through", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-manager-"));
    const managers: SessionManager[] = [];
    const runtime = testRuntime(
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

  it("registers project providers before restoring a persisted model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-restore-provider-"));
    const authStorage = AuthStorage.inMemory();
    const manager = SessionManager.inMemory(cwd);
    manager.appendModelChange("restored-provider", "restored-model");
    manager.appendCustomMessageEntry("restore-test", "saved context", false);
    const runtime = new PiRuntime({
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      createModelRegistry: (storage) => ModelRegistry.inMemory(storage),
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
    const authStorage = AuthStorage.inMemory();
    let ownerRefreshes = 0;
    const runtime = new PiRuntime({
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      createModelRegistry: (storage) => {
        const registry = ModelRegistry.inMemory(storage);
        const refresh = registry.refresh.bind(registry);
        registry.refresh = () => {
          ownerRefreshes++;
          refresh();
        };
        return registry;
      },
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

    await expect(runtime.createSession(cwd)).rejects.toThrow("second-stage creation failed");
    await runtime.refreshConfiguration();
    expect(ownerRefreshes).toBe(0);
  });

  it("binds extension lifecycle, surfaces errors, and isolates project providers", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-runtime-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-runtime-b-"));
    let starts = 0;
    let shutdowns = 0;
    const runtime = testRuntime((cwd) => cwd === cwdA
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

  it("fails initialization when an extension requests a process-global provider", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-runtime-global-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-runtime-clean-"));
    const runtime = testRuntime((cwd) => cwd === cwdA
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

    await expect(runtime.createSession(cwdA)).rejects.toThrow(
      "Extension provider registration failed",
    );

    const clean = await runtime.createSession(cwdB);
    await clean.activateExtensions();
    clean.activateExtensionErrors(() => undefined);
    expect(clean.modelRegistry.find("unsafe-stream", "unsafe-model")).toBeUndefined();
    await clean.dispose();
  });

  it("does not let a long configuration flow block session creation or disposal", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-runtime-lock-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-runtime-lock-b-"));
    const runtime = testRuntime(() => []);
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

  it("snapshots extension provider config before the extension can mutate it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-snapshot-"));
    let retained: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
    const runtime = testRuntime(() => [
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
    expect(runtime.authStorage.getOAuthProviders().some((provider) => (
      provider.id === "retained-provider"
    ))).toBe(false);
    await created.dispose();
  });

  it("rebinds the selected model object after registry refresh", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-model-refresh-"));
    const runtime = testRuntime(() => [
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

    await runtime.refreshConfiguration();
    expect(created.session.model).not.toBe(original);
    expect(created.session.model?.baseUrl).toBe("https://after.invalid/v1");

    const refreshed = created.session.model;
    created.modelRegistry.unregisterProvider("refreshable");
    await runtime.refreshConfiguration();
    expect(created.modelRegistry.find("refreshable", "refreshable-model")).toBeUndefined();
    expect(created.session.model).not.toBe(refreshed);
    await created.dispose();
  });

  it("reconciles a model refreshed while the session factory is still resolving", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-bind-race-"));
    const factoryReached = deferred();
    const factoryGate = deferred();
    let nativeSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let originalModel: NonNullable<typeof nativeSession>["model"];
    const runtime = testRuntime(
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
        const model = created.session.modelRegistry.find("bind-race", "bind-race-model");
        if (!model) throw new Error("test model was not registered");
        await created.session.setModel(model);
        originalModel = created.session.model;
        factoryReached.resolve();
        await factoryGate.promise;
      },
    );

    const pending = runtime.createSession(cwd);
    await factoryReached.promise;
    nativeSession!.modelRegistry.registerProvider("bind-race", {
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
    const runtime = testRuntime(() => [
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
    const runtime = testRuntime(() => [
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
    const runtime = testRuntime(() => [
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

  it("runs extension tool hooks before the host gate and forces sequential execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-tool-gate-"));
    const runtime = testRuntime(() => [
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
    expect(missingSignal).toEqual({ block: true, reason: "Tool approval is unavailable" });
    expect(gated).toHaveLength(1);
    await created.dispose();
  });

  it("skips extension hooks when the tool signal is missing or already aborted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-runtime-tool-abort-"));
    let extensionCalls = 0;
    let gateCalls = 0;
    const runtime = testRuntime(() => [
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
      reason: "Tool approval is unavailable",
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
    const runtime = testRuntime(() => [
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
    const runtime = testRuntime(() => []);
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
