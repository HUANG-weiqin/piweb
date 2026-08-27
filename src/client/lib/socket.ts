import {
  OBSERVATION_FATAL_CLOSE_CODE,
  parseServerEvent,
  type ClientCommand,
  type ServerEvent,
} from "../../shared/protocol";

const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5_000;
const RECONNECT_STABLE_WINDOW_MS = 10_000;

export class PiSocket {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private reconnectResetTimer?: number;
  private nextReconnectDelayMs = 0;
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
    if (this.reconnectResetTimer !== undefined) {
      clearTimeout(this.reconnectResetTimer);
      this.reconnectResetTimer = undefined;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.onStatus(true);
      if (this.nextReconnectDelayMs > 0) {
        this.reconnectResetTimer = window.setTimeout(() => {
          this.reconnectResetTimer = undefined;
          if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
            this.nextReconnectDelayMs = 0;
          }
        }, RECONNECT_STABLE_WINDOW_MS);
      }
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
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.reconnectResetTimer !== undefined) {
        clearTimeout(this.reconnectResetTimer);
        this.reconnectResetTimer = undefined;
      }
      this.onStatus(false);
      if (!this.stopped && event?.code !== OBSERVATION_FATAL_CLOSE_CODE) {
        const delay = this.nextReconnectDelayMs;
        this.nextReconnectDelayMs = delay === 0
          ? RECONNECT_BASE_DELAY_MS
          : Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = undefined;
          if (!this.stopped) this.connect();
        }, delay);
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
    if (this.reconnectResetTimer !== undefined) {
      clearTimeout(this.reconnectResetTimer);
      this.reconnectResetTimer = undefined;
    }
    this.socket?.close();
  }
}
