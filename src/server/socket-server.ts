import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_MESSAGE_BYTES, parseClientCommand, type ServerEvent } from "../shared/protocol.js";
import { PiConnection } from "./pi-service.js";

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
  try {
    socket.send(JSON.stringify(event));
  } catch {
    // A disconnected browser will trigger normal socket cleanup.
  }
}

export function attachSocketServer(server: Server, startupCwd: string): WebSocketServer {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws" || !isAllowedOrigin(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  });

  sockets.on("connection", (socket) => {
    const connection = new PiConnection((event) => safeSend(socket, event));
    safeSend(socket, { type: "hello", startupCwd });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        safeSend(socket, { type: "error", message: "Binary messages are not supported" });
        return;
      }
      try {
        const command = parseClientCommand(data.toString("utf8"));
        void connection.handle(command).catch((error) => safeSend(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        }));
      } catch (error) {
        safeSend(socket, { type: "error", message: error instanceof Error ? error.message : "Invalid command" });
      }
    });

    socket.on("close", () => void connection.dispose());
    socket.on("error", () => void connection.dispose());
  });

  return sockets;
}
