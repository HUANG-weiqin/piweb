import { randomUUID } from "node:crypto";
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
  type ServerEvent,
} from "../shared/protocol.js";
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
      "http://127.0.0.1:5173",
      "127.0.0.1:5173",
    )).toBe(true);
    expect(isAllowedOrigin(
      "http://localhost:31415",
      "localhost:31415",
    )).toBe(true);
    expect(isAllowedOrigin(
      "https://127.0.0.1:5173",
      "127.0.0.1:5173",
    )).toBe(true);
  });

  it("rejects remote and malformed origins", () => {
    expect(isAllowedOrigin("https://example.com", "example.com")).toBe(false);
    expect(isAllowedOrigin("not a url", "127.0.0.1:31415")).toBe(false);
    expect(isAllowedOrigin(
      "http://127.0.0.1:5173",
      "127.0.0.1:31415",
    )).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:31415", undefined)).toBe(false);
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

    await expect(socketServer.resumeAfterReload([{
      cwd: "E:\\work",
      conversationId: randomUUID(),
      continueTask: true,
    }])).rejects.toThrow("role catalog unavailable");
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
    const promptError = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "prompt",
      sessionId,
      conversationId: promptConversationId,
      focusId: promptFocusId,
      runId: promptRunId,
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
