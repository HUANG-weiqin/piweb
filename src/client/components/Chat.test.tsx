// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRoleSnapshot } from "../../shared/protocol";
import type { ChatState } from "../chat/reducer";
import { Chat } from "./Chat";

const emptyChat: ChatState = { messages: [], sessionTokens: 0 };

function view(
  chat: ChatState,
  draft = "",
  role?: ConversationRoleSnapshot,
) {
  return <Chat
    chat={chat}
    historyTruncated={false}
    busy={false}
    billedTokenCount={0}
    contextTokenCount={0}
    contextWindow={100_000}
    contextSource="measured"
    model={{ provider: "provider", id: "model" }}
    role={role}
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
});

describe("Chat", () => {
  it("scrolls the transcript itself to the actual bottom while following output", () => {
    const rendered = render(view(emptyChat));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTo: { configurable: true, value: scrollTo },
    });

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

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000 });
    expect(screen.queryByRole("button", { name: "↓ 回到最新消息" })).not.toBeInTheDocument();
  });

  it("does not drag the reader to the bottom while new output streams", () => {
    const rendered = render(view(emptyChat));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 200 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.scroll(transcript);

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

    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "↓ 回到最新消息" }));
    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 1_000,
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

  it("shows the frozen role at the composer footer and opens read-only details", () => {
    const role: ConversationRoleSnapshot = {
      id: "default",
      revision: 3,
      name: "Reviewer",
      description: "Reviews changes",
      systemPrompt: "Review exact evidence.",
      model: { provider: "provider", id: "model" },
    };
    render(view(emptyChat, "", role));

    fireEvent.click(screen.getByRole("button", {
      name: "查看会话角色 Reviewer",
    }));

    expect(screen.getByRole("dialog", { name: "会话角色" }))
      .toHaveTextContent("Review exact evidence.");
    expect(screen.queryByRole("button", { name: /切换/ }))
      .not.toBeInTheDocument();
  });
});
