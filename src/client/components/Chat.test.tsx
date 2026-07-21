// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationMessageCard,
  ConversationRoleSnapshot,
} from "../../shared/protocol";
import type { ChatState } from "../chat/reducer";
import { Chat } from "./Chat";

const emptyChat: ChatState = { messages: [], sessionTokens: 0 };

function view(
  chat: ChatState,
  draft = "",
  role?: ConversationRoleSnapshot,
  overrides: Partial<ComponentProps<typeof Chat>> = {},
) {
  return <Chat
    chat={chat}
    historyTruncated={false}
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
    compactionThresholdPercent={70}
    compactionThresholdBusy={false}
    cwd="E:\\work"
    online
    conversationReady
    draft={draft}
    submitting={false}
    queuedPrompts={[]}
    onDraftChange={() => undefined}
    onSend={() => true}
    onRemoveQueuedPrompt={() => undefined}
    onRetryQueuedPrompt={() => undefined}
    onAbort={() => undefined}
    onSettings={() => undefined}
    onThinking={() => undefined}
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
  it("offers manual context compaction below the composer", () => {
    const onCompact = vi.fn(() => true);
    render(view(emptyChat, "", undefined, { onCompact }));

    fireEvent.click(screen.getByRole("button", { name: "手动压缩上下文" }));

    expect(onCompact).toHaveBeenCalledOnce();
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
      "发送后将引导当前任务…",
    );

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("next instruction");

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("shows queued prompts compactly and exposes retry or removal", () => {
    const onRemoveQueuedPrompt = vi.fn();
    const onRetryQueuedPrompt = vi.fn();
    render(view(emptyChat, "", undefined, {
      queuedPrompts: [{
        id: "queued-1",
        text: "Review the test failure after the current run.",
        status: "queued",
      }, {
        id: "queued-2",
        text: "This delivery needs confirmation.",
        status: "attention",
      }],
      onRemoveQueuedPrompt,
      onRetryQueuedPrompt,
    }));

    const queue = screen.getByRole("region", { name: "待发送消息" });
    expect(queue).toHaveTextContent("接下来处理 2 条");
    expect(queue).toHaveTextContent(
      "Review the test failure after the current run.",
    );
    expect(queue).toHaveTextContent("需要确认");

    fireEvent.click(screen.getByRole("button", {
      name: "重试排队消息 This delivery needs confirmation.",
    }));
    expect(onRetryQueuedPrompt).toHaveBeenCalledWith("queued-2");

    fireEvent.click(screen.getByRole("button", {
      name: "移除排队消息 Review the test failure after the current run.",
    }));
    expect(onRemoveQueuedPrompt).toHaveBeenCalledWith("queued-1");
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

    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 468,
    });
  });

  it("jumps directly to the latest message when a focus first hydrates", () => {
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
      messages: [hydratedMessage],
      sessionTokens: 0,
      focus: focusA,
    }));

    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_000 });
    expect(scrollTop).toBe(500);

    rendered.rerender(view({ ...emptyChat, focus: focusB }, "", undefined, {
      conversationReady: false,
    }));
    scrollHeight = 2_000;
    scrollTop = 0;
    scrollTo.mockClear();

    rendered.rerender(view({
      messages: [{ ...hydratedMessage, id: "assistant-2" }],
      sessionTokens: 0,
      focus: focusB,
    }));

    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2_000 });
    expect(scrollTop).toBe(1_500);
  });

  it("releases scroll control upward and commits a manual jump before the next delta", () => {
    const firstChat: ChatState = {
      messages: [{
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "first streamed chunk",
        thinking: "",
        tools: [],
      }],
      sessionTokens: 0,
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
        set: (value: number) => { scrollTop = value; },
      },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.wheel(transcript, { deltaY: -4 });

    rendered.rerender(view({
      ...firstChat,
      messages: [{
        ...firstChat.messages[0],
        text: "first streamed chunk while detached",
      }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "↓ 回到最新消息" }));

    expect(scrollTop).toBe(500);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_000 });

    scrollHeight = 1_030;
    rendered.rerender(view({
      ...firstChat,
      messages: [{
        ...firstChat.messages[0],
        text: "first streamed chunk while detached and the next delta",
      }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));

    expect(scrollTo).toHaveBeenCalledOnce();
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
      messages: [{
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "第一段",
        thinking: "",
        tools: [],
      }],
      sessionTokens: 0,
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
      messages: [{ ...firstChat.messages[0], text: completeText }],
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
      messages: [firstMessage],
      sessionTokens: 0,
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-final-burst", phase: "running" },
    }));
    const completeText = "已经显示，但结束前又收到了尚未经过合并层投影的一大段最终内容。";

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: completeText }],
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
      messages: [firstMessage],
      sessionTokens: 0,
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-markdown", phase: "running" },
    }));
    const completeText = "开始，逐字显示到 **完成**。";

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: completeText }],
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
      messages: [{ ...firstMessage, text: completeText }],
    }));
    expect(rendered.container.querySelector(".streaming-markdown"))
      .not.toBeInTheDocument();
    expect(screen.getByText("完成")).toHaveProperty("tagName", "STRONG");
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
      messages: [previousMessage, latestMessage],
      sessionTokens: 0,
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
      messages: [previousMessage, {
        ...latestMessage,
        text: "最新回复已经完成",
      }],
      sessionTokens: 0,
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
      messages: [{
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
      }],
      sessionTokens: 0,
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
      messages: [firstMessage],
      sessionTokens: 0,
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));
    const completeText = "准备完成，马上调用工具读取项目文件。";

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: completeText }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-1", phase: "running" },
    }));
    rendered.rerender(view({
      ...firstChat,
      messages: [{
        ...firstMessage,
        text: completeText,
        tools: [{
          id: "tool-1",
          name: "read",
          status: "running",
        }],
      }],
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

    expect(screen.getByRole("dialog", { name: "会话角色" }))
      .toHaveTextContent("Review exact evidence.");
    expect(screen.getByText("更换角色")).toBeInTheDocument();
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
      messages: [],
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
      sessionTokens: 0,
    }));

    const transcript = container.querySelector(".transcript");
    expect(
      Array.from(transcript?.children ?? []).map((element) => element.className),
    ).toEqual(["message assistant", "compaction-marker", "message user"]);
    expect(screen.getByRole("separator", { name: "上下文已压缩" }))
      .toHaveTextContent("上下文已压缩");
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
      messages: [],
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
      sessionTokens: 0,
    }));

    const renderedCard = container.querySelector(
      `[data-card-id="${card.cardId}"]`,
    );
    expect(renderedCard?.closest(".message.assistant")).toBeNull();
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
      messages: [],
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
      sessionTokens: 0,
    }));

    const transcript = container.querySelector(".transcript");
    const assistants = container.querySelectorAll(".message.assistant");
    const renderedCard = container.querySelector(
      `[data-card-id="${card.cardId}"]`,
    );
    expect(renderedCard?.closest(".message.assistant")).toBeNull();
    expect(Array.from(transcript?.children ?? [])).toEqual([
      assistants[0],
      renderedCard,
      assistants[1],
    ]);
  });
});
