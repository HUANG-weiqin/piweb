import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  OBSERVATION_FATAL_CLOSE_CODE,
  parseServerEvent,
  PROTOCOL_VERSION,
  type CustomProviderSaveInput,
  type ServerEvent,
} from "../shared/protocol.js";
import type { CustomProviderSnapshotView } from "./custom-provider-store.js";
import type { DirectoryBrowser } from "./directory-browser.js";
import type {
  CreatedPiSession,
  CredentialChangeIntent,
  PiRuntimeLike,
} from "./pi-runtime.js";
import {
  attachSocketServer,
  isAllowedOrigin,
  safeSend,
  type CustomProviderStoreLike,
} from "./socket-server.js";

class SocketTestRuntime implements PiRuntimeLike {
  readonly credentialStore = new InMemoryCredentialStore();
  readonly modelRuntime = {} as ModelRuntime;
  readonly modelRegistry = {} as ModelRegistry;
  subscribers = 0;

  async createProjectModelCatalog() {
    return {
      modelRuntime: this.modelRuntime,
      modelRegistry: this.modelRegistry,
      dynamicProviderNames: () => new Set<string>(),
      dispose: async () => undefined,
    };
  }

  createSession(): Promise<CreatedPiSession> {
    throw new Error("not used");
  }

  beginCredentialChange(provider: string): CredentialChangeIntent {
    return { provider, revision: 1 };
  }

  async commitCredentialChange(
    _intent: CredentialChangeIntent,
    change: () => Promise<void> | void,
  ): Promise<boolean> {
    await change();
    return true;
  }

  async updateConfiguration<T>(change: () => Promise<T> | T): Promise<T> {
    return change();
  }

  async refreshConfiguration(): Promise<void> {}

  subscribe(): () => void {
    this.subscribers++;
    return () => {
      this.subscribers--;
    };
  }
}

