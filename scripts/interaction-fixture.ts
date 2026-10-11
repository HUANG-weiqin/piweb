import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Transport,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SettingsManager,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/server/pi-runtime.js";
import { attachSocketServer } from "../src/server/socket-server.js";
import { UiPreferencesStore } from "../src/server/ui-preferences-store.js";

export const FIRST_PROMPT = "E2E first task";
export const BUSY_PROMPT = "E2E busy task";
export const STEER_PROMPT = "E2E follow-up";
export const TITLE = "E2E automatic title";

export const LOCAL_IMAGE_NAME = "preview 中文.png";
export const LOCAL_IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const FIRST_RESPONSE = `FIRST RESPONSE\n\n[查看本地图片](./${encodeURIComponent(LOCAL_IMAGE_NAME)})`;
const BUSY_RESPONSE = "BUSY RESPONSE";
const FOLLOW_UP_RESPONSE = "FOLLOW-UP RESPONSE";
const FIXTURE_PROVIDER = "interaction-fixture";
const FIXTURE_MODEL = "interaction-model";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AUTO_TITLE_PROMPT = "Create a concise conversation title";
const SHUTDOWN_TIMEOUT_MS = 5_000;

export type InteractionFixtureLogEvent = {
  readonly kind: "title_requested" | "title_returned" | "model_requested" | "model_returned";
  readonly text: string;
  readonly sessionId?: string;
  readonly transport?: Transport;
};

export type InteractionFixtureLog = InteractionFixtureLogEvent[];

export interface InteractionFixture {
  readonly url: string;
  readonly cwd: string;
  readonly log: InteractionFixtureLog;
  releaseTitle(): void;
  releaseBusyTurn(): void;
  disconnectBrowsers(): Promise<void>;
  close(): Promise<void>;
}

interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, release: resolve };
}

function requestTexts(context: Context): string[] {
  const texts: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }
    texts.push(message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""));
  }
  return texts;
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: FIXTURE_PROVIDER,
    model: FIXTURE_MODEL,
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

