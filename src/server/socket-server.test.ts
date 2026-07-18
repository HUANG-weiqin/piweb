import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { parseServerEvent, PROTOCOL_VERSION, type ServerEvent } from "../shared/protocol.js";
import type { CreatedPiSession, PiRuntimeLike } from "./pi-runtime.js";
import { attachSocketServer, isAllowedOrigin } from "./socket-server.js";

class SocketTestRuntime implements PiRuntimeLike {
  readonly authStorage = {} as AuthStorage;
  readonly modelRegistry = {} as ModelRegistry;
  subscribers = 0;

  createSession(): Promise<CreatedPiSession> {
    throw new Error("not used");
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
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedOrigin("http://localhost:31415")).toBe(true);
    expect(isAllowedOrigin("https://127.0.0.1:5173")).toBe(true);
  });

  it("rejects remote and malformed origins", () => {
    expect(isAllowedOrigin("https://example.com")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
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

    const sessionId = randomUUID();
    const commandError = nextEvent(socket);
    socket.send(JSON.stringify({
      type: "initialize",
      sessionId,
      cwd: join(tmpdir(), `piweb-missing-${randomUUID()}`),
    }));
    await expect(commandError).resolves.toMatchObject({
      type: "error",
      scope: "command",
      operation: "initialize",
      sessionId,
    });

    const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([socketServer.close(), httpClosed, clientClosed]);
    expect(runtime.subscribers).toBe(0);
  });
});
