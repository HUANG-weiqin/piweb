import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  MAX_MESSAGE_BYTES,
  MAX_SERVER_EVENT_BYTES,
  parseClientCommand,
  PROTOCOL_VERSION,
  type ClientCommand,
  type ServerEvent,
} from "../shared/protocol.js";
import {
  listDirectory,
  type DirectoryBrowser,
} from "./directory-browser.js";
import { PiRuntime, type PiRuntimeLike } from "./pi-runtime.js";
import { ProjectRunCoordinator } from "./project-run-coordinator.js";
import { ProjectSessionCoordinator } from "./project-session-coordinator.js";
import {
  PiConnection,
  type PiConnectionCoordination,
} from "./pi-service.js";
import { ProjectStoreRegistry } from "./project-store.js";
import { RoleCatalog } from "./role-catalog.js";

export interface SocketServerHandle {
  readonly sockets: WebSocketServer;
  close(): Promise<void>;
}

interface DirectoryBrowserState {
  usedCommandIds: Set<string>;
}

export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.host === host
    );
  } catch {
    return false;
  }
}

const SERVER_EVENT_SERIALIZATION_ERROR = JSON.stringify({
  type: "error",
  scope: "protocol",
  message: "A server event could not be serialized",
} satisfies ServerEvent);
const SERVER_EVENT_SIZE_ERROR = JSON.stringify({
  type: "error",
  scope: "protocol",
  message: "A server event exceeded the protocol frame limit",
} satisfies ServerEvent);

export function safeSend(
  socket: WebSocket,
  event: ServerEvent,
  maximumBytes = MAX_SERVER_EVENT_BYTES,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  let payload: string;
  try {
    payload = JSON.stringify(event);
  } catch {
    payload = SERVER_EVENT_SERIALIZATION_ERROR;
  }
  if (Buffer.byteLength(payload, "utf8") > maximumBytes) {
    payload = SERVER_EVENT_SIZE_ERROR;
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
  directoryBrowser: DirectoryBrowser = listDirectory,
): SocketServerHandle {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const connections = new Map<WebSocket, PiConnection>();
  const connectionDisposals = new Map<PiConnection, Promise<void>>();
  const projects = new ProjectStoreRegistry();
  const projectRuns = new ProjectRunCoordinator();
  let coordinationPromise: Promise<PiConnectionCoordination> | undefined;
  let closePromise: Promise<void> | undefined;

  const coordination = (): Promise<PiConnectionCoordination> => {
    coordinationPromise ??= RoleCatalog.open(runtime).then((roles) => ({
      roles,
      coordinator: new ProjectSessionCoordinator(
        runtime,
        roles,
        projects,
        projectRuns,
      ),
    }));
    return coordinationPromise;
  };

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
    if (
      request.url !== "/ws"
      || !isAllowedOrigin(request.headers.origin, request.headers.host)
    ) {
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
      coordination,
    );
    connections.set(socket, connection);
    const directoryBrowserState: DirectoryBrowserState = {
      usedCommandIds: new Set(),
    };
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
        if (command.type === "browse_directory") {
          void handleDirectoryBrowserCommand(
            socket,
            command,
            directoryBrowserState,
            directoryBrowser,
            startupCwd,
          );
          return;
        }
        const sessionId = "sessionId" in command ? command.sessionId : undefined;
        const runId = "runId" in command ? command.runId : undefined;
        const conversationId = "conversationId" in command
          ? command.conversationId
          : undefined;
        const focusId = "focusId" in command ? command.focusId : undefined;
        const authFlowId = "authFlowId" in command ? command.authFlowId : undefined;
        const commandId = "commandId" in command ? command.commandId : undefined;
        void connection.handle(command).catch((error) => safeSend(socket, {
          type: "error",
          scope: "command",
          operation: command.type,
          sessionId,
          runId,
          ...(conversationId === undefined || focusId === undefined
            ? {}
            : { conversationId, focusId }),
          authFlowId,
          commandId,
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
        const failures: unknown[] = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (coordinationPromise) {
          try {
            const { coordinator, roles } = await coordinationPromise;
            try {
              await coordinator.close();
            } finally {
              roles.dispose();
            }
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to dispose WebSocket connections");
        }
      })();
      return closePromise;
    },
  };
}

async function handleDirectoryBrowserCommand(
  socket: WebSocket,
  command: Extract<ClientCommand, { type: "browse_directory" }>,
  state: DirectoryBrowserState,
  directoryBrowser: DirectoryBrowser,
  startupCwd: string,
): Promise<void> {
  if (state.usedCommandIds.has(command.commandId)) {
    safeSend(socket, {
      type: "error",
      scope: "command",
      operation: command.type,
      commandId: command.commandId,
      message: "目录选择命令标识不能重复使用",
    });
    return;
  }
  state.usedCommandIds.add(command.commandId);

  try {
    const listing = await directoryBrowser(command.path ?? startupCwd);
    safeSend(socket, {
      type: "directory_listing",
      commandId: command.commandId,
      ...listing,
    });
  } catch (error) {
    safeSend(socket, {
      type: "error",
      scope: "command",
      operation: command.type,
      commandId: command.commandId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
