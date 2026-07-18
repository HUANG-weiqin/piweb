// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../chat/reducer";
import { Chat } from "./Chat";

const emptyChat: ChatState = { messages: [], sessionTokens: 0 };
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);

function view(chat: ChatState, draft = "") {
  return <Chat
    chat={chat}
    historyTruncated={false}
    busy={false}
    billedTokenCount={0}
    contextTokenCount={0}
    contextWindow={100_000}
    contextSource="measured"
    model={{ provider: "provider", id: "model" }}
    cwd="E:\\work"
    online
    conversationReady
    draft={draft}
    submitting={false}
    onDraftChange={() => undefined}
    onSend={() => true}
    onAbort={() => undefined}
    onSettings={() => undefined}
    onChangeCwd={() => undefined}
  />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollIntoView) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

describe("Chat", () => {
  it("does not drag the reader to the bottom while new output streams", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const rendered = render(view(emptyChat));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });
    fireEvent.scroll(transcript);
    scrollIntoView.mockClear();

    rendered.rerender(view({
      messages: [{
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "new output",
        thinking: "",
        tools: [],
      }],
      sessionTokens: 0,
    }));

    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "↓ 回到最新消息" }));
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "end",
    });
  });

  it("grows the controlled composer with its content", () => {
    const rendered = render(view(emptyChat));
    const textarea = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 120,
    });

    rendered.rerender(view(emptyChat, "first line\nsecond line\nthird line"));

    expect(textarea).toHaveStyle({ height: "120px" });
  });
});
