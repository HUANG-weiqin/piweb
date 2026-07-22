// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/reducer";
import { Message } from "./Message";

afterEach(() => {
  cleanup();
});

describe("Message", () => {
  const toolsMessage: ChatMessage = {
    id: "1",
    runId: "run-1",
    role: "assistant",
    text: "",
    thinking: "",
    tools: [
      {
        id: "1",
        name: "read",
        args: { path: "src/index.ts" },
        result: { ok: true },
        status: "done",
      },
    ],
  };

  const manyToolsMessage: ChatMessage = {
    id: "2",
    runId: "run-2",
    role: "assistant",
    text: "",
    thinking: "",
    tools: [
      { id: "1", name: "read", args: { path: "old-1.md" }, result: { ok: true }, status: "done" },
      { id: "2", name: "bash", args: { cmd: "old-2" }, result: { ok: true }, status: "done" },
      { id: "3", name: "edit", args: { file: "old-3" }, result: { ok: true }, status: "done" },
      { id: "4", name: "read", args: { path: "old-4" }, result: { ok: true }, status: "done" },
      { id: "5", name: "bash", args: { cmd: "new-1" }, result: { ok: true }, status: "done" },
      { id: "6", name: "edit", args: { file: "new-2" }, result: { ok: true }, status: "done" },
    ],
  };

  it("keeps a completed work process collapsed while summarizing its last action", () => {
    const { container } = render(<Message message={toolsMessage} />);
    const details = container.querySelector("details.assistant-activity-group") as HTMLDetailsElement;

    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(screen.getByText("工作过程")).toBeInTheDocument();
    expect(screen.getByText("已完成读取文件")).toBeInTheDocument();
    expect(container.querySelector(".activity-group-detail"))
      .toHaveTextContent("src/index.ts");
    expect(screen.getByText("1 步 · 1 次工具调用")).toBeInTheDocument();
    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
  });

  it("expands the work process before its individual tool details", () => {
    const { container } = render(<Message message={toolsMessage} />);

    const activity = container.querySelector("details.assistant-activity-group") as HTMLDetailsElement;
    fireEvent.click(screen.getByText("工作过程"));
    expect(activity.open).toBe(true);

    const summary = screen.getByText("工具调用（1）") as HTMLElement;
    fireEvent.click(summary);
    const details = screen.getByText("工具调用（1）").closest("details") as HTMLDetailsElement;
    const tool = container.querySelector("details.tool") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(tool.open).toBe(false);

    fireEvent.click(tool.querySelector("summary") as HTMLElement);

    expect(tool.open).toBe(true);
    expect(screen.getByText("路径")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
  });

  it("animates the thinking indicator only for the active Agent run", () => {
    const message: ChatMessage = {
      id: "thinking-1",
      runId: "run-thinking",
      role: "assistant",
      text: "",
      thinking: "正在检查现有实现。",
      tools: [],
    };
    const { container, rerender } = render(
      <Message message={message} activeThinking />,
    );

    expect(screen.getByRole("status", { name: "Agent 正在思考" })).toBeInTheDocument();
    expect(container.querySelector(".activity-group-label"))
      .toHaveTextContent("正在思考");
    expect(container.querySelector(".activity-group-detail"))
      .toHaveTextContent("正在检查现有实现。");

    rerender(<Message message={message} />);

    expect(screen.queryByRole("status", { name: "Agent 正在思考" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("思考过程")).toBeInTheDocument();
  });

  it("shows an active tool in the collapsed work-process summary", () => {
    const message: ChatMessage = {
      id: "tool-active",
      runId: "run-tool-active",
      role: "assistant",
      text: "",
      thinking: "准备读取组件。",
      tools: [{
        id: "read-active",
        name: "read",
        args: { path: "src/client/components/Message.tsx" },
        status: "running",
      }],
      parts: [
        { kind: "thinking", text: "准备读取组件。" },
        { kind: "tool", toolId: "read-active" },
      ],
    };

    const { container } = render(<Message message={message} />);

    expect(screen.getByRole("status", { name: "Agent 正在处理" })).toBeInTheDocument();
    expect(screen.getByText("正在读取文件")).toBeInTheDocument();
    expect(container.querySelector(".activity-group-detail"))
      .toHaveTextContent("src/client/components/Message.tsx");
  });

  it("summarizes the latest completed step after an earlier tool failure", () => {
    const message: ChatMessage = {
      id: "tool-recovered",
      runId: "run-tool-recovered",
      role: "assistant",
      text: "",
      thinking: "失败后继续恢复。",
      tools: [
        {
          id: "failed-command",
          name: "bash",
          args: { cmd: "npm run missing" },
          result: { error: "script not found" },
          status: "error",
        },
        {
          id: "successful-read",
          name: "read",
          args: { path: "src/client/components/Message.tsx" },
          result: { ok: true },
          status: "done",
        },
      ],
      parts: [
        { kind: "tool", toolId: "failed-command" },
        { kind: "thinking", text: "失败后继续恢复。" },
        { kind: "tool", toolId: "successful-read" },
      ],
    };

    const { container } = render(<Message message={message} />);

    expect(screen.queryByText("工具执行失败")).not.toBeInTheDocument();
    expect(screen.getByText("已完成读取文件")).toBeInTheDocument();
    expect(container.querySelector(".activity-group-detail"))
      .toHaveTextContent("src/client/components/Message.tsx");
  });

  it("keeps a thinking preview readable without markdown markers", () => {
    const message: ChatMessage = {
      id: "thinking-preview",
      runId: "run-thinking-preview",
      role: "assistant",
      text: "",
      thinking: "**Planning** `Message.tsx` updates",
      tools: [],
    };

    const { container } = render(<Message message={message} />);

    expect(container.querySelector(".activity-group-detail"))
      .toHaveTextContent("Planning Message.tsx updates");
  });

  it("renders thinking content through the sanitized markdown pipeline", () => {
    const message: ChatMessage = {
      id: "thinking-markdown",
      runId: "run-thinking-markdown",
      role: "assistant",
      text: "",
      thinking: [
        "## 分析",
        "",
        "- 检查状态",
        "- 执行 `typecheck`",
        "",
        "<script>alert('unsafe')</script>",
      ].join("\n"),
      tools: [],
    };

    const { container } = render(<Message message={message} />);
    expect(container.querySelector(".thinking-body.markdown")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("工作过程"));
    fireEvent.click(screen.getByText("思考过程"));
    const thinking = container.querySelector(".thinking-body.markdown") as HTMLElement;

    expect(thinking).toContainElement(screen.getByRole("heading", { level: 2, name: "分析" }));
    expect(thinking.querySelector("ul")).toHaveTextContent("检查状态");
    expect(thinking.querySelector("code")).toHaveTextContent("typecheck");
    expect(thinking.querySelector("script")).not.toBeInTheDocument();
  });

  it("collapses long tool lists and can expand to show all calls", () => {
    render(<Message message={manyToolsMessage} />);
    fireEvent.click(screen.getByText("工作过程"));

    expect(screen.getByText("工具调用（6）")).toBeInTheDocument();
    expect(screen.getByText("已折叠 2 条更早工具调用")).toBeInTheDocument();
    expect(screen.queryByText(/old-1\.md/)).not.toBeInTheDocument();
    expect(screen.getByText("展开全部 6 条")).toBeInTheDocument();
    expect(screen.getByText(/new-2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 6 条" }));

    expect(screen.getByRole("button", { name: "收起到最近 4 条" })).toBeInTheDocument();
    expect(screen.getAllByText(/old-1\.md/).length).toBeGreaterThan(0);
  });

  it("renders text and consecutive activity groups in assistant part order", () => {
    const message: ChatMessage = {
      id: "3",
      runId: "run-3",
      role: "assistant",
      text: "先解释。\n\n最终回复。",
      thinking: "第一次思考\n\n第二次思考",
      tools: [
        {
          id: "1",
          name: "read",
          args: { path: "src/index.ts" },
          result: { ok: true },
          status: "done",
        },
        {
          id: "2",
          name: "grep",
          args: { pattern: "timeline" },
          result: { ok: true },
          status: "done",
        },
      ],
      parts: [
        { kind: "text", text: "先解释。" },
        { kind: "thinking", text: "第一次思考" },
        { kind: "tool", toolId: "1" },
        { kind: "thinking", text: "第二次思考" },
        { kind: "tool", toolId: "2" },
        { kind: "text", text: "最终回复。" },
      ],
    };

    const { container } = render(<Message message={message} />);

    const article = container.querySelector("article") as HTMLElement;
    expect(Array.from(article.children).map((element) => element.className))
      .toEqual([
        "markdown",
        "assistant-activity-group is-complete",
        "markdown",
        "message-actions assistant-message-actions",
      ]);
    const activity = article.querySelector(".assistant-activity-group");
    expect(Array.from(activity?.children ?? []).map((element) => element.className))
      .toEqual(["", "activity-timeline"]);
    expect(screen.getAllByText("工具调用（1）")).toHaveLength(2);
    expect(screen.getByText("先解释。")).toBeInTheDocument();
    expect(screen.getByText("最终回复。")).toBeInTheDocument();
  });

  it("preserves rich markdown structure for scoped transcript styling", () => {
    const message: ChatMessage = {
      id: "4",
      runId: "run-4",
      role: "assistant",
      text: [
        "# 主标题",
        "",
        "第一段。",
        "",
        "第二段包含[链接](https://example.com)和 `inline()`。",
        "",
        "## 列表",
        "",
        "- 一级",
        "  - 二级",
        "",
        "> 清晰的引用内容。",
        "",
        "| 内容类别 | 一个普通 roguelike 通常有多少 | 按当前模式的行数估算 |",
        "| --- | --- | --- |",
        "| **物品类型** | 50-200（武器、盔甲、药水、卷轴、法杖、戒指……） | 50×50行 = **2,500-10,000行**（仅 blueprint） |",
        "| **技能/法术** | 20-50 | 20×15行 = **300-750行** |",
        "| **状态效果** | 30-80（中毒、燃烧、冰冻、加速、致盲……） | 30×10行 = **300-800行**（不包括交互） |",
        "| **敌人类型** | 20-50（每种有不同 AI/行为） | **当前没有 AI 系统，需要从零建** |",
        "| **物品-状态交互** | 有机关联（火把+油=爆炸、冰+湿=冻结） | **当前模式需要每个组合写 handler → O(n²)** |",
        "| **被动能力/天赋** | 30-80 | 需要新的机制类型 |",
        "",
        "```ts",
        "const wideValue = true;",
        "```",
      ].join("\n"),
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} />);
    const markdown = container.querySelector(".markdown") as HTMLElement;
    const table = screen.getByRole("table");

    expect(markdown).toContainElement(screen.getByRole("heading", { level: 1, name: "主标题" }));
    expect(markdown).toContainElement(screen.getByRole("heading", { level: 2, name: "列表" }));
    expect(markdown.querySelectorAll(":scope > p")).toHaveLength(2);
    expect(markdown.querySelector("ul ul")).toHaveTextContent("二级");
    expect(markdown.querySelector("blockquote")).toHaveTextContent("清晰的引用内容。");
    expect(markdown).toContainElement(table);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(6);
    expect(table.querySelector("tbody td strong")).toHaveTextContent("物品类型");
    expect(screen.getByRole("link", { name: "链接" })).toHaveAttribute("href", "https://example.com");
    expect(markdown.querySelector("pre code")).toHaveTextContent("const wideValue = true;");
  });

  it("renders completed markdown blocks while keeping the active tail as text", () => {
    const message: ChatMessage = {
      id: "streaming-blocks",
      runId: "run-streaming-blocks",
      role: "assistant",
      text: ["# 已完成标题", "", "当前 **未完成"].join("\n"),
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} streamingText />);
    const streaming = container.querySelector(".streaming-markdown") as HTMLElement;
    const tail = container.querySelector(".streaming-tail") as HTMLElement;

    expect(screen.getByRole("heading", { level: 1, name: "已完成标题" }))
      .toBeInTheDocument();
    expect(tail).toHaveTextContent("当前 **未完成");
    expect(tail.querySelector("strong")).not.toBeInTheDocument();
    expect(streaming).toContainElement(tail);
  });

  it("promotes a closed streaming code fence to markdown", () => {
    const message: ChatMessage = {
      id: "streaming-fence",
      runId: "run-streaming-fence",
      role: "assistant",
      text: [
        "```ts",
        "const value = true;",
        "```",
        "",
        "继续生成",
      ].join("\n"),
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} streamingText />);

    expect(container.querySelector(".streaming-stable pre code"))
      .toHaveTextContent("const value = true;");
    expect(container.querySelector(".streaming-tail"))
      .toHaveTextContent("继续生成");
  });

  it("keeps stable streaming blocks mounted while the tail grows", () => {
    const message: ChatMessage = {
      id: "streaming-stable-block",
      runId: "run-streaming-stable-block",
      role: "assistant",
      text: "# 稳定标题\n\n正在生成",
      thinking: "",
      tools: [],
    };

    const { container, rerender } = render(<Message message={message} streamingText />);
    const stableBlock = container.querySelector(".streaming-stable");

    rerender(<Message
      message={{ ...message, text: "# 稳定标题\n\n正在生成更多内容" }}
      streamingText
    />);

    expect(container.querySelector(".streaming-stable")).toBe(stableBlock);
    expect(container.querySelector(".streaming-tail")).toHaveTextContent("正在生成更多内容");
  });

  it("does not close a fence when the marker has trailing text", () => {
    const message: ChatMessage = {
      id: "streaming-fence-trailing-text",
      runId: "run-streaming-fence-trailing-text",
      role: "assistant",
      text: [
        "```ts",
        "const value = true;",
        "``` still code",
        "more code",
        "```",
        "",
        "继续生成",
      ].join("\n"),
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} streamingText />);
    const code = container.querySelector(".streaming-stable pre code");

    expect(code).toHaveTextContent("``` still code");
    expect(code).toHaveTextContent("more code");
  });

  it("copies the assistant's original markdown and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const message: ChatMessage = {
      id: "5",
      runId: "run-5",
      role: "assistant",
      text: "**原始 Markdown**",
      thinking: "",
      tools: [],
    };

    render(<Message message={message} />);
    const copyButton = screen.getByRole("button", { name: "复制 Agent 回复" });
    expect(copyButton.parentElement).toHaveClass("assistant-message-actions");
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("**原始 Markdown**"));
    expect(screen.getByRole("button", { name: "已复制 Agent 回复" })).toBeInTheDocument();
  });

  it("offers copy and confirmed rewind for a user message", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onRewind = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const message: ChatMessage = {
      id: "user-entry",
      runId: "run-6",
      role: "user",
      text: "用户原文",
      thinking: "",
      tools: [],
    };

    render(<Message message={message} onRewind={onRewind} />);
    const copyButton = screen.getByRole("button", { name: "复制用户消息" });
    expect(copyButton.parentElement).not.toHaveClass("assistant-message-actions");
    fireEvent.click(copyButton);
    fireEvent.click(screen.getByRole("button", {
      name: "回到此处，删除这条及之后的消息",
    }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("用户原文"));
    expect(window.confirm).toHaveBeenCalledWith(
      "将彻底删除这条消息以及之后的所有消息，且无法恢复。确定回到此处吗？",
    );
    expect(onRewind).toHaveBeenCalledWith("user-entry", "用户原文");
  });

  it("does not offer rewind for an assistant message", () => {
    const onRewind = vi.fn();
    const message: ChatMessage = {
      id: "assistant:entry",
      runId: "run-7",
      role: "assistant",
      text: "Agent 回复",
      thinking: "",
      tools: [],
    };

    render(<Message message={message} onRewind={onRewind} />);

    expect(screen.queryByRole("button", {
      name: "回到此处，删除这条及之后的消息",
    })).not.toBeInTheDocument();
  });

  it("does not rewind a user message when confirmation is cancelled", () => {
    const onRewind = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const message: ChatMessage = {
      id: "user-entry",
      runId: "run-8",
      role: "user",
      text: "用户原文",
      thinking: "",
      tools: [],
    };

    render(<Message message={message} onRewind={onRewind} />);
    fireEvent.click(screen.getByRole("button", {
      name: "回到此处，删除这条及之后的消息",
    }));

    expect(onRewind).not.toHaveBeenCalled();
  });
});
