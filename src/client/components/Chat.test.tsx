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

function mockAnimationFrames() {
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => window.setTimeout(
      () => callback(Date.now()),
      16,
    ),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    (handle: number) => window.clearTimeout(handle),
  );
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

  it("immediately releases scroll control when the reader wheels upward", () => {
    const rendered = render(view(emptyChat));
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript not rendered");
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 498 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.wheel(transcript, { deltaY: -4 });

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

    expect(transcript).toHaveClass("has-content");
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "↓ 回到最新消息" }));
    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 1_000,
    });
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

  it("reveals a coalesced text delta across animation frames", () => {
    vi.useFakeTimers();
    mockAnimationFrames();
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

    expect(screen.getByText("第一段")).toBeInTheDocument();
    expect(screen.queryByText(completeText)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(32));

    expect(markdown).toHaveTextContent("第一段");
    expect(markdown).not.toHaveTextContent(completeText);
    scrollTo.mockClear();

    act(() => vi.advanceTimersByTime(16));

    expect(markdown.textContent?.startsWith("第一段")).toBe(true);
    expect(markdown.textContent?.length).toBeGreaterThan("第一段".length);
    expect(markdown).not.toHaveTextContent(completeText);
    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 468,
    });

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstChat.messages[0], text: completeText }],
    }));

    expect(markdown).not.toHaveTextContent(completeText);

    act(() => vi.advanceTimersByTime(360));

    expect(markdown).toHaveTextContent(completeText);
  });

  it("keeps pacing an uncoalesced final burst when the run finishes", () => {
    vi.useFakeTimers();
    mockAnimationFrames();
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

    expect(screen.queryByText(completeText)).not.toBeInTheDocument();
    expect(rendered.container.querySelector(".streaming-markdown"))
      .toHaveTextContent("已经显示");

    act(() => vi.advanceTimersByTime(500));

    expect(screen.getByText(completeText)).toBeInTheDocument();
  });

  it("uses a cheap text node while revealing and renders markdown once settled", () => {
    vi.useFakeTimers();
    mockAnimationFrames();
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
    act(() => vi.advanceTimersByTime(32));
    act(() => vi.advanceTimersByTime(240));

    const streamingText = rendered.container.querySelector(
      ".message.assistant .streaming-markdown",
    );
    expect(streamingText).toHaveTextContent(completeText);
    expect(streamingText?.querySelector("strong")).not.toBeInTheDocument();

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: completeText }],
    }));
    act(() => vi.advanceTimersByTime(16));

    expect(rendered.container.querySelector(".streaming-markdown"))
      .not.toBeInTheDocument();
    expect(screen.getByText("完成")).toHaveProperty("tagName", "STRONG");
  });

  it("paces a large streamed burst without revealing a block per frame", () => {
    vi.useFakeTimers();
    mockAnimationFrames();
    const firstMessage = {
      id: "assistant-paced",
      runId: "run-paced",
      role: "assistant" as const,
      text: "起",
      thinking: "",
      tools: [],
    };
    const firstChat: ChatState = {
      messages: [firstMessage],
      sessionTokens: 0,
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-paced", phase: "running" },
    }));
    const completeText = `起${"流畅".repeat(100)}`;

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: completeText }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-paced", phase: "running" },
    }));
    act(() => vi.advanceTimersByTime(32));
    act(() => vi.advanceTimersByTime(16));

    const streamingText = rendered.container.querySelector(
      ".message.assistant .streaming-markdown",
    );
    const visibleGraphemes = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" })
        .segment(streamingText?.textContent ?? ""),
    ).length;
    expect(visibleGraphemes).toBeGreaterThan(1);
    expect(visibleGraphemes).toBeLessThanOrEqual(3);
  });

  it("never reveals a partial grapheme while streaming", () => {
    vi.useFakeTimers();
    mockAnimationFrames();
    const firstMessage = {
      id: "assistant-grapheme",
      runId: "run-grapheme",
      role: "assistant" as const,
      text: "起",
      thinking: "",
      tools: [],
    };
    const firstChat: ChatState = {
      messages: [firstMessage],
      sessionTokens: 0,
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-grapheme", phase: "running" },
    }));

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: "起👨‍👩‍👧‍👦结束" }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-grapheme", phase: "running" },
    }));
    act(() => vi.advanceTimersByTime(32));
    act(() => vi.advanceTimersByTime(16));

    expect(rendered.container.querySelector(".streaming-markdown"))
      .toHaveTextContent("起👨‍👩‍👧‍👦");
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

  it("shows an active tool without flushing buffered text", () => {
    vi.useFakeTimers();
    mockAnimationFrames();
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
    act(() => vi.advanceTimersByTime(48));
    expect(screen.queryByText(completeText)).not.toBeInTheDocument();

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
    act(() => vi.advanceTimersByTime(32));

    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
    expect(screen.queryByText(completeText)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(400));

    expect(screen.getByText(completeText)).toBeInTheDocument();
  });

  it("smoothly adopts a final correction that preserves the visible prefix", () => {
    vi.useFakeTimers();
    mockAnimationFrames();
    const firstMessage = {
      id: "assistant-corrected",
      runId: "run-corrected",
      role: "assistant" as const,
      text: "起",
      thinking: "",
      tools: [],
    };
    const firstChat: ChatState = {
      messages: [firstMessage],
      sessionTokens: 0,
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-corrected", phase: "running" },
    }));
    const streamedTarget = `起${"原始流式内容".repeat(12)}`;

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: streamedTarget }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-corrected", phase: "running" },
    }));
    act(() => vi.advanceTimersByTime(32));
    act(() => vi.advanceTimersByTime(32));

    const streamingText = rendered.container.querySelector(
      ".message.assistant .streaming-markdown",
    );
    const visiblePrefix = streamingText?.textContent ?? "";
    expect(visiblePrefix.length).toBeGreaterThan(1);
    const correctedText = `${visiblePrefix}校准后的尾部会继续平滑显示。`;

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: correctedText }],
    }));

    expect(screen.queryByText(correctedText)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(400));

    expect(screen.getByText(correctedText)).toBeInTheDocument();
  });

  it("immediately adopts a final correction that replaces visible text", () => {
    vi.useFakeTimers();
    mockAnimationFrames();
    const firstMessage = {
      id: "assistant-replaced",
      runId: "run-replaced",
      role: "assistant" as const,
      text: "旧",
      thinking: "",
      tools: [],
    };
    const firstChat: ChatState = {
      messages: [firstMessage],
      sessionTokens: 0,
    };
    const rendered = render(view(firstChat, "", undefined, {
      busy: true,
      activeRun: { id: "run-replaced", phase: "running" },
    }));

    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: "旧内容仍在流式输出" }],
    }, "", undefined, {
      busy: true,
      activeRun: { id: "run-replaced", phase: "running" },
    }));
    act(() => vi.advanceTimersByTime(32));
    act(() => vi.advanceTimersByTime(32));

    const correctedText = "完全不同的最终文本";
    rendered.rerender(view({
      ...firstChat,
      messages: [{ ...firstMessage, text: correctedText }],
    }));

    expect(screen.getByText(correctedText)).toBeInTheDocument();
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

  it("keeps completed outgoing session work above the final assistant text", () => {
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
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "最终回复",
        thinking: "",
        tools: [{
          id: "tool-1",
          name: "start_session",
          status: "done",
        }],
      }, card],
      sessionTokens: 0,
    }));

    const assistant = container.querySelector(".message.assistant");
    const renderedCard = container.querySelector(
      `[data-card-id="${card.cardId}"]`,
    );
    expect(renderedCard?.closest(".message.assistant")).toBe(assistant);
    expect(
      Array.from(assistant?.children ?? []).map(
        (element) => element.className,
      ),
    ).toEqual(["tools", "session-message-stack", "markdown", "message-actions"]);
  });

  it("keeps incoming session messages above the final assistant text", () => {
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
        id: "assistant-1",
        runId: "run-1",
        role: "assistant",
        text: "最终回复",
        thinking: "",
        tools: [],
      }, card],
      sessionTokens: 0,
    }));

    const assistant = container.querySelector(".message.assistant");
    const renderedCard = container.querySelector(
      `[data-card-id="${card.cardId}"]`,
    );
    expect(renderedCard?.closest(".message.assistant")).toBe(assistant);
    expect(
      Array.from(assistant?.children ?? []).map(
        (element) => element.className,
      ),
    ).toEqual(["session-message-stack", "markdown", "message-actions"]);
  });
});
