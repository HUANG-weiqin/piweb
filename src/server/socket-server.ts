import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  MAX_MESSAGE_BYTES,
  MAX_SERVER_EVENT_BYTES,
  OBSERVATION_FATAL_CLOSE_CODE,
  parseClientCommand,
  PROTOCOL_VERSION,
  serverEventSchema,
  type ClientCommand,
  type ColorScheme,
  type ServerEvent,
  type UiPreferences,
} from "../shared/protocol.js";
import {
  listDirectory,
  type DirectoryBrowser,
} from "./directory-browser.js";
import type { PiRuntimeLike } from "./pi-runtime.js";
import {
  ProjectSessionCoordinator,
  type ReloadConversationTarget,
  type ReloadResumeDisposition,
  type ReloadTargetCompletion,
} from "./project-session-coordinator.js";
import {
  PiConnection,
  type PiConnectionCoordination,
} from "./pi-service.js";
import { ProjectStoreRegistry } from "./project-store.js";
import { RoleCatalog } from "./role-catalog.js";
import { UiPreferencesStore } from "./ui-preferences-store.js";

export interface UiPreferencesStoreLike {
  get(): UiPreferences;
  setColorScheme(colorScheme: ColorScheme): Promise<UiPreferences>;
}

export interface SocketServerHandle {
  readonly sockets: WebSocketServer;
  prepareReload(
    force: boolean,
    onAdmissionFrozen: () => void,
  ): Promise<ReloadConversationTarget[]>;
  resumeAfterReload(
    requestId: string,
    targets: readonly ReloadConversationTarget[],
    onTargetCompleted: (completion: ReloadTargetCompletion) => Promise<void>,
  ): Promise<ReloadResumeDisposition[]>;
  acknowledgeReloadDispositions(
    requestId: string,
    dispositions: readonly ReloadResumeDisposition[],
  ): Promise<void>;
  releaseStartupAdmission(): void;
  close(): Promise<void>;
}

interface SocketControlState {
  usedCommandIds: Set<string>;
}

export function isAllowedOrigin(
  origins: readonly string[] | undefined,
  hosts: readonly string[] | undefined,
  tailscaleUserLogins?: readonly string[],
): boolean {
  if (origins?.length !== 1 || hosts?.length !== 1) return false;
  const origin = origins[0]!;
  const host = hosts[0]!;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.host !== host) return false;
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return url.protocol === "http:" || url.protocol === "https:";
    }
    return url.protocol === "https:"
      && url.hostname.endsWith(".ts.net")
      && tailscaleUserLogins?.length === 1
      && tailscaleUserLogins[0]!.trim().length > 0;
  } catch {
    return false;
  }
}

const SERVER_EVENT_SCHEMA_ERROR = JSON.stringify({
  type: "error",
  scope: "protocol",
  message: "A server event violated the protocol schema",
} satisfies ServerEvent);
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
  let invalidObservation = false;
  try {
    const parsed = serverEventSchema.safeParse(event);
    if (parsed.success) {
      payload = JSON.stringify(parsed.data);
    } else {
      payload = SERVER_EVENT_SCHEMA_ERROR;
      invalidObservation = true;
    }
  } catch {
    payload = SERVER_EVENT_SERIALIZATION_ERROR;
    invalidObservation = true;
  }
  if (Buffer.byteLength(payload, "utf8") > maximumBytes) {
    payload = SERVER_EVENT_SIZE_ERROR;
    invalidObservation = true;
  }
  try {
    socket.send(payload);
  } catch {
    // A disconnected browser will trigger normal socket cleanup.
    return;
  }
  if (invalidObservation) {
    try {
      socket.close(
        OBSERVATION_FATAL_CLOSE_CODE,
        "Invalid server observation",
      );
    } catch {
      // A concurrently disconnected browser already owns cleanup.
    }
  }
}

