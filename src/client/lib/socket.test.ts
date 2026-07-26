// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OBSERVATION_FATAL_CLOSE_CODE,
  PROTOCOL_VERSION,
} from "../../shared/protocol";
import { PiSocket } from "./socket";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onopen?: () => void;
  onmessage?: (event: MessageEvent) => void;
  onclose?: (event?: CloseEvent) => void;
  onerror?: () => void;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("PiSocket", () => {
  it("validates server frames and surfaces malformed data", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const events = vi.fn();
    const socket = new PiSocket(events, vi.fn());
    socket.connect();
    const transport = FakeWebSocket.instances[0]!;

    transport.onmessage?.({
      data: JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\work",
      }),
    } as MessageEvent);
    transport.onmessage?.({ data: "{" } as MessageEvent);

    expect(events.mock.calls[0]?.[0]).toMatchObject({ type: "hello" });
    expect(events.mock.calls[1]?.[0]).toMatchObject({
      type: "error",
      scope: "protocol",
    });
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("does not reconnect an observation rejected by the server", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const statuses = vi.fn();
    const socket = new PiSocket(vi.fn(), statuses);
    socket.connect();
    const transport = FakeWebSocket.instances[0]!;

    transport.onopen?.();
    transport.onclose?.(new CloseEvent("close", {
      code: OBSERVATION_FATAL_CLOSE_CODE,
    }));
    vi.advanceTimersByTime(1200);

    expect(statuses.mock.calls).toEqual([[true], [false]]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("ignores open and message callbacks from a replaced socket", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const events = vi.fn();
    const statuses = vi.fn();
    const socket = new PiSocket(events, statuses);
    socket.connect();
    const staleTransport = FakeWebSocket.instances[0]!;

    staleTransport.onclose?.();
    vi.advanceTimersByTime(1200);
    expect(FakeWebSocket.instances).toHaveLength(2);
    events.mockClear();
    statuses.mockClear();

    staleTransport.onopen?.();
    staleTransport.onmessage?.({
      data: JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\stale",
      }),
    } as MessageEvent);

    expect(statuses).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it("does not let an error from a replaced socket close the current socket", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const socket = new PiSocket(vi.fn(), vi.fn());
    socket.connect();
    const staleTransport = FakeWebSocket.instances[0]!;

    staleTransport.onclose?.();
    vi.advanceTimersByTime(1200);
    const currentTransport = FakeWebSocket.instances[1]!;

    staleTransport.onerror?.();

    expect(staleTransport.close).toHaveBeenCalledOnce();
    expect(currentTransport.close).not.toHaveBeenCalled();
  });

  it("does not let closes from a replaced socket change status or queue reconnects", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const statuses = vi.fn();
    const socket = new PiSocket(vi.fn(), statuses);
    socket.connect();
    const staleTransport = FakeWebSocket.instances[0]!;

    staleTransport.onclose?.();
    vi.advanceTimersByTime(1200);
    expect(FakeWebSocket.instances).toHaveLength(2);
    statuses.mockClear();

    staleTransport.onclose?.();
    staleTransport.onclose?.();
    vi.advanceTimersByTime(1200);

    expect(statuses).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
