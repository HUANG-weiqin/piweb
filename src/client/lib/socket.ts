import type { ClientCommand, ServerEvent } from "../../shared/protocol";

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
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket.onopen = () => this.onStatus(true);
    this.socket.onmessage = (message) => {
      try { this.onEvent(JSON.parse(String(message.data)) as ServerEvent); } catch { /* Ignore malformed server data. */ }
    };
    this.socket.onclose = () => {
      this.onStatus(false);
      if (!this.stopped) this.reconnectTimer = window.setTimeout(() => this.connect(), 1200);
    };
    this.socket.onerror = () => this.socket?.close();
  }

  send(command: ClientCommand): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(command));
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}
