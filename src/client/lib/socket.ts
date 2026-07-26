import { parseServerEvent, type ClientCommand, type ServerEvent } from "../../shared/protocol";

export class PiSocket {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private stopped = false;

  constructor(
    private readonly onEvent: (event: ServerEvent) => void,
    private readonly onStatus: (online: boolean) => void,
  ) {}

  connect(): void {
    this.stopped = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.onStatus(true);
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      let event: ServerEvent;
      try {
        event = parseServerEvent(String(message.data));
      } catch {
        socket.onmessage = null;
        this.onEvent({
          type: "error",
          scope: "protocol",
          message: "服务端发送了无法解析的协议消息",
        });
        socket.close();
        return;
      }
      this.onEvent(event);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.onStatus(false);
      if (!this.stopped) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = undefined;
          if (!this.stopped) this.connect();
        }, 1200);
      }
    };
    socket.onerror = () => socket.close();
  }

  send(command: ClientCommand): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(command));
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
  }
}
