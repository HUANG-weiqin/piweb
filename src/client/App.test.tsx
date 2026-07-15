// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientCommand, ServerEvent } from "../shared/protocol";
import { App } from "./App";

const socketMock = vi.hoisted(() => ({
  emit: undefined as ((event: ServerEvent) => void) | undefined,
  status: undefined as ((online: boolean) => void) | undefined,
  send: vi.fn((_command: ClientCommand) => true),
}));

vi.mock("./lib/socket", () => ({
  PiSocket: class {
    constructor(onEvent: (event: ServerEvent) => void, onStatus: (online: boolean) => void) {
      socketMock.emit = onEvent;
      socketMock.status = onStatus;
    }

    connect() {
      socketMock.status?.(true);
      socketMock.emit?.({ type: "hello", startupCwd: "E:\\default" });
    }

    send(command: ClientCommand) {
      socketMock.send(command);
      return true;
    }

    close() {}
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  socketMock.emit = undefined;
  socketMock.status = undefined;
  socketMock.send.mockClear();
});

describe("App", () => {
  it("still renders setup when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage blocked");
    });

    render(<App />);

    expect(screen.getByRole("textbox", { name: "工作目录" })).toHaveValue("E:\\default");
  });

  it("still enters chat when saving the last working directory fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("localStorage blocked");
    });

    render(<App />);

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeInTheDocument();
  });
});