export function attachSocketServer(
  server: Server,
  startupCwd: string,
  runtime: PiRuntimeLike,
  directoryBrowser: DirectoryBrowser = listDirectory,
  blockStartupAdmission = false,
  uiPreferences: UiPreferencesStoreLike = UiPreferencesStore.memory(),
): SocketServerHandle {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const connections = new Map<WebSocket, PiConnection>();
  const connectionDisposals = new Map<PiConnection, Promise<void>>();
  const projects = new ProjectStoreRegistry();
  let coordinationPromise: Promise<PiConnectionCoordination> | undefined;
  let closePromise: Promise<void> | undefined;
  let startupAdmissionBlocked = blockStartupAdmission;
  let socketMutationAdmissionFrozen = false;
  const activeColorSchemeCommands = new Set<Promise<void>>();
  const waitForColorSchemeCommands = async (): Promise<void> => {
    while (activeColorSchemeCommands.size > 0) {
      await Promise.all([...activeColorSchemeCommands]);
    }
  };

  const coordination = (): Promise<PiConnectionCoordination> => {
    coordinationPromise ??= RoleCatalog.open(runtime).then((roles) => ({
      roles,
      coordinator: new ProjectSessionCoordinator(
        runtime,
        roles,
        projects,
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
      || !isAllowedOrigin(
        request.headersDistinct.origin,
        request.headersDistinct.host,
        request.headersDistinct["tailscale-user-login"],
      )
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (startupAdmissionBlocked) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n",
      );
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
      coordination,
    );
    connections.set(socket, connection);
    const socketControlState: SocketControlState = {
      usedCommandIds: new Set(),
    };
    safeSend(socket, {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd,
      uiPreferences: uiPreferences.get(),
    });

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
            socketControlState,
            directoryBrowser,
            startupCwd,
          );
          return;
        }
        if (command.type === "set_color_scheme") {
          const task = handleColorSchemeCommand(
            socket,
            command,
            socketControlState,
            uiPreferences,
            sockets,
            !socketMutationAdmissionFrozen,
          );
          activeColorSchemeCommands.add(task);
          void task.then(
            () => activeColorSchemeCommands.delete(task),
            () => activeColorSchemeCommands.delete(task),
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
    async prepareReload(force, onAdmissionFrozen) {
      socketMutationAdmissionFrozen = true;
      if (!coordinationPromise) {
        if (!force) await waitForColorSchemeCommands();
        onAdmissionFrozen();
        return [];
      }
      const { coordinator } = await coordinationPromise;
      let signalCoordinatorFrozen: (() => void) | undefined;
      let rejectCoordinatorFrozen: ((error: unknown) => void) | undefined;
      const coordinatorFrozen = new Promise<void>((resolve, reject) => {
        signalCoordinatorFrozen = resolve;
        rejectCoordinatorFrozen = reject;
      });
      const targets = coordinator.prepareReload(force, () => {
        signalCoordinatorFrozen?.();
      });
      void targets.catch((error) => rejectCoordinatorFrozen?.(error));
      await coordinatorFrozen;
      if (!force) await waitForColorSchemeCommands();
      onAdmissionFrozen();
      return targets;
    },
    async resumeAfterReload(requestId, targets, onTargetCompleted) {
      if (targets.length === 0) return [];
      const { coordinator } = await coordination();
      return coordinator.resumeAfterReload(
        requestId,
        targets,
        onTargetCompleted,
      );
    },
    async acknowledgeReloadDispositions(requestId, dispositions) {
      const { coordinator } = await coordination();
      await coordinator.acknowledgeReloadDispositions(
        requestId,
        dispositions,
      );
    },
    releaseStartupAdmission() {
      startupAdmissionBlocked = false;
    },
    close() {
      if (closePromise) return closePromise;
      socketMutationAdmissionFrozen = true;
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
        const results = await Promise.allSettled([
          ...disposals,
          waitForColorSchemeCommands(),
        ]);
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
  state: SocketControlState,
  directoryBrowser: DirectoryBrowser,
  startupCwd: string,
): Promise<void> {
  if (state.usedCommandIds.has(command.commandId)) {
    safeSend(socket, {
      type: "error",
      scope: "command",
      operation: command.type,
      commandId: command.commandId,
      message: "命令标识不能重复使用",
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

async function handleColorSchemeCommand(
  socket: WebSocket,
  command: Extract<ClientCommand, { type: "set_color_scheme" }>,
  state: SocketControlState,
  store: UiPreferencesStoreLike,
  sockets: WebSocketServer,
  admissionAllowed: boolean,
): Promise<void> {
  if (state.usedCommandIds.has(command.commandId)) {
    safeSend(socket, {
      type: "error",
      scope: "command",
      operation: command.type,
      commandId: command.commandId,
      message: "命令标识不能重复使用",
    });
    return;
  }
  state.usedCommandIds.add(command.commandId);
  if (!admissionAllowed) {
    safeSend(socket, {
      type: "error",
      scope: "command",
      operation: command.type,
      commandId: command.commandId,
      message: "服务正在重新加载，暂不接受新的设置修改",
    });
    return;
  }

  try {
    const preferences = await store.setColorScheme(command.colorScheme);
    for (const client of sockets.clients) {
      safeSend(client, {
        type: "ui_preferences_changed",
        uiPreferences: preferences,
        ...(client === socket ? { commandId: command.commandId } : {}),
      });
    }
  } catch (error) {
    safeSend(socket, {
      type: "error",
      scope: "settings",
      operation: command.type,
      commandId: command.commandId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