function nextEvent(socket: WebSocket): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(parseServerEvent(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("isAllowedOrigin", () => {
  it("allows local browser origins", () => {
    expect(isAllowedOrigin(
      ["http://127.0.0.1:5173"],
      ["127.0.0.1:5173"],
    )).toBe(true);
    expect(isAllowedOrigin(
      ["http://localhost:31415"],
      ["localhost:31415"],
    )).toBe(true);
    expect(isAllowedOrigin(
      ["https://127.0.0.1:5173"],
      ["127.0.0.1:5173"],
    )).toBe(true);
  });

  it("allows an authenticated same-origin Tailscale Serve request", () => {
    const host = "desktop.example-tailnet.ts.net";
    expect(isAllowedOrigin(
      [`https://${host}`],
      [host],
      ["owner@example.com"],
    )).toBe(true);
  });

  it("rejects remote, ambiguous, and malformed origin headers", () => {
    const tailscaleHost = "desktop.example-tailnet.ts.net";
    const origin = `https://${tailscaleHost}`;
    const identity = ["owner@example.com"];
    expect(isAllowedOrigin(["https://example.com"], ["example.com"])).toBe(false);
    expect(isAllowedOrigin(
      ["https://example.com"],
      ["example.com"],
      identity,
    )).toBe(false);
    expect(isAllowedOrigin(
      [`http://${tailscaleHost}`],
      [tailscaleHost],
      identity,
    )).toBe(false);
    expect(isAllowedOrigin([origin], [tailscaleHost])).toBe(false);
    expect(isAllowedOrigin([origin], [tailscaleHost], [""])).toBe(false);
    expect(isAllowedOrigin(
      [origin],
      [tailscaleHost],
      ["owner@example.com", "other@example.com"],
    )).toBe(false);
    expect(isAllowedOrigin(
      [origin, origin],
      [tailscaleHost],
      identity,
    )).toBe(false);
    expect(isAllowedOrigin(
      [origin],
      [tailscaleHost, tailscaleHost],
      identity,
    )).toBe(false);
    expect(isAllowedOrigin(
      [origin],
      ["other.example-tailnet.ts.net"],
      identity,
    )).toBe(false);
    expect(isAllowedOrigin(
      ["https://desktop.example-tailnet.ts.net.attacker.example"],
      ["desktop.example-tailnet.ts.net.attacker.example"],
      identity,
    )).toBe(false);
    for (const malformedOrigin of [
      `https://user@${tailscaleHost}`,
      `${origin}/path`,
      `${origin}?query=1`,
      `${origin}#fragment`,
    ]) {
      expect(isAllowedOrigin(
        [malformedOrigin],
        [tailscaleHost],
        identity,
      )).toBe(false);
    }
    expect(isAllowedOrigin(["not a url"], ["127.0.0.1:31415"])).toBe(false);
    expect(isAllowedOrigin(
      ["http://127.0.0.1:5173"],
      ["127.0.0.1:31415"],
    )).toBe(false);
    expect(isAllowedOrigin(["http://127.0.0.1:31415"], undefined)).toBe(false);
  });

  it("accepts a WebSocket upgrade forwarded by Tailscale Serve", async () => {
    const server = createServer();
    const socketServer = attachSocketServer(
      server,
      "E:\\work",
      new SocketTestRuntime(),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");

    const host = "desktop.example-tailnet.ts.net";
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `https://${host}`,
      headers: {
        host,
        "tailscale-user-login": "owner@example.com",
      },
    });
    await expect(nextEvent(socket)).resolves.toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd: "E:\\work",
      uiPreferences: { colorScheme: "quiet-rebel" },
    });

    const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([socketServer.close(), httpClosed, clientClosed]);
  });

  it("blocks WebSocket admission until reload authority is reconciled", async () => {
    const server = createServer();
    const socketServer = attachSocketServer(
      server,
      "E:\\work",
      new SocketTestRuntime(),
      undefined,
      true,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const origin = `http://127.0.0.1:${address.port}`;

    const blocked = new WebSocket(url, { origin });
    await new Promise<void>((resolve, reject) => {
      blocked.once("unexpected-response", (_request, response) => {
        try {
          expect(response.statusCode).toBe(503);
          response.resume();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      blocked.once("open", () => reject(new Error("blocked WebSocket unexpectedly opened")));
      blocked.once("error", () => undefined);
    });

    socketServer.releaseStartupAdmission();
    const admitted = new WebSocket(url, { origin });
    await expect(nextEvent(admitted)).resolves.toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd: "E:\\work",
      uiPreferences: { colorScheme: "quiet-rebel" },
    });

    const clientClosed = new Promise<void>((resolve) => admitted.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([socketServer.close(), httpClosed, clientClosed]);
  });

  it("does not acknowledge reload when coordination initialization fails", async () => {
    const server = createServer();
    const runtime = new SocketTestRuntime();
    Object.assign(runtime.modelRegistry, {
      getAvailable: () => {
        throw new Error("role catalog unavailable");
      },
    });
    const socketServer = attachSocketServer(server, "E:\\work", runtime);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    await expect(socketServer.resumeAfterReload(
      randomUUID(),
      [{
        cwd: "E:\\work",
        conversationId: randomUUID(),
        continueTask: true,
        continuationRunId: randomUUID(),
      }],
      async () => undefined,
    )).rejects.toThrow("role catalog unavailable");
    const admissionFrozen = vi.fn();
    await expect(socketServer.prepareReload(false, admissionFrozen))
      .rejects.toThrow("role catalog unavailable");
    expect(admissionFrozen).not.toHaveBeenCalled();

    await Promise.allSettled([
      socketServer.close(),
      new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }),
    ]);
  });

  it("returns a correlated read-only directory listing", async () => {
    const directoryBrowser: DirectoryBrowser = async (path) => {
      expect(path).toBe("E:\\start");
      return {
        path: "E:\\start",
        parentPath: "E:\\",
        directories: [{
          name: "project",
          path: "E:\\start\\project",
        }],
        truncated: false,
      };
    };
    const server = createServer();
    const socketServer = attachSocketServer(
      server,
      "E:\\work",
      new SocketTestRuntime(),
      directoryBrowser,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    await nextEvent(socket);

    const commandId = randomUUID();
    const listing = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "browse_directory",
      commandId,
      path: "E:\\start",
    }));
    await expect(listing).resolves.toEqual({
      type: "directory_listing",
      commandId,
      path: "E:\\start",
      parentPath: "E:\\",
      directories: [{
        name: "project",
        path: "E:\\start\\project",
      }],
      truncated: false,
    });

    const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([socketServer.close(), httpClosed, clientClosed]);
  });

  it("rejects a repeated directory request id without reading twice", async () => {
    let browseCount = 0;
    const directoryBrowser: DirectoryBrowser = async (path) => {
      browseCount++;
      return {
        path,
        parentPath: null,
        directories: [],
        truncated: false,
      };
    };
    const server = createServer();
    const socketServer = attachSocketServer(
      server,
      "E:\\work",
      new SocketTestRuntime(),
      directoryBrowser,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    await nextEvent(socket);

    const commandId = randomUUID();
    const first = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "browse_directory",
      commandId,
      path: "E:\\start",
    }));
    await expect(first).resolves.toMatchObject({
      type: "directory_listing",
      commandId,
    });

    const repeated = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "browse_directory",
      commandId,
      path: "E:\\other",
    }));
    await expect(repeated).resolves.toMatchObject({
      type: "error",
      scope: "command",
      operation: "browse_directory",
      commandId,
    });
    expect(browseCount).toBe(1);

    const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([socketServer.close(), httpClosed, clientClosed]);
  });

  it("broadcasts committed UI preferences and correlates only the source command", async () => {
    const server = createServer();
    const runtime = new SocketTestRuntime();
    let colorScheme: "quiet-rebel" | "classic-rebel" = "quiet-rebel";
    let failWrite = false;
    let blockWrite = false;
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const setColorScheme = vi.fn(async (next: typeof colorScheme) => {
      if (blockWrite) {
        markWriteStarted?.();
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      }
      if (failWrite) throw new Error("disk unavailable");
      colorScheme = next;
      return { colorScheme };
    });
    const preferences = {
      get: () => ({ colorScheme }),
      setColorScheme,
    };
    const socketServer = attachSocketServer(
      server,
      "E:\\work",
      runtime,
      undefined,
      false,
      preferences,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const origin = `http://127.0.0.1:${address.port}`;
    const source = new WebSocket(url, { origin });
    const observer = new WebSocket(url, { origin });
    await expect(nextEvent(source)).resolves.toMatchObject({
      type: "hello",
      uiPreferences: { colorScheme: "quiet-rebel" },
    });
    await expect(nextEvent(observer)).resolves.toMatchObject({
      type: "hello",
      uiPreferences: { colorScheme: "quiet-rebel" },
    });

    const commandId = randomUUID();
    const sourceChanged = nextEvent(source);
    const observerChanged = nextEvent(observer);
    source.send(JSON.stringify({
      type: "set_color_scheme",
      commandId,
      colorScheme: "classic-rebel",
    }));
    await expect(sourceChanged).resolves.toEqual({
      type: "ui_preferences_changed",
      uiPreferences: { colorScheme: "classic-rebel" },
      commandId,
    });
    await expect(observerChanged).resolves.toEqual({
      type: "ui_preferences_changed",
      uiPreferences: { colorScheme: "classic-rebel" },
    });

    const duplicateError = nextEvent(source);
    source.send(JSON.stringify({
      type: "set_color_scheme",
      commandId,
      colorScheme: "quiet-rebel",
    }));
    await expect(duplicateError).resolves.toMatchObject({
      type: "error",
      scope: "command",
      operation: "set_color_scheme",
      commandId,
    });

    const crossCommandSessionId = randomUUID();
    const crossCommandError = nextEvent(source);
    source.send(JSON.stringify({
      type: "initialize",
      commandId,
      sessionId: crossCommandSessionId,
      cwd: join(tmpdir(), `piweb-missing-${randomUUID()}`),
      conversation: { kind: "recent" },
    }));
    await expect(crossCommandError).resolves.toMatchObject({
      type: "error",
      scope: "command",
      operation: "initialize",
      sessionId: crossCommandSessionId,
      commandId,
      message: expect.stringContaining("already used"),
    });

    failWrite = true;
    const failedCommandId = randomUUID();
    const writeError = nextEvent(source);
    source.send(JSON.stringify({
      type: "set_color_scheme",
      commandId: failedCommandId,
      colorScheme: "quiet-rebel",
    }));
    await expect(writeError).resolves.toMatchObject({
      type: "error",
      scope: "settings",
      operation: "set_color_scheme",
      commandId: failedCommandId,
      message: "disk unavailable",
    });
    expect(colorScheme).toBe("classic-rebel");

    failWrite = false;
    blockWrite = true;
    const admittedCommandId = randomUUID();
    const admittedChange = nextEvent(source);
    source.send(JSON.stringify({
      type: "set_color_scheme",
      commandId: admittedCommandId,
      colorScheme: "quiet-rebel",
    }));
    await writeStarted;
    const admissionFrozen = vi.fn();
    const reload = socketServer.prepareReload(false, admissionFrozen);
    await new Promise((resolve) => setImmediate(resolve));
    expect(admissionFrozen).not.toHaveBeenCalled();

    releaseWrite?.();
    await expect(admittedChange).resolves.toMatchObject({
      type: "ui_preferences_changed",
      commandId: admittedCommandId,
      uiPreferences: { colorScheme: "quiet-rebel" },
    });
    await reload;
    expect(admissionFrozen).toHaveBeenCalledOnce();

    const frozenCommandId = randomUUID();
    const frozenError = nextEvent(source);
    source.send(JSON.stringify({
      type: "set_color_scheme",
      commandId: frozenCommandId,
      colorScheme: "classic-rebel",
    }));
    await expect(frozenError).resolves.toMatchObject({
      type: "error",
      scope: "command",
      operation: "set_color_scheme",
      commandId: frozenCommandId,
    });
    expect(colorScheme).toBe("quiet-rebel");
    expect(setColorScheme).toHaveBeenCalledTimes(3);

    const sourceClosed = new Promise<void>((resolve) => source.once("close", () => resolve()));
    const observerClosed = new Promise<void>((resolve) => observer.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([
      socketServer.close(),
      httpClosed,
      sourceClosed,
      observerClosed,
    ]);
  });

  it("freezes lazy coordination before draining preferences for normal reload", async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), "piweb-reload-freeze-"));
    const server = createServer();
    const runtime = new SocketTestRuntime();
    const getAvailable = vi.fn(() => {
      throw new Error("lazy coordination was created during reload");
    });
    Object.assign(runtime.modelRegistry, { getAvailable });
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const preferences = {
      get: () => ({ colorScheme: "quiet-rebel" as const }),
      setColorScheme: async () => {
        markWriteStarted?.();
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        return { colorScheme: "classic-rebel" as const };
      },
    };
    const socketServer = attachSocketServer(
      server,
      "E:\\work",
      runtime,
      undefined,
      false,
      preferences,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    await nextEvent(socket);

    const admittedCommandId = randomUUID();
    socket.send(JSON.stringify({
      type: "set_color_scheme",
      commandId: admittedCommandId,
      colorScheme: "classic-rebel",
    }));
    await writeStarted;

    const admissionFrozen = vi.fn();
    const reload = socketServer.prepareReload(false, admissionFrozen);
    void reload.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(admissionFrozen).not.toHaveBeenCalled();

    const sessionId = randomUUID();
    const initializeCommandId = randomUUID();
    const initializeError = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "initialize",
      commandId: initializeCommandId,
      sessionId,
      cwd: projectCwd,
      conversation: { kind: "recent" },
    }));

    try {
      await expect(initializeError).resolves.toMatchObject({
        type: "error",
        scope: "command",
        operation: "initialize",
        sessionId,
        commandId: initializeCommandId,
        message: expect.stringContaining("admission is frozen"),
      });
      expect(getAvailable).not.toHaveBeenCalled();
    } finally {
      releaseWrite?.();
    }

    const admittedChange = nextEvent(socket);
    await expect(admittedChange).resolves.toMatchObject({
      type: "ui_preferences_changed",
      commandId: admittedCommandId,
    });
    await expect(reload).resolves.toEqual([]);
    expect(admissionFrozen).toHaveBeenCalledOnce();

    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([socketServer.close(), httpClosed, socketClosed]);
    await rm(projectCwd, { recursive: true, force: true });
  });

  it("freezes preference admission without waiting for an in-flight write on force reload", async () => {
    const server = createServer();
    const runtime = new SocketTestRuntime();
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const preferences = {
      get: () => ({ colorScheme: "quiet-rebel" as const }),
      setColorScheme: async () => {
        markWriteStarted?.();
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        return { colorScheme: "classic-rebel" as const };
      },
    };
    const socketServer = attachSocketServer(
      server,
      "E:\\work",
      runtime,
      undefined,
      false,
      preferences,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    await nextEvent(socket);

    const admittedCommandId = randomUUID();
    socket.send(JSON.stringify({
      type: "set_color_scheme",
      commandId: admittedCommandId,
      colorScheme: "classic-rebel",
    }));
    await writeStarted;

    const admissionFrozen = vi.fn();
    await expect(Promise.race([
      socketServer.prepareReload(true, admissionFrozen).then(() => "ready"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ])).resolves.toBe("ready");
    expect(admissionFrozen).toHaveBeenCalledOnce();

    const frozenCommandId = randomUUID();
    const frozenError = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "set_color_scheme",
      commandId: frozenCommandId,
      colorScheme: "quiet-rebel",
    }));
    await expect(frozenError).resolves.toMatchObject({
      type: "error",
      operation: "set_color_scheme",
      commandId: frozenCommandId,
    });

    const admittedChange = nextEvent(socket);
    releaseWrite?.();
    await expect(admittedChange).resolves.toMatchObject({
      type: "ui_preferences_changed",
      commandId: admittedCommandId,
    });
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([socketServer.close(), httpClosed, socketClosed]);
  });

  it("accepts a 24 MiB image command frame and closes at one byte over the transport limit", async () => {
    const server = createServer();
    const socketServer = attachSocketServer(server, "E:\\work", new SocketTestRuntime());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    try {
      await nextEvent(socket);
      const sessionId = randomUUID();
      const runId = randomUUID();
      const data = Buffer.alloc(8 * 1024 * 1024).toString("base64");
      const payload = JSON.stringify({
        type: "prompt",
        sessionId,
        conversationId: randomUUID(),
        focusId: randomUUID(),
        runId,
        promptId: randomUUID(),
        text: "",
        images: Array(2).fill({ mimeType: "image/png", data }),
      });
      const maximumBytes = 24 * 1024 * 1024;
      const response = Promise.race([
        nextEvent(socket),
        new Promise<never>((_resolve, reject) => socket.once("close", () => (
          reject(new Error("A legal image command closed the socket"))
        ))),
      ]);
      socket.send(payload + " ".repeat(maximumBytes - Buffer.byteLength(payload)));
      // An uninitialized session is rejected by the command handler, not the frame/schema gate.
      await expect(response).resolves.toMatchObject({
        type: "error", scope: "command", operation: "prompt", sessionId, runId,
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send("x".repeat(maximumBytes + 1));
      await expect(closed).resolves.toBe(1009);
    } finally {
      socket.terminate();
      await socketServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 30_000);

  it("negotiates the versioned protocol and scopes malformed command errors", async () => {
    const server = createServer();
    const runtime = new SocketTestRuntime();
    const socketServer = attachSocketServer(server, "E:\\work", runtime);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    const hello = await nextEvent(socket);
    expect(hello).toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd: "E:\\work",
      uiPreferences: { colorScheme: "quiet-rebel" },
    });

    const errorEvent = nextEvent(socket);
    socket.send("{");
    await expect(errorEvent).resolves.toMatchObject({
      type: "error",
      scope: "protocol",
    });

    const commandId = randomUUID();
    const settingSessionId = randomUUID();
    socket.send(JSON.stringify({
      type: "set_api_key",
      commandId,
      sessionId: settingSessionId,
      provider: "missing",
      key: "secret",
    }));
    const settingError = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "set_api_key",
      commandId,
      sessionId: settingSessionId,
      provider: "missing",
      key: "secret",
    }));
    await expect(settingError).resolves.toMatchObject({
      type: "error",
      scope: "command",
      operation: "set_api_key",
      commandId,
    });

    const sessionId = randomUUID();
    const initializeCommandId = randomUUID();
    const commandError = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "initialize",
      commandId: initializeCommandId,
      sessionId,
      cwd: join(tmpdir(), `piweb-missing-${randomUUID()}`),
      conversation: { kind: "recent" },
    }));
    await expect(commandError).resolves.toMatchObject({
      type: "error",
      scope: "command",
      operation: "initialize",
      sessionId,
      commandId: initializeCommandId,
    });

    for (const operation of [
      "focus_conversation",
      "delete_conversation",
      "rename_conversation",
    ] as const) {
      const correlatedCommandId = randomUUID();
      const correlatedError = nextEvent(socket);
      socket.send(JSON.stringify({
        type: operation,
        commandId: correlatedCommandId,
        sessionId,
        conversationId: randomUUID(),
        ...(operation === "rename_conversation"
          ? { name: "renamed" }
          : {}),
      }));
      await expect(correlatedError).resolves.toEqual(expect.objectContaining({
        type: "error",
        scope: "command",
        operation,
        sessionId,
        ...(operation === "rename_conversation"
          ? {}
          : { commandId: correlatedCommandId }),
      }));
      const parsed = await correlatedError;
      expect(parsed).not.toHaveProperty("conversationId");
      expect(parsed).not.toHaveProperty("focusId");
    }

    const promptConversationId = randomUUID();
    const promptFocusId = randomUUID();
    const promptRunId = randomUUID();
    const promptId = randomUUID();
    const promptError = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "prompt",
      sessionId,
      conversationId: promptConversationId,
      focusId: promptFocusId,
      runId: promptRunId,
      promptId,
      text: "retain the exact rejected focus",
    }));
    await expect(promptError).resolves.toMatchObject({
      type: "error",
      scope: "command",
      operation: "prompt",
      sessionId,
      conversationId: promptConversationId,
      focusId: promptFocusId,
      runId: promptRunId,
    });

    const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([socketServer.close(), httpClosed, clientClosed]);
    expect(runtime.subscribers).toBe(0);
  });
});

