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

  it("keeps tool details collapsed by default", () => {
    const { container } = render(<Message message={toolsMessage} />);
    const details = container.querySelector("details.tools") as HTMLDetailsElement;

    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
  });

  it("expands the tool group while keeping each tool independently collapsible", () => {
    const { container } = render(<Message message={toolsMessage} />);

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
    const { rerender } = render(
      <Message message={message} activeThinking />,
    );

    expect(screen.getByRole("status", { name: "Agent 正在思考" })).toBeInTheDocument();
    expect(screen.getByText("正在思考")).toBeInTheDocument();

    rerender(<Message message={message} />);

    expect(screen.queryByRole("status", { name: "Agent 正在思考" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("思考过程")).toBeInTheDocument();
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

    fireEvent.click(screen.getByText("思考过程"));
    const thinking = container.querySelector(".thinking-body.markdown") as HTMLElement;

    expect(thinking).toContainElement(screen.getByRole("heading", { level: 2, name: "分析" }));
    expect(thinking.querySelector("ul")).toHaveTextContent("检查状态");
    expect(thinking.querySelector("code")).toHaveTextContent("typecheck");
    expect(thinking.querySelector("script")).not.toBeInTheDocument();
  });

  it("collapses long tool lists and can expand to show all calls", () => {
    render(<Message message={manyToolsMessage} />);

    expect(screen.getByText("工具调用（6）")).toBeInTheDocument();
    expect(screen.getByText("已折叠 2 条更早工具调用")).toBeInTheDocument();
    expect(screen.queryByText(/old-1\.md/)).not.toBeInTheDocument();
    expect(screen.getByText("展开全部 6 条")).toBeInTheDocument();
    expect(screen.getByText(/new-2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 6 条" }));

    expect(screen.getByRole("button", { name: "收起到最近 4 条" })).toBeInTheDocument();
    expect(screen.getAllByText(/old-1\.md/).length).toBeGreaterThan(0);
  });

  it("shows tools before assistant markdown text", () => {
    const message: ChatMessage = {
      id: "3",
      runId: "run-3",
      role: "assistant",
      text: "最终回复：已完成分析。",
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

    const { container } = render(<Message message={message} />);

    const article = container.querySelector("article") as HTMLElement;
    const firstBlock = article.querySelector(".tools, .markdown") as HTMLElement;
    const secondBlock = firstBlock?.nextElementSibling as HTMLElement | null;

    expect(firstBlock).toHaveClass("tools");
    expect(secondBlock).toHaveClass("markdown");
    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
    expect(screen.getByText("最终回复：已完成分析。")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "复制 Agent 回复" }));

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
    fireEvent.click(screen.getByRole("button", { name: "复制用户消息" }));
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