function responseStream(
  text: string,
  waitFor?: Promise<void>,
  onReturned?: () => void,
  signal?: AbortSignal,
) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage("");
  const content = message.content[0];
  if (!content || content.type !== "text") {
    throw new Error("Interaction fixture response must start with text content");
  }
  let settled = false;
  const abort = () => {
    if (settled) return;
    settled = true;
    message.stopReason = "aborted";
    message.errorMessage = "Interaction fixture request aborted";
    stream.push({ type: "error", reason: "aborted", error: message });
    stream.end(message);
  };

  void (async () => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    if (signal?.aborted) {
      abort();
      return;
    }
    let onAbort: (() => void) | undefined;
    try {
      if (waitFor && signal) {
        const aborted = new Promise<void>((resolveAbort) => {
          onAbort = () => {
            abort();
            resolveAbort();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        await Promise.race([waitFor, aborted]);
      } else {
        await waitFor;
      }
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    if (settled || signal?.aborted) {
      abort();
      return;
    }
    settled = true;
    onReturned?.();
    content.text = text;
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: message,
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: text,
      partial: message,
    });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  })();

  return stream;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function withinShutdownDeadline<T>(
  operation: string,
  promise: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Timed out while ${operation} after ${SHUTDOWN_TIMEOUT_MS}ms`,
    )), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    try {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    } catch (error) {
      rejectClose(error);
    }
  });
}

/**
 * Starts a loopback server backed by the production socket/coordinator/actor
 * path. The only fake is the static provider registered on each isolated
 * ModelRuntime; all prompts, events, session persistence, and JSONL handling
 * stay on the real SDK and workbench paths.
 */
export async function startInteractionFixture(
  clientDir: string,
): Promise<InteractionFixture> {
  const root = await mkdtemp(join(tmpdir(), "piweb-interaction-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  const titleGate = gate();
  const busyTurnGate = gate();
  const log: InteractionFixtureLog = [];
  let server: Server | undefined;
  let socketServer: ReturnType<typeof attachSocketServer> | undefined;
  let closePromise: Promise<void> | undefined;

  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    await writeFile(join(cwd, LOCAL_IMAGE_NAME), Buffer.from(LOCAL_IMAGE_DATA, "base64"));
    const createModelRuntime = async (
      options: CreateModelRuntimeOptions,
    ): Promise<ModelRuntime> => {
      const modelRuntime = await ModelRuntime.create({
        ...options,
        modelsPath: null,
        allowModelNetwork: false,
      });
      modelRuntime.registerProvider(FIXTURE_PROVIDER, {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "fixture-key",
        api: "openai-completions",
        models: [{
          id: FIXTURE_MODEL,
          name: "Interaction fixture model",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        }],
        streamSimple: (_model, context, options) => {
          const texts = requestTexts(context);
          const lastText = texts.at(-1) ?? "";
          const text = texts.join("\n");
          const requestIdentity = {
            sessionId: options?.sessionId,
            transport: options?.transport,
          };
          const isTitleRequest = context.systemPrompt?.includes(AUTO_TITLE_PROMPT)
            || context.messages.some((message) => message.role === "system" && (
              typeof message.content === "string"
                ? message.content
                : message.content.map((part) => part.text).join("")
            ).includes(AUTO_TITLE_PROMPT));
          if (isTitleRequest) {
            log.push({ kind: "title_requested", text, ...requestIdentity });
            return responseStream(TITLE, titleGate.promise, () => {
              log.push({ kind: "title_returned", text: TITLE });
            }, options?.signal);
          }

          log.push({ kind: "model_requested", text, ...requestIdentity });
          const response = lastText === BUSY_PROMPT
            ? BUSY_RESPONSE
            : lastText === STEER_PROMPT
              ? FOLLOW_UP_RESPONSE
              : FIRST_RESPONSE;
          return responseStream(
            response,
            lastText === BUSY_PROMPT ? busyTurnGate.promise : undefined,
            () => {
              log.push({ kind: "model_returned", text: response });
            },
            options?.signal,
          );
        },
      });
      await modelRuntime.refresh({ allowNetwork: false });
      return modelRuntime;
    };
    const runtime = await PiRuntime.create({
      credentialStore: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      createModelsStore: () => new InMemoryModelsStore(),
      createModelRuntime,
      // Keep original image bytes to exercise upload/durable limits; real user settings stay untouched.
      createSettings: () => SettingsManager.inMemory({ images: { autoResize: false } }),
      createServices: (options) => createAgentSessionServices({
        ...options,
        agentDir,
        resourceLoaderOptions: {
          ...options.resourceLoaderOptions,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      }),
      createSessionFromServices: createAgentSessionFromServices,
      projectTrustStore: {
        get: () => null,
        set: () => undefined,
      },
    });

    const app = express();
    const resolvedClientDir = resolve(clientDir);
    app.disable("x-powered-by");
    app.get("/health", (_request, response) => response.json({ ok: true }));
    app.use(express.static(resolvedClientDir, { index: false }));
    app.get("/{*path}", (_request, response) => response.sendFile(
      resolve(resolvedClientDir, "index.html"),
      { dotfiles: "allow" },
    ));

    server = createServer(app);
    socketServer = attachSocketServer(
      server,
      cwd,
      runtime,
      undefined,
      false,
      UiPreferencesStore.memory(),
    );
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Interaction fixture did not bind a TCP port");
    }
    const url = `http://127.0.0.1:${address.port}`;

    const disconnectBrowsers = (): Promise<void> => withinShutdownDeadline(
      "terminating fixture browser clients",
      Promise.all([...socketServer!.sockets.clients].map((browser) => (
        new Promise<void>((resolveClose) => {
          if (browser.readyState === browser.CLOSED) {
            resolveClose();
            return;
          }
          browser.once("close", resolveClose);
          browser.terminate();
        })
      ))).then(() => undefined),
    );

    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        titleGate.release();
        busyTurnGate.release();
        const failures: unknown[] = [];
        try {
          await disconnectBrowsers();
        } catch (error) {
          failures.push(error);
        }
        server!.closeIdleConnections?.();
        let socketServerClosed = false;
        try {
          await withinShutdownDeadline(
            "closing the fixture socket server",
            socketServer!.close(),
          );
          socketServerClosed = true;
        } catch (error) {
          failures.push(error);
        }
        let httpServerClosed = false;
        try {
          await withinShutdownDeadline(
            "closing the fixture HTTP server",
            closeHttpServer(server!),
          );
          httpServerClosed = true;
        } catch (error) {
          failures.push(error);
        }
        if (socketServerClosed && httpServerClosed) {
          try {
            await rm(root, { recursive: true, force: true });
          } catch (error) {
            failures.push(error);
          }
        } else {
          failures.push(new Error(
            `Retained fixture directory while an owner may still be active: ${root}`,
          ));
        }
        if (process.env[AGENT_DIR_ENV] === agentDir) {
          if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
          else process.env[AGENT_DIR_ENV] = previousAgentDir;
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to close interaction fixture");
        }
      })();
      return closePromise;
    };

    return {
      url,
      cwd,
      log,
      releaseTitle: titleGate.release,
      releaseBusyTurn: busyTurnGate.release,
      disconnectBrowsers,
      close,
    };
  } catch (error) {
    titleGate.release();
    busyTurnGate.release();
    const failures: unknown[] = [error];
    let socketServerClosed = socketServer === undefined;
    if (socketServer) {
      try {
        await withinShutdownDeadline(
          "closing the fixture socket server after startup failure",
          socketServer.close(),
        );
        socketServerClosed = true;
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    let httpServerClosed = server === undefined || !server.listening;
    if (server && server.listening) {
      try {
        await withinShutdownDeadline(
          "closing the fixture HTTP server after startup failure",
          closeHttpServer(server),
        );
        httpServerClosed = true;
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (socketServerClosed && httpServerClosed) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    } else {
      failures.push(new Error(
        `Retained fixture directory while an owner may still be active: ${root}`,
      ));
    }
    if (process.env[AGENT_DIR_ENV] === agentDir) {
      if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
      else process.env[AGENT_DIR_ENV] = previousAgentDir;
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to start interaction fixture");
    }
    throw error;
  }
}