describe("safeSend", () => {
  it("serializes the successful schema parse without raw unknown fields", () => {
    const sent: string[] = [];
    const close = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        sent.push(payload);
      },
      close,
    } as unknown as WebSocket;
    const event = {
      type: "extension_ui_notification",
      sessionId: randomUUID(),
      level: "info",
      message: "valid projection",
      rawOnly: "must not reach the wire",
    } as unknown as ServerEvent;

    safeSend(socket, event);

    expect(sent).toEqual([JSON.stringify({
      type: "extension_ui_notification",
      sessionId: event.sessionId,
      level: "info",
      message: "valid projection",
    })]);
    expect(close).not.toHaveBeenCalled();
  });

  it("replaces a schema-invalid server event and terminates the observation", () => {
    const sent: string[] = [];
    const close = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        sent.push(payload);
      },
      close,
    } as unknown as WebSocket;

    safeSend(socket, {
      type: "extension_ui_notification",
      sessionId: randomUUID(),
      level: "fatal",
      message: "invalid runtime projection",
    } as unknown as ServerEvent);

    expect(sent).toHaveLength(1);
    expect(parseServerEvent(sent[0])).toEqual({
      type: "error",
      scope: "protocol",
      message: "A server event violated the protocol schema",
    });
    expect(close).toHaveBeenCalledWith(
      OBSERVATION_FATAL_CLOSE_CODE,
      "Invalid server observation",
    );
  });

  it("replaces an oversized server frame and terminates the observation", () => {
    const sent: string[] = [];
    const close = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        sent.push(payload);
      },
      close,
    } as unknown as WebSocket;

    safeSend(socket, {
      type: "extension_ui_notification",
      sessionId: randomUUID(),
      level: "info",
      message: "x".repeat(1_000),
    }, 256);

    expect(sent).toHaveLength(1);
    expect(Buffer.byteLength(sent[0]!, "utf8")).toBeLessThanOrEqual(256);
    expect(parseServerEvent(sent[0])).toEqual({
      type: "error",
      scope: "protocol",
      message: "A server event exceeded the protocol frame limit",
    });
    expect(close).toHaveBeenCalledWith(
      OBSERVATION_FATAL_CLOSE_CODE,
      "Invalid server observation",
    );
  });
});

