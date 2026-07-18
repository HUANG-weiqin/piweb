import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_MESSAGE_BYTES, parseClientCommand, PROTOCOL_VERSION, type ServerEvent } from "../shared/protocol.js";
import { PiRuntime, type PiRuntimeLike } from "./pi-runtime.js";
import { ProjectRunCoordinator } from "./project-run-coordinator.js";
import { PiConnection } from "./pi-service.js";
import { ProjectStoreRegistry } from "./project-store.js";

export interface SocketServerHandle {
  readonly sockets: WebSocketServer;
  close(): Promise<void>;
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function safeSend(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  let payload: string;
  try {
    payload = JSON.stringify(event);
  } catch {
    if (event.type !== "error") {
      safeSend(socket, {
        type: "error",
        scope: "protocol",
        message: "A server event could not be serialized",
      });
    }
    return;
  }
  try {
    socket.send(payload);
  } catch {
    // A disconnected browser will trigger normal socket cleanup.
  }
}

export function attachSocketServer(
  server: Server,
  startupCwd: string,
  runtime: PiRuntimeLike = new PiRuntime(),
): SocketServerHandle {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const connections = new Map<WebSocket, PiConnection>();
  const connectionDisposals = new Map<PiConnection, Promise<void>>();
  const projects = new ProjectStoreRegistry();
  const projectRuns = new ProjectRunCoordinator();
  let closePromise: Promise<void> | undefined;

  const disposeConnection = (socket: WebSocket, connection: PiConnection): Promise<void> => {
    connections.delete(socket);
    const existing = connectionDisposals.get(connection);
    if (existing) return existing;
    const disposal = connection.dispose();
    connectionDisposals.set(connection, disposal);
    const forget = () => connectionDisposals.delete(connection);
    void disposal.then(forget, forget);
    return disposal;
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (request.url !== "/ws" || !isAllowedOrigin(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  };
  server.on("upgrade", onUpgrade);

  sockets.on("connection", (socket) => {
    const connection = new PiConnection(
      (event) => safeSend(socket, event),
      runtime,
      undefined,
      projects,
      projectRuns,
    );
    connections.set(socket, connection);
    safeSend(socket, { type: "hello", protocolVersion: PROTOCOL_VERSION, startupCwd });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        safeSend(socket, {
          type: "error",
          scope: "protocol",
          message: "Binary messages are not supported",
        });
        return;
      }
      try {
        const command = parseClientCommand(data.toString("utf8"));
        const sessionId = "sessionId" in command ? command.sessionId : undefined;
        const runId = "runId" in command ? command.runId : undefined;
        const authFlowId = "authFlowId" in command ? command.authFlowId : undefined;
        void connection.handle(command).catch((error) => safeSend(socket, {
          type: "error",
          scope: "command",
          operation: command.type,
          sessionId,
          runId,
          authFlowId,
          message: error instanceof Error ? error.message : String(error),
        }));
      } catch (error) {
        safeSend(socket, {
          type: "error",
          scope: "protocol",
          message: error instanceof Error ? error.message : "Invalid command",
        });
      }
    });

    let disposalStarted = false;
    const dispose = () => {
      if (disposalStarted) return;
      disposalStarted = true;
      void disposeConnection(socket, connection).catch((error) => {
        console.error("Failed to dispose Pi connection", error);
      });
    };
    socket.on("close", dispose);
    socket.on("error", dispose);
  });

  return {
    sockets,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        server.off("upgrade", onUpgrade);
        const activeConnections = [...connections.entries()];
        const disposals = [
          ...connectionDisposals.values(),
          ...activeConnections.map(([socket, connection]) => disposeConnection(socket, connection)),
        ];
        const socketsClosed = new Promise<void>((resolve, reject) => {
          sockets.close((error) => error ? reject(error) : resolve());
        });
        for (const socket of sockets.clients) socket.terminate();
        const results = await Promise.allSettled(disposals);
        await socketsClosed;
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to dispose WebSocket connections");
        }
      })();
      return closePromise;
    },
  };
}
