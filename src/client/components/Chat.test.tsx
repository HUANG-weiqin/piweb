// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationMessageCard,
  ConversationRoleSnapshot,
  PendingPromptAdmissionSnapshot as PendingAdmission,
} from "../../shared/protocol";
import {
  chatReducer,
  initialChatState,
  type ChatMessage,
  type ChatMessageItem,
  type ChatState,
} from "../chat/reducer";
import { Chat } from "./Chat";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

function messageItems(...messages: ChatMessage[]): ChatMessageItem[] {
  return messages.map((message) => ({ kind: "message", ...message }));
}

function firstMessage(chat: ChatState): ChatMessage {
  const item = chat.items[0];
  if (!item || item.kind !== "message") throw new Error("message not found");
  return item;
}

const emptyChat: ChatState = { items: [] };

function view(
  chat: ChatState,
  draft = "",
  role?: ConversationRoleSnapshot,
  overrides: Partial<ComponentProps<typeof Chat>> = {},
) {
  return <Chat
    chat={chat}
    observationSessionId={chat.focus?.sessionId ?? "unfocused-session"}
    busy={false}
    sessionTokenUsage={{
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    }}
    contextTokenCount={0}
    contextWindow={100_000}
    contextPercent={0}
    contextSource="measured"
    model={{ provider: "provider", id: "model" }}
    role={role}
    roles={[]}
    roleSwitchDisabled={false}
    roleSwitching={false}
    thinkingLevel="off"
    availableThinkingLevels={["off", "high"]}
    serviceTiers={[]}
    selectedServiceTier={null}
    serviceTierBusy={false}
    compactionThresholdPercent={70}
    compactionThresholdBusy={false}
    cwd="E:\\work"
    online
    conversationReady
    draft={draft}
    submitting={false}
    pendingAdmissions={[]}
    onDraftChange={() => undefined}
    onSend={() => true}

    onAbort={() => undefined}
    onSettings={() => undefined}
    onThinking={() => undefined}
    onServiceTier={() => undefined}
    onCompactionThreshold={() => true}
    onCompact={() => true}
    onSwitchRole={() => true}
    onChangeCwd={() => undefined}
    onRewind={() => true}
    {...overrides}
  />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Chat", () => {
  it("scopes transcript item identity to the session and conversation, not the focus", () => {
    const message = (text: string) => ({
      id: "stable-message-id",
      runId: "run-1",
      role: "user" as const,
      text,
      thinking: "",
      tools: [],
    });
    const focus = {
      sessionId: "session-1",
      conversationId: "conversation-a",
      focusId: "focus-preview",
    };
    const rendered = render(view({
      items: messageItems(message("preview")),
      focus,
    }, "", undefined, { conversationReady: false }));
    const previewArticle = screen.getByText("preview", { selector: "article" });

    rendered.rerender(view({
      items: messageItems(message("authoritative")),
      focus: { ...focus, focusId: "focus-authoritative" },
    }));
    const authoritativeArticle = screen.getByText("authoritative", {
      selector: "article",
    });
    expect(authoritativeArticle).toBe(previewArticle);

    rendered.rerender(view({
      items: messageItems(message("other conversation")),
      focus: {
        ...focus,
        conversationId: "conversation-b",
        focusId: "focus-b",
      },
    }));
    const otherConversationArticle = screen.getByText("other conversation", {
      selector: "article",
    });
    expect(otherConversationArticle).not.toBe(authoritativeArticle);

    rendered.rerender(view({
      items: messageItems(message("other session")),
      focus: {
        sessionId: "session-2",
        conversationId: "conversation-b",
        focusId: "focus-c",
      },
    }));
    expect(screen.getByText("other session", { selector: "article" }))
      .not.toBe(otherConversationArticle);
  });

  it("labels only the latest same-run assistant as active", () => {
    const runId = "run-with-steering";
    const role = {
      id: "tech-lead",
      revision: 1,
      name: "Tech Lead",
      description: "",
      systemPrompt: "",
      model: { provider: "provider", id: "model" },
      defaultThinkingLevel: "off" as const,
      defaultServiceTier: null,
      toolMode: "read_only" as const,
      canManageSessions: false,
    };
    const assistant = (id: string, text: string): ChatMessage => ({
      id,
      runId,
      role: "assistant",
      text,
      thinking: "",
      tools: [],
    });
    const { container } = render(view({
      items: messageItems(
        assistant("assistant-before-steer", "before steer"),
        {
          id: "steering-user",
          runId,
          role: "user",
          text: "steer",
          thinking: "",
          tools: [],
        },
        assistant("assistant-after-steer", "after steer"),
      ),
    }, "", role, {
      busy: true,
      activeRun: { id: runId, phase: "waiting" },
    }));
    const assistantMessages = container.querySelectorAll(".message.assistant");

    expect(assistantMessages[0]?.querySelector(".message-event-header"))
      .toHaveTextContent("AGENTAgentLOGGED");
    expect(assistantMessages[1]?.querySelector(".message-event-header"))
      .toHaveTextContent("AGENTTech LeadWAITING");
  });

  it("updates an edit commitment from later same-run budget facts", () => {
    const runId = "run-edit-budget";
    const budgetMessage: ChatMessage = {
      id: "budget-message",
      runId,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [{
        id: "budget",
        name: "request_edit_budget",
        args: { fileCount: 2, reason: "修改两个文件。" },
        result: {
          details: {
            outcome: "edit_budget_granted",
            addedFiles: 2,
            remainingFiles: 2,
          },
        },
        status: "done",
      }],
    };
    const guidanceMessage: ChatMessage = {
      id: "guidance-message",
      runId,
      role: "user",
      text: "继续处理。",
      thinking: "",
      tools: [],
    };
    const mutationMessage = (remainingFiles?: number): ChatMessage => ({
      id: "mutation-message",
      runId,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [{
        id: "edit",
        name: "edit",
        result: remainingFiles === undefined
          ? { truncated: true, preview: "large result omitted" }
          : {
              details: {
                piwebEditBudget: { remainingFiles },
              },
            },
        status: "done",
      }],
    });

    const rendered = render(view({
      items: messageItems(budgetMessage),
    }));
    expect(screen.getByText("本轮剩余 2")).toBeInTheDocument();

    rendered.rerender(view({
      items: messageItems(
        budgetMessage,
        guidanceMessage,
        mutationMessage(1),
      ),
    }));
    expect(screen.getByText("本轮剩余 1")).toBeInTheDocument();
    expect(screen.queryByText("本轮剩余 2")).not.toBeInTheDocument();

    rendered.rerender(view({
      items: messageItems(
        budgetMessage,
        guidanceMessage,
        mutationMessage(0),
      ),
    }));
    expect(screen.getByText("本轮剩余 0")).toBeInTheDocument();

    rendered.rerender(view({
      items: messageItems(
        budgetMessage,
        guidanceMessage,
        mutationMessage(),
      ),
    }));
    expect(screen.getByText("本轮剩余未知")).toBeInTheDocument();
  });

  it("shows onboarding only after an empty conversation is ready", () => {
    const rendered = render(view(emptyChat, "", undefined, {
      conversationReady: false,
    }));

    expect(screen.queryByRole("heading", { name: "想做点什么？" }))
      .not.toBeInTheDocument();

    rendered.rerender(view(emptyChat));

    expect(screen.getByRole("heading", { name: "想做点什么？" }))
      .toBeInTheDocument();
  });

  it("shows the focused Agent under its root task without inventing missing context", () => {
    const rendered = render(view(emptyChat, "", undefined, {
      conversationContext: {
        rootTitle: "修复登录任务",
        currentTitle: "测试 Agent",
        ordinal: 1,
        agentCount: 4,
      },
      busy: true,
      activeRun: { id: "run-header", phase: "running" },
    }));

    expect(screen.getByRole("navigation", { name: "协作路径" }))
      .toHaveTextContent("修复登录任务›测试 Agent");
    expect(screen.getByText("测试 Agent")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("01", { selector: ".topbar-session-ordinal" }))
      .toBeInTheDocument();
    expect(screen.getByText("4 AGENTS")).toBeInTheDocument();
    expect(screen.getByLabelText("会话状态：IN PROGRESS"))
      .toHaveTextContent("STATUSIN PROGRESS");

    rendered.rerender(view(emptyChat, "", undefined, {
      conversationContext: { rootTitle: "修复登录任务" },
    }));
    expect(screen.getByText("修复登录任务")).toHaveAttribute(
      "aria-current",
      "page",
    );

    rendered.rerender(view(emptyChat));
    expect(screen.queryByRole("navigation", { name: "协作路径" }))
      .not.toBeInTheDocument();
  });

  it("mounts no Tasks panel or height when the list is absent or empty", () => {
    const { rerender } = render(view(emptyChat));
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();

    rerender(view(emptyChat, "", undefined, {
      loopList: { items: [], armed: true },
    }));
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
  });

  it("shows tri-state Tasks without conflating item activity with run execution", () => {
    const loopList = {
      items: [
        { id: "done", text: "Finished item", status: "completed" as const },
        { id: "active-one", text: "Active item one", status: "active" as const },
        { id: "active-two", text: "Active item two", status: "active" as const },
        { id: "next", text: "Pending item", status: "pending" as const },
      ],
      armed: false,
    };
    const { rerender } = render(view(emptyChat, "", undefined, {
      loopList,
      busy: true,
    }));
    const toggle = screen.getByRole("button", { name: /Tasks/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expect(screen.getByText("1/4 · 3 项未完成")).toBeInTheDocument();
    expect(screen.queryByText("Pending item")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "已完成" })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "进行中" })).toHaveLength(2);
    expect(screen.getByRole("img", { name: "待处理" })).toBeInTheDocument();
    expect(screen.getByText("Active item one").closest("li"))
      .toHaveClass("active");
    expect(screen.getByText("Finished item").closest("li"))
      .toHaveClass("completed");
    expect(Array.from(screen.getAllByRole("listitem"), (item) =>
      item.querySelector(".loop-list-item-text")?.textContent,
    )).toEqual([
      "Finished item",
      "Active item one",
      "Active item two",
      "Pending item",
    ]);

    rerender(view(emptyChat, "", undefined, {
      loopList: { ...loopList, armed: true },
      busy: true,
    }));
    expect(screen.getByRole("button", { name: /Tasks/ }))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "进行中" })).toHaveLength(2);

    rerender(view(emptyChat, "", undefined, {
      loopList: {
        items: loopList.items.map((item) => ({
          ...item,
          status: "completed" as const,
        })),
        armed: false,
      },
    }));
    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("4/4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tasks/ }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("publishes composer height and keeps followed output above its inset", () => {
    const observe = vi.fn();
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = observe;
      disconnect() {}
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const scrollTo = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, right: 600, bottom: 220,
      left: 0, width: 600, height: 220, toJSON: () => ({}),
    });

    const { container } = render(view(emptyChat, "", undefined, {
      loopList: {
        items: [{ id: "measure", text: "Measure", status: "pending" }],
        armed: false,
      },
    }));

    expect(observe).toHaveBeenCalledOnce();
    expect(container.querySelector(".app-shell"))
      .toHaveStyle("--composer-inset: 220px");
    const transcript = container.querySelector(".transcript") as HTMLElement;
    transcript.scrollTo = scrollTo;
    resize?.([], {} as ResizeObserver);
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("offers manual context compaction below the composer", () => {
    const onCompact = vi.fn(() => true);
    render(view(emptyChat, "", undefined, { onCompact }));

    fireEvent.click(screen.getByRole("button", { name: "手动压缩上下文" }));

    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("does not render a history-window notice", () => {
    render(view(emptyChat));

    expect(screen.queryByRole("note", { name: "历史记录不完整" })).toBeNull();
  });

  it("shows animated compaction progress inside the transcript", () => {
    const { container } = render(view(emptyChat, "", undefined, {
      compacting: true,
    }));

    const progress = screen.getByRole("status", {
      name: "正在压缩上下文",
    });
    expect(progress).toHaveTextContent("正在压缩上下文");
    expect(container.querySelector(".transcript")?.lastElementChild)
      .toBe(progress);
    expect(progress.querySelector(".compaction-spinner")).toBeInTheDocument();
  });

  it("keeps send and stop available while the Agent is busy", () => {
    const onSend = vi.fn(() => true);
    const onAbort = vi.fn();
    render(view(emptyChat, "next instruction", undefined, {
      busy: true,
      activeRun: {
        id: "run-1",
        phase: "running",
      },
      onSend,
      onAbort,
    }));

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute(
      "placeholder",
      "发送后将排队等待处理…",
    );

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("next instruction");

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("shows admitted prompts above Tasks while the agent is busy", () => {
    const admissions: PendingAdmission[] = [{
      promptId: "queued-1",
      text: "Review the test failure after the current run.",
    }, {
      promptId: "queued-2",
      text: "This delivery is in progress.",
    }];
    render(view(emptyChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
      pendingAdmissions: admissions,
      loopList: {
        items: [{ id: "active", text: "Finish current work", status: "active" }],
        armed: true,
      },
    }));

    const queue = screen.getByRole("region", { name: "等待处理的消息" });
    const loopList = screen.getByRole("region", { name: "Tasks" });
    expect(queue).toHaveTextContent("Review the test failure after the current run.");
    expect(queue).toHaveTextContent("This delivery is in progress.");
    expect(queue).toHaveTextContent("等待中");
    expect(queue.textContent).not.toContain("撤回");
    expect(queue.textContent).not.toContain("Steer");
    expect(queue.nextElementSibling).toBe(loopList);
  });

  it("lets streamed output grow inside the follow comfort zone", () => {
    const rendered = render(view(emptyChat));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 460 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    rendered.rerender(view({
      items: messageItems({
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "new output",
        thinking: "",
        tools: [],
      }),
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "↓ 回到最新消息" })).not.toBeInTheDocument();
  });

  it("softly catches up after streamed output crosses the comfort zone", () => {
    const rendered = render(view(emptyChat));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 360 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    rendered.rerender(view({
      items: messageItems({
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "new output",
        thinking: "",
        tools: [],
      }),
    }));

    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 468,
    });
  });

  it("jumps directly to the latest message before a focus or presentation first paints", () => {
    const focusA = {
      sessionId: "session-1",
      conversationId: "conversation-a",
      focusId: "focus-a",
    };
    const focusB = {
      ...focusA,
      conversationId: "conversation-b",
      focusId: "focus-b",
    };
    const previewFocusB = {
      ...focusB,
      focusId: "preview:conversation-b",
    };
    const rendered = render(view({ ...emptyChat, focus: focusA }, "", undefined, {
      conversationReady: false,
    }));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    let scrollHeight = 1_000;
    let scrollTop = 0;
    const clientHeight = 500;
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      if (options.behavior === "smooth") return;
      scrollTop = Math.min(
        Number(options.top ?? 0),
        scrollHeight - clientHeight,
      );
    });
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: clientHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
      scrollTo: { configurable: true, value: scrollTo },
    });
    const hydratedMessage = {
      id: "assistant-1",
      runId: "history:assistant-1",
      role: "assistant" as const,
      text: "latest message",
      thinking: "",
      tools: [],
    };

    rendered.rerender(view({
      items: messageItems(hydratedMessage),
      focus: focusA,
    }));

    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_000 });
    expect(scrollTop).toBe(500);

    scrollHeight = 2_000;
    scrollTop = 0;
    scrollTo.mockClear();

    rendered.rerender(view({
      items: messageItems({ ...hydratedMessage, id: "assistant-2", text: "preview latest" }),
      focus: previewFocusB,
    }, "", undefined, { conversationReady: false }));

    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2_000 });
    expect(scrollTop).toBe(1_500);

    scrollTop = 800;
    fireEvent.wheel(transcript, { deltaY: -4 });
    scrollTo.mockClear();
    rendered.rerender(view({
      items: messageItems({ ...hydratedMessage, id: "assistant-2", text: "authoritative latest" }),
      focus: focusB,
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollTop).toBe(800);

    rendered.rerender(view({ ...emptyChat, focus: focusA }, "", undefined, {
      conversationReady: false,
    }));
    const cachedB: ChatState = {
      items: messageItems({ ...hydratedMessage, id: "assistant-2", text: "cached again" }),
      focus: previewFocusB,
    };
    scrollHeight = 2_500;
    scrollTop = 0;
    scrollTo.mockClear();
    rendered.rerender(view(cachedB, "", undefined, {
      conversationReady: false,
    }));

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2_500 });
    expect(scrollTop).toBe(2_000);

    scrollHeight = 3_000;
    scrollTop = 0;
    scrollTo.mockClear();
    rendered.rerender(view(cachedB, "", undefined, {
      conversationReady: false,
      observationSessionId: "session-2",
    }));

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 3_000 });
    expect(scrollTop).toBe(2_500);

    scrollTo.mockClear();
    rendered.rerender(view({
      items: messageItems({ ...hydratedMessage, id: "assistant-2", text: "new-session snapshot" }),
      focus: { ...focusB, sessionId: "session-2" },
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollTop).toBe(2_500);
  });

  it("releases scroll control upward and commits a manual jump before the next delta", () => {
    const firstChat: ChatState = {
      items: messageItems({
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "first streamed chunk",
        thinking: "",
        tools: [],
      }),
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    let scrollHeight = 1_000;
    let scrollTop = 100;
    const clientHeight = 500;
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      if (options.behavior === "smooth") return;
      scrollTop = Math.min(
        Number(options.top ?? 0),
        scrollHeight - clientHeight,
      );
    });
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: clientHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.min(value, scrollHeight - clientHeight);
        },
      },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.wheel(transcript, { deltaY: -4 });

    rendered.rerender(view({
      ...firstChat,
      items: [{
        kind: "message",
        ...firstMessage(firstChat),
        text: "first streamed chunk while detached",
      }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "↓ 回到最新消息" }));

    expect(scrollTop).toBe(500);
    expect(scrollTo).not.toHaveBeenCalled();

    scrollHeight = 1_030;
    rendered.rerender(view({
      ...firstChat,
      items: [{
        kind: "message",
        ...firstMessage(firstChat),
        text: "first streamed chunk while detached and the next delta",
      }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("jumps to the bottom when clicking the jump button", () => {
    const firstChat: ChatState = {
      items: messageItems({
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "final answer",
        thinking: "",
        tools: [],
      }),
    };
    render(view(firstChat));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    let scrollHeight = 1_000;
    let scrollTop = 100;
    const clientHeight = 500;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: clientHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.min(value, scrollHeight - clientHeight);
        },
      },
    });
    fireEvent.wheel(transcript, { deltaY: -4 });

    fireEvent.click(screen.getByRole("button", { name: "↓ 回到最新消息" }));
    expect(scrollTop).toBe(500);
    expect(screen.queryByRole("button", { name: "↓ 回到最新消息" }))
      .not.toBeInTheDocument();
  });

  it("reattaches only after the reader returns all the way to the bottom", () => {
    render(view(emptyChat));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 498 },
    });
    fireEvent.wheel(transcript, { deltaY: -4 });

    transcript.scrollTop = 490;
    fireEvent.scroll(transcript);
    expect(screen.getByRole("button", { name: "↓ 回到最新消息" })).toBeInTheDocument();

    transcript.scrollTop = 500;
    fireEvent.scroll(transcript);
    expect(screen.queryByRole("button", { name: "↓ 回到最新消息" })).not.toBeInTheDocument();
  });

  it("renders the latest received text immediately", () => {
    const firstChat: ChatState = {
      items: messageItems({
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "第一段",
        thinking: "",
        tools: [],
      }),
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));
    const markdown = rendered.container.querySelector<HTMLElement>(
      ".message.assistant .markdown",
    );
    if (!markdown) throw new Error("assistant markdown not rendered");
    const transcript = rendered.container.querySelector<HTMLElement>(
      ".transcript",
    );
    if (!transcript) throw new Error("transcript not rendered");
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 360 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    const completeText = "第一段，继续快速输出，直到形成完整的一句话。";

    rendered.rerender(view({
      ...firstChat,
      items: [{ kind: "message", ...firstMessage(firstChat), text: completeText }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));

    expect(markdown).toHaveTextContent(completeText);
    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 468,
    });
  });

  it("keeps following after a Mermaid diagram changes transcript height", async () => {
    let finishRender!: (result: { svg: string }) => void;
    mermaidMock.render.mockReset().mockReturnValue(new Promise((resolve) => {
      finishRender = resolve;
    }));
    const chat: ChatState = {
      items: messageItems({
        id: "assistant-mermaid",
        runId: "run-mermaid",
        role: "assistant",
        text: "```mermaid\nflowchart LR\nA --> B\n```",
        thinking: "",
        tools: [],
      }),
    };
    const rendered = render(view(chat));
    const transcript = rendered.container.querySelector<HTMLElement>(
      ".transcript",
    );
    if (!transcript) throw new Error("transcript not rendered");
    let scrollHeight = 1_000;
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 400 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));
    scrollHeight = 1_200;
    finishRender({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
    });

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 668,
    }));
  });

  it("does not reclaim scroll after Mermaid settles when the user detached", async () => {
    let finishRender!: (result: { svg: string }) => void;
    mermaidMock.render.mockReset().mockReturnValue(new Promise((resolve) => {
      finishRender = resolve;
    }));
    const chat: ChatState = {
      items: messageItems({
        id: "assistant-mermaid-detached",
        runId: "run-mermaid-detached",
        role: "assistant",
        text: "```mermaid\nflowchart LR\nA --> B\n```",
        thinking: "",
        tools: [],
      }),
    };
    const rendered = render(view(chat));
    const transcript = rendered.container.querySelector<HTMLElement>(
      ".transcript",
    );
    if (!transcript) throw new Error("transcript not rendered");
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_200 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 400 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));
    fireEvent.wheel(transcript, { deltaY: -40 });
    scrollTo.mockClear();
    finishRender({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
    });

    expect(await screen.findByRole("img", { name: "Mermaid 图" }))
      .toHaveTextContent("diagram");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("shows the final received burst immediately when the run finishes", () => {
    const firstMessage = {
      id: "assistant-final-burst",
      runId: "run-final-burst",
      role: "assistant" as const,
      text: "已经显示",
      thinking: "",
      tools: [],
    };
    const firstChat: ChatState = {
      items: messageItems(firstMessage),
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-final-burst", phase: "running" },
    }));
    const completeText = "已经显示，但结束前又收到了尚未经过合并层投影的一大段最终内容。";

    rendered.rerender(view({
      ...firstChat,
      items: messageItems({ ...firstMessage, text: completeText }),
    }));

    expect(screen.getByText(completeText)).toBeInTheDocument();
  });

  it("uses a cheap text node while receiving and renders markdown once settled", () => {
    const firstMessage = {
      id: "assistant-markdown",
      runId: "run-markdown",
      role: "assistant" as const,
      text: "开始",
      thinking: "",
      tools: [],
    };
    const firstChat: ChatState = {
      items: messageItems(firstMessage),
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-markdown", phase: "running" },
    }));
    const completeText = "开始，逐字显示到 **完成**。";

    rendered.rerender(view({
      ...firstChat,
      items: messageItems({ ...firstMessage, text: completeText }),
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-markdown", phase: "running" },
    }));
    const streamingText = rendered.container.querySelector(
      ".message.assistant .streaming-markdown",
    );
    expect(streamingText).toHaveTextContent(completeText);
    expect(streamingText?.querySelector("strong")).not.toBeInTheDocument();

    rendered.rerender(view({
      ...firstChat,
      items: messageItems({ ...firstMessage, text: completeText }),
    }));
    expect(rendered.container.querySelector(".streaming-markdown"))
      .not.toBeInTheDocument();
    expect(screen.getByText("完成")).toHaveProperty("tagName", "STRONG");
  });

  it("keeps active work-process disclosures open across an exact live snapshot", () => {
    const focus = {
      sessionId: "session-live",
      conversationId: "conversation-live",
      focusId: "focus-live",
    };
    const runId = "run-live";
    const thinking = "正在分析恢复投影";
    let chat = chatReducer(initialChatState, {
      type: "focus_changed",
      ...focus,
    });
    chat = chatReducer(chat, {
      type: "hydrate",
      items: [],
      projectionSeq: 0,
      ...focus,
    });
    chat = chatReducer(chat, {
      type: "prompt_accepted",
      runId,
      text: "检查项目",
      ...focus,
    });
    for (const [projectionSeq, event] of [
      [1, { type: "run_queued" as const }],
      [2, { type: "run_started" as const }],
      [3, {
        type: "assistant_message_started" as const,
        projectionId: "assistant-live",
      }],
      [4, { type: "thinking_delta" as const, delta: thinking }],
      [5, {
        type: "tool_started" as const,
        toolCallId: "tool-live",
        toolName: "read",
        args: { path: "src/client/App.tsx" },
      }],
    ] as const) {
      chat = chatReducer(chat, {
        type: "session",
        runId,
        event,
        projectionSeq,
        ...focus,
      });
    }

    const rendered = render(view(chat, "", undefined, {
      busy: true,
      activeRun: { id: runId, phase: "running" },
    }));
    fireEvent.click(screen.getByText("工作过程"));
    expect(rendered.container.querySelector<HTMLDetailsElement>(
      "details.assistant-activity-group",
    )?.open).toBe(true);

    chat = chatReducer(chat, {
      type: "hydrate",
      projectionSeq: 5,
      items: [{
        kind: "message",
        id: `run-${runId}-user`,
        runId,
        role: "user",
        text: "检查项目",
        thinking: "",
        tools: [],
      }, {
        kind: "message",
        id: "assistant-live",
        runId,
        role: "assistant",
        text: "",
        thinking,
        tools: [{
          toolCallId: "tool-live",
          toolName: "read",
          args: { path: "src/client/App.tsx" },
          status: "pending",
        }],
        parts: [{
          kind: "thinking",
          offset: 0,
          length: thinking.length,
        }, {
          kind: "tool",
          toolCallId: "tool-live",
        }],
      }],
      ...focus,
    });
    rendered.rerender(view(chat, "", undefined, {
      busy: true,
      activeRun: { id: runId, phase: "running" },
    }));

    const restoredActivity = rendered.container.querySelector(
      "details.assistant-activity-group",
    ) as HTMLDetailsElement;
    expect(restoredActivity.open).toBe(true);
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
  });

  it("resets work-process disclosure state when switching conversation focus", () => {
    const focusA = {
      sessionId: "session-a",
      conversationId: "conversation-a",
      focusId: "focus-a",
    };
    const focusB = {
      sessionId: "session-b",
      conversationId: "conversation-b",
      focusId: "focus-b",
    };
    const toolsFor = (prefix: string) => Array.from({ length: 25 }, (_, index) => ({
      id: `${prefix}-tool-${index + 1}`,
      name: "read",
      args: { path: `${prefix}-${index + 1}.ts` },
      result: { ok: true },
      status: "done" as const,
    }));
    const assistantFor = (prefix: string) => ({
      id: "assistant-same-local-id",
      runId: `run-${prefix}`,
      role: "assistant" as const,
      text: "",
      thinking: "",
      tools: toolsFor(prefix),
    });
    const rendered = render(view({
      items: messageItems(assistantFor("a")),
      focus: focusA,
    }));

    fireEvent.click(screen.getByText("工作过程"));
    expect(screen.getByText("工具调用（16）")).toBeInTheDocument();
    const firstActivity = rendered.container.querySelector(
      "details.assistant-activity-group",
    ) as HTMLDetailsElement;
    expect(firstActivity.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "展开最近 16 条" }));
    expect(screen.queryByText(/a-1\.ts/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/a-25\.ts/).length).toBeGreaterThan(0);

    rendered.rerender(view({
      items: messageItems(assistantFor("b")),
      focus: focusB,
    }));

    const nextActivity = rendered.container.querySelector(
      "details.assistant-activity-group",
    ) as HTMLDetailsElement;
    expect(nextActivity.open).toBe(false);
    expect(screen.getByText("已折叠 21 条更早工具调用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开最近 16 条" })).toBeInTheDocument();
    expect(screen.queryByText(/b-1\.ts/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/b-25\.ts/).length).toBeGreaterThan(0);
  });

  it("folds the previous Agent reply only after the latest reply finishes", () => {
    const previousMessage = {
      id: "assistant-previous",
      runId: "run-previous",
      role: "assistant" as const,
      text: "上一条完整回复",
      thinking: "上一条思考",
      tools: [{
        id: "tool-previous",
        name: "read",
        status: "done" as const,
      }],
    };
    const latestMessage = {
      id: "assistant-latest",
      runId: "run-latest",
      role: "assistant" as const,
      text: "正在生成最新回复",
      thinking: "最新思考",
      tools: [],
    };
    const rendered = render(view({
      items: messageItems(previousMessage, latestMessage),
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-latest", phase: "running" },
    }));
    const assistantMessages = () => Array.from(
      rendered.container.querySelectorAll<HTMLElement>(".message.assistant"),
    );

    expect(assistantMessages()[0]?.querySelector(".assistant-response"))
      .not.toBeInTheDocument();
    expect(assistantMessages()[1]?.querySelector(".assistant-response"))
      .not.toBeInTheDocument();

    rendered.rerender(view({
      items: messageItems(previousMessage, {
        ...latestMessage,
        text: "最新回复已经完成",
      }),
    }));

    const foldedReply = assistantMessages()[0]?.querySelector<HTMLDetailsElement>(
      ".assistant-response",
    );
    expect(foldedReply).toBeInTheDocument();
    expect(foldedReply).not.toHaveAttribute("open");
    expect(foldedReply).toHaveTextContent("上一条完整回复");
    expect(foldedReply?.querySelector(".thinking")).not.toBeInTheDocument();
    expect(foldedReply?.querySelector(".tools")).not.toBeInTheDocument();
    expect(foldedReply?.querySelector(".message-actions")).not.toBeInTheDocument();
    expect(assistantMessages()[0]?.querySelector(".thinking")).toBeInTheDocument();
    expect(assistantMessages()[0]?.querySelector(".tools")).toBeInTheDocument();
    expect(assistantMessages()[0]?.querySelector(".message-actions"))
      .toBeInTheDocument();
    expect(assistantMessages()[1]?.querySelector(".assistant-response"))
      .not.toBeInTheDocument();

    const foldedSummary = foldedReply?.querySelector("summary");
    if (!foldedSummary) throw new Error("folded Agent summary not rendered");
    fireEvent.click(foldedSummary);
    expect(foldedReply).toHaveAttribute("open");
  });

  it("only exposes disabled rewind on user messages while the Agent runs", () => {
    render(view({
      items: messageItems({
        id: "user-rewind",
        runId: "run-rewind",
        role: "user",
        text: "从这里继续",
        thinking: "",
        tools: [],
      }, {
        id: "assistant-rewind",
        runId: "run-rewind",
        role: "assistant",
        text: "正在处理",
        thinking: "",
        tools: [],
      }),
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-rewind", phase: "running" },
    }));

    const rewindButtons = screen.getAllByRole("button", {
      name: "回到此处，删除这条及之后的消息",
    });
    expect(rewindButtons).toHaveLength(1);
    expect(rewindButtons[0]).toBeDisabled();
    expect(rewindButtons[0]?.closest("article")).toHaveClass("user");
  });

  it("shows an active tool together with the latest received text", () => {
    const firstMessage = {
      id: "assistant-1",
      runId: "run-1",
      role: "assistant" as const,
      text: "准备",
      thinking: "",
      tools: [],
    };
    const firstChat: ChatState = {
      items: messageItems(firstMessage),
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));
    const completeText = "准备完成，马上调用工具读取项目文件。";

    rendered.rerender(view({
      ...firstChat,
      items: messageItems({ ...firstMessage, text: completeText }),
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));
    rendered.rerender(view({
      ...firstChat,
      items: messageItems({
        ...firstMessage,
        text: completeText,
        tools: [{
          id: "tool-1",
          name: "read",
          status: "running",
        }],
      }),
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));
    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
    expect(screen.getByText(completeText)).toBeInTheDocument();
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

  it("shows only compact context usage until token details are requested", () => {
    render(view(emptyChat, "", undefined, {
      contextTokenCount: 63_771,
      contextWindow: 372_000,
      contextPercent: 17.14,
      sessionTokenUsage: {
        input: 131_451,
        output: 10_202,
        cacheRead: 1_122_816,
        cacheWrite: 0,
        total: 1_264_469,
      },
    }));

    const summary = screen.getByText("上下文：63.8k / 372k（17%）", {
      selector: ".context-summary",
    });
    expect(summary.parentElement).toHaveClass("context-stat");
    expect(screen.queryByText(/累计 Token/)).not.toBeInTheDocument();

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("上下文：63.8k / 372k（17%）");
    expect(tooltip).toHaveTextContent("累计处理：1.26M");
    expect(tooltip).toHaveTextContent("普通输入：131k");
    expect(tooltip).toHaveTextContent("缓存读取：1.12M");
    expect(tooltip).toHaveTextContent("输出：10.2k");
    expect(tooltip).not.toHaveTextContent("缓存写入");
  });

  it("includes cache writes in the tooltip when present", () => {
    render(view(emptyChat, "", undefined, {
      sessionTokenUsage: {
        input: 1_000,
        output: 100,
        cacheRead: 2_000,
        cacheWrite: 500,
        total: 3_600,
      },
    }));

    expect(screen.getByRole("tooltip")).toHaveTextContent("缓存写入：500");
  });

  it("shows the current role at the composer footer and opens its details", () => {
    const role: ConversationRoleSnapshot = {
      id: "default",
      revision: 3,
      name: "Reviewer",
      description: "Reviews changes",
      systemPrompt: "Review exact evidence.",
      model: { provider: "provider", id: "model" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: true,
    };
    render(view(emptyChat, "", role));

    expect(screen.getByRole("button", { name: /^model\s*⌄$/ }))
      .toBeInTheDocument();
    expect(screen.queryByText("provider / model")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "查看会话角色 Reviewer",
    }));

    expect(screen.getByRole("dialog", { name: "更换会话角色" }))
      .toHaveTextContent("当前角色：Reviewer");
    expect(screen.getByRole("combobox", { name: "选择新的会话角色" }))
      .toBeInTheDocument();
  });

  it("orders role and thinking before a unified context management group", () => {
    const role: ConversationRoleSnapshot = {
      id: "researcher",
      revision: 1,
      name: "研究员",
      description: "Researches evidence",
      systemPrompt: "Research exact evidence.",
      model: { provider: "provider", id: "model" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    };
    const { container } = render(view(emptyChat, "", role));
    const meta = container.querySelector(".composer-meta");
    const children = Array.from(meta?.children ?? []);
    const contextManagement = screen.getByRole("group", {
      name: "上下文管理",
    });

    expect(children[0]).toHaveClass("conversation-role-pill");
    expect(children[1]).toHaveClass("thinking-level-control");
    expect(children[2]).toBe(contextManagement);
    expect(contextManagement).toContainElement(container.querySelector(".context-stat"));
    expect(contextManagement).toContainElement(screen.getByRole("button", {
      name: "自动压缩 70%",
    }));
    expect(contextManagement).toContainElement(screen.getByRole("button", {
      name: "手动压缩上下文",
    }));
  });

  it("keeps run thinking beside the composer without a project permission control", () => {
    const onThinking = vi.fn();
    render(<Chat
      {...view(emptyChat).props}
      onThinking={onThinking}
    />);

    fireEvent.change(screen.getByRole("combobox", { name: "思考级别" }), {
      target: { value: "high" },
    });
    expect(onThinking).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("combobox", { name: "项目工具权限" }))
      .not.toBeInTheDocument();
  });

  it("shows only advertised service tiers and keeps the server selection authoritative", () => {
    const onServiceTier = vi.fn();
    const rendered = render(view(emptyChat, "", undefined, {
      serviceTiers: ["auto", "default", "scale", "priority"],
      selectedServiceTier: null,
      onServiceTier,
    }));
    const selector = screen.getByRole("combobox", { name: "服务层级" });

    expect(selector).toHaveTextContent("供应商默认");
    expect(selector).toHaveTextContent("自动");
    expect(selector).toHaveTextContent("默认");
    expect(selector).toHaveTextContent("扩展");
    expect(selector).toHaveTextContent("快速");
    expect(selector).not.toHaveTextContent("弹性");

    fireEvent.change(selector, { target: { value: "priority" } });
    expect(onServiceTier).toHaveBeenCalledWith("priority");
    expect(selector).toHaveValue("");

    rendered.rerender(view(emptyChat, "", undefined, {
      serviceTiers: ["auto", "default", "scale", "priority"],
      selectedServiceTier: "priority",
      onServiceTier,
    }));
    expect(selector).toHaveValue("priority");
  });

  it("keeps an unavailable persisted service tier visible while allowing replacement or clearing", () => {
    const onServiceTier = vi.fn();
    render(view(emptyChat, "", undefined, {
      serviceTiers: ["auto"],
      selectedServiceTier: "flex",
      onServiceTier,
    }));
    const selector = screen.getByRole("combobox", {
      name: "服务层级",
    }) as HTMLSelectElement;

    expect(Array.from(selector.options, ({ text }) => text)).toEqual([
      "供应商默认",
      "弹性（不可用）",
      "自动",
    ]);
    expect(selector).toHaveValue("flex");
    expect(selector.options[1]).toBeDisabled();

    fireEvent.change(selector, { target: { value: "auto" } });
    fireEvent.change(selector, { target: { value: "" } });
    expect(onServiceTier).toHaveBeenNthCalledWith(1, "auto");
    expect(onServiceTier).toHaveBeenNthCalledWith(2, null);
  });

  it("hides an empty default service tier and disables visible tiers at every control gate", () => {
    const rendered = render(view(emptyChat));
    expect(screen.queryByRole("combobox", { name: "服务层级" }))
      .not.toBeInTheDocument();

    const disabledStates: Array<Partial<ComponentProps<typeof Chat>>> = [
      { conversationReady: false },
      { busy: true },
      { compacting: true },
      { interactive: false },
      { serviceTierBusy: true },
    ];
    for (const disabledState of disabledStates) {
      rendered.rerender(view(emptyChat, "", undefined, {
        serviceTiers: ["priority"],
        ...disabledState,
      }));
      expect(screen.getByRole("combobox", { name: "服务层级" }))
        .toBeDisabled();
    }

    rendered.rerender(view(emptyChat, "", undefined, {
      serviceTiers: ["priority"],
    }));
    expect(screen.getByRole("combobox", { name: "服务层级" }))
      .toBeEnabled();
  });

  it("expands the compaction threshold on demand and saves on release", () => {
    const onCompactionThreshold = vi.fn(() => true);
    render(view(emptyChat, "", undefined, { onCompactionThreshold }));
    const toggle = screen.getByRole("button", {
      name: "自动压缩 70%",
    });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("slider", {
      name: "会话自动压缩阈值",
    })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    const slider = screen.getByRole("slider", {
      name: "会话自动压缩阈值",
    });

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "上下文管理" }))
      .toContainElement(slider);
    expect(slider).toHaveAttribute("min", "20");
    expect(slider).toHaveAttribute("max", "90");
    expect(screen.getByText("70%", { selector: ".compaction-threshold-value" }))
      .toBeInTheDocument();

    fireEvent.change(slider, { target: { value: "55" } });
    expect(screen.getByText("55%", { selector: ".compaction-threshold-value" }))
      .toBeInTheDocument();
    expect(onCompactionThreshold).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);
    expect(onCompactionThreshold).toHaveBeenCalledWith(55);

    fireEvent.click(toggle);
    expect(screen.queryByRole("slider", {
      name: "会话自动压缩阈值",
    })).not.toBeInTheDocument();
  });

  it("renders a compaction divider between the surrounding messages", () => {
    const { container } = render(view({
      items: [{
        kind: "message",
        id: "assistant-before",
        runId: "run-before",
        role: "assistant",
        text: "压缩前的回复",
        thinking: "",
        tools: [],
      }, {
        kind: "compaction",
        id: "compaction-1",
        timestamp: "2026-07-19T10:00:00.000Z",
        tokensBefore: 63_771,
      }, {
        kind: "message",
        id: "user-after",
        runId: "run-after",
        role: "user",
        text: "压缩后的问题",
        thinking: "",
        tools: [],
      }],
    }));

    const transcript = container.querySelector(".transcript");
    expect(
      Array.from(transcript?.children ?? []).map((element) => element.className),
    ).toEqual(["message assistant", "compaction-marker", "message user"]);
    const compaction = screen.getByRole("separator", { name: "上下文已压缩" });
    expect(compaction).toHaveTextContent("SYSTEM");
    expect(compaction).toHaveTextContent("CONTEXT COMPACTION");
    expect(compaction).toHaveTextContent("63.8k TOKENS");
    expect(compaction).toHaveTextContent("DONE");
    expect(compaction.querySelector("time"))
      .toHaveAttribute("datetime", "2026-07-19T10:00:00.000Z");
  });

  it("keeps outgoing session messages at their transcript timepoint", () => {
    const card: ConversationMessageCard = {
      kind: "session_message",
      id: "session-message:11111111-1111-4111-8111-111111111111",
      cardId: "11111111-1111-4111-8111-111111111111",
      direction: "outgoing",
      state: "completed",
      body: "Review the implementation",
      from: {
        conversationId: "source",
        role: { id: "lead", name: "Lead" },
      },
      to: {
        conversationId: "target",
        title: "Review",
        role: { id: "reviewer", name: "Reviewer" },
      },
      sentAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:01:00.000Z",
      result: "Review complete",
    };
    const { container } = render(view({
      items: [{
        kind: "message",
        id: "user-1",
        runId: "run-1",
        role: "user",
        text: "Delegate the review",
        thinking: "",
        tools: [],
      }, {
        kind: "message",
        id: "assistant-before",
        runId: "run-1",
        role: "assistant",
        text: "",
        thinking: "",
        tools: [{
          id: "tool-1",
          name: "start_session",
          status: "done",
        }],
      }, card, {
        kind: "message",
        id: "assistant-after",
        runId: "run-1",
        role: "assistant",
        text: "最终回复",
        thinking: "",
        tools: [],
      }],
    }));

    const renderedCard = screen.getByRole("article", {
      name: "发出的会话消息",
    });
    expect(renderedCard.closest(".message.assistant")).toBeNull();
    const transcript = container.querySelector(".transcript");
    expect(
      Array.from(transcript?.children ?? []).map(
        (element) => element.className,
      ),
    ).toEqual([
      "message user",
      "message assistant",
      "session-message-card direction-outgoing state-completed is-collapsed",
      "message assistant",
    ]);
  });

  it("keeps incoming session messages at their transcript timepoint", () => {
    const card: ConversationMessageCard = {
      kind: "session_message",
      id: "session-message:22222222-2222-4222-8222-222222222222",
      cardId: "22222222-2222-4222-8222-222222222222",
      direction: "incoming",
      state: "delivered",
      body: "Review complete",
      from: {
        conversationId: "source",
        title: "Review",
        role: { id: "reviewer", name: "Reviewer" },
      },
      to: {
        conversationId: "target",
        role: { id: "lead", name: "Lead" },
      },
      sentAt: "2026-07-19T10:01:00.000Z",
      updatedAt: "2026-07-19T10:01:00.000Z",
    };
    const { container } = render(view({
      items: [{
        kind: "message",
        id: "assistant-before",
        runId: "run-1",
        role: "assistant",
        text: "收到消息前",
        thinking: "",
        tools: [],
      }, card, {
        kind: "message",
        id: "assistant-after",
        runId: "run-1",
        role: "assistant",
        text: "收到消息后",
        thinking: "",
        tools: [],
      }],
    }));

    const transcript = container.querySelector(".transcript");
    const assistants = container.querySelectorAll(".message.assistant");
    const renderedCard = screen.getByRole("article", {
      name: "收到的会话消息",
    });
    expect(renderedCard.closest(".message.assistant")).toBeNull();
    expect(Array.from(transcript?.children ?? [])).toEqual([
      assistants[0],
      renderedCard,
      assistants[1],
    ]);
  });
});