describe("custom provider commands", () => {
  class FakeCustomProviderStore implements CustomProviderStoreLike {
    view: CustomProviderSnapshotView = {
      revision: "rev-1",
      providers: [{
        id: "lmstudio",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        api: "openai-completions",
        storedAuth: "literal",
        authEnvNames: [],
        models: [{
          id: "local-model",
          name: "Local Model",
          contextWindow: 8192,
          extraFields: [],
        }],
        extraFields: [],
        editable: true,
        builtinOverride: false,
      }],
      truncated: false,
    };

    saved: { input: CustomProviderSaveInput; expectedRevision: string }[] = [];
    deleted: { providerId: string; expectedRevision: string }[] = [];
    readCount = 0;
    failRead: Error | undefined;
    failWrite: Error | undefined;

    async read(): Promise<CustomProviderSnapshotView> {
      this.readCount++;
      if (this.failRead) throw this.failRead;
      return this.view;
    }

    async save(
      input: CustomProviderSaveInput,
      expectedRevision: string,
    ): Promise<CustomProviderSnapshotView> {
      this.saved.push({ input, expectedRevision });
      if (this.failWrite) throw this.failWrite;
      return this.view;
    }

    async delete(
      providerId: string,
      expectedRevision: string,
    ): Promise<CustomProviderSnapshotView> {
      this.deleted.push({ providerId, expectedRevision });
      if (this.failWrite) throw this.failWrite;
      return this.view;
    }
  }

  async function startFixture(
    store: FakeCustomProviderStore,
    runtime: PiRuntimeLike = new SocketTestRuntime(),
  ): Promise<{
    socketServer: ReturnType<typeof attachSocketServer>;
    url: string;
    origin: string;
    close(): Promise<void>;
  }> {
    const server = createServer();
    const socketServer = attachSocketServer(
      server,
      "E:\\work",
      runtime,
      undefined,
      false,
      undefined,
      store,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    return {
      socketServer,
      url: `ws://127.0.0.1:${address.port}/ws`,
      origin: `http://127.0.0.1:${address.port}`,
      async close() {
        const httpClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        await Promise.all([socketServer.close(), httpClosed]);
      },
    };
  }

  it("projects the models.json snapshot on demand and correlates read failures", async () => {
    const store = new FakeCustomProviderStore();
    const fixture = await startFixture(store);
    const socket = new WebSocket(fixture.url, { origin: fixture.origin });
    await nextEvent(socket);

    const commandId = randomUUID();
    const snapshot = nextEvent(socket);
    socket.send(JSON.stringify({ type: "refresh_custom_providers", commandId }));
    await expect(snapshot).resolves.toEqual({
      type: "custom_providers_snapshot",
      revision: "rev-1",
      providers: store.view.providers,
      truncated: false,
      commandId,
    });

    store.failRead = new Error("models.json is not readable");
    const failureId = randomUUID();
    const failure = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "refresh_custom_providers",
      commandId: failureId,
    }));
    const event = await failure;
    expect(event).toMatchObject({
      type: "custom_providers_snapshot",
      commandId: failureId,
      revision: "absent",
      providers: [],
    });
    expect((event as { error?: string }).error).toContain("not readable");

    await fixture.close();
    socket.terminate();
  });

  it("commits a provider through the shared configuration queue and broadcasts it", async () => {
    const store = new FakeCustomProviderStore();
    const fixture = await startFixture(store);
    const source = new WebSocket(fixture.url, { origin: fixture.origin });
    const observer = new WebSocket(fixture.url, { origin: fixture.origin });
    await nextEvent(source);
    await nextEvent(observer);

    const commandId = randomUUID();
    const input: CustomProviderSaveInput = {
      id: "lmstudio",
      name: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      auth: { kind: "local" },
      models: [{ id: "local-model", contextWindow: 8192 }],
    };
    const sourceCommitted = nextEvent(source);
    const observerCommitted = nextEvent(observer);
    source.send(JSON.stringify({
      type: "save_custom_provider",
      commandId,
      expectedRevision: "rev-1",
      provider: input,
    }));

    await expect(sourceCommitted).resolves.toMatchObject({
      type: "custom_providers_snapshot",
      revision: "rev-1",
      commandId,
    });
    await expect(observerCommitted).resolves.toMatchObject({
      type: "custom_providers_snapshot",
      revision: "rev-1",
    });
    expect(store.saved).toEqual([{ input, expectedRevision: "rev-1" }]);

    const deleteId = randomUUID();
    const deleted = nextEvent(source);
    source.send(JSON.stringify({
      type: "delete_custom_provider",
      commandId: deleteId,
      expectedRevision: "rev-1",
      providerId: "lmstudio",
    }));
    await expect(deleted).resolves.toMatchObject({
      type: "custom_providers_snapshot",
      commandId: deleteId,
    });
    expect(store.deleted).toEqual([{ providerId: "lmstudio", expectedRevision: "rev-1" }]);

    await fixture.close();
    source.terminate();
    observer.terminate();
  });

  it("reports a rejected write without broadcasting a snapshot", async () => {
    const store = new FakeCustomProviderStore();
    store.failWrite = new Error("models.json 已被外部修改");
    const fixture = await startFixture(store);
    const socket = new WebSocket(fixture.url, { origin: fixture.origin });
    await nextEvent(socket);

    const commandId = randomUUID();
    const rejected = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "save_custom_provider",
      commandId,
      expectedRevision: "stale",
      provider: {
        id: "lmstudio",
        baseUrl: "http://127.0.0.1:1234/v1",
        api: "openai-completions",
        auth: { kind: "keep" },
        models: [{ id: "local-model" }],
      },
    }));
    await expect(rejected).resolves.toMatchObject({
      type: "error",
      scope: "settings",
      operation: "save_custom_provider",
      commandId,
      message: expect.stringContaining("已被外部修改"),
    });

    // 下一个读取必须立即到达：失败写入不得广播任何快照。
    const refreshId = randomUUID();
    const refreshed = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "refresh_custom_providers",
      commandId: refreshId,
    }));
    await expect(refreshed).resolves.toMatchObject({
      type: "custom_providers_snapshot",
      commandId: refreshId,
    });

    await fixture.close();
    socket.terminate();
  });

  it("reports the write failure even when the shared refresh also fails", async () => {
    class AggregatingRuntime extends SocketTestRuntime {
      override async updateConfiguration<T>(change: () => Promise<T> | T): Promise<T> {
        try {
          return await change();
        } catch (error) {
          throw new AggregateError([error, new Error("refresh failed")], "Configuration update failed");
        }
      }
    }

    const store = new FakeCustomProviderStore();
    store.failWrite = new Error("models.json 已被外部修改，请刷新后重试");
    const fixture = await startFixture(store, new AggregatingRuntime());
    const socket = new WebSocket(fixture.url, { origin: fixture.origin });
    await nextEvent(socket);

    const commandId = randomUUID();
    const rejected = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "save_custom_provider",
      commandId,
      expectedRevision: "stale",
      provider: {
        id: "lmstudio",
        baseUrl: "http://127.0.0.1:1234/v1",
        api: "openai-completions",
        auth: { kind: "keep" },
        models: [{ id: "local-model" }],
      },
    }));
    await expect(rejected).resolves.toMatchObject({
      type: "error",
      scope: "settings",
      operation: "save_custom_provider",
      commandId,
      message: "models.json 已被外部修改，请刷新后重试",
    });

    await fixture.close();
    socket.terminate();
  });

  it("rejects a reused command id", async () => {
    const store = new FakeCustomProviderStore();
    const fixture = await startFixture(store);
    const socket = new WebSocket(fixture.url, { origin: fixture.origin });
    await nextEvent(socket);

    const commandId = randomUUID();
    const first = nextEvent(socket);
    socket.send(JSON.stringify({ type: "refresh_custom_providers", commandId }));
    await expect(first).resolves.toMatchObject({
      type: "custom_providers_snapshot",
      commandId,
    });
    const duplicate = nextEvent(socket);
    socket.send(JSON.stringify({ type: "refresh_custom_providers", commandId }));
    await expect(duplicate).resolves.toMatchObject({
      type: "error",
      commandId,
      message: "命令标识不能重复使用",
    });

    await fixture.close();
    socket.terminate();
  });

  it("probes an OpenAI-compatible model list and reports unreachable endpoints", async () => {
    const modelServer = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "probe-one" }, { id: "probe-two" }],
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") {
      throw new Error("fake model server did not bind a TCP port");
    }

    const store = new FakeCustomProviderStore();
    const fixture = await startFixture(store);
    const socket = new WebSocket(fixture.url, { origin: fixture.origin });
    await nextEvent(socket);

    const commandId = randomUUID();
    const probed = nextEvent(socket);
    const baseUrl = `http://127.0.0.1:${modelAddress.port}/v1`;
    socket.send(JSON.stringify({
      type: "probe_custom_provider_models",
      commandId,
      baseUrl,
    }));
    await expect(probed).resolves.toEqual({
      type: "custom_provider_models_probe",
      commandId,
      baseUrl,
      models: [{ id: "probe-one" }, { id: "probe-two" }],
      truncated: false,
    });
    expect(store.saved).toEqual([]);

    const failureId = randomUUID();
    const failed = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "probe_custom_provider_models",
      commandId: failureId,
      baseUrl: "http://127.0.0.1:1/v1",
    }));
    await expect(failed).resolves.toMatchObject({
      type: "error",
      scope: "settings",
      operation: "probe_custom_provider_models",
      commandId: failureId,
    });

    await fixture.close();
    socket.terminate();
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => error ? reject(error) : resolve());
    });
  });
});
