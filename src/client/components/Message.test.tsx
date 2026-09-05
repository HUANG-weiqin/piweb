// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/reducer";
import { Message } from "./Message";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    expect(container.querySelector(".message-event-header"))
      .toHaveTextContent("AGENTAgentLOGGED");
    expect(screen.getByText("工作过程")).toBeInTheDocument();
    expect(screen.getByText("已完成读取文件")).toBeInTheDocument();
    expect(container.querySelector(".activity-group-detail"))
      .toHaveTextContent("src/index.ts");
    expect(screen.getByText("1 步 · 1 次工具调用")).toBeInTheDocument();
    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
  });

  it("does not infer an active run from a stale pending tool", () => {
    const pendingMessage: ChatMessage = {
      ...toolsMessage,
      tools: [{ ...toolsMessage.tools[0], status: "pending" }],
    };
    const { container, rerender } = render(<Message message={pendingMessage} />);

    expect(container.querySelector(".message-event-header"))
      .toHaveTextContent("AGENTAgentLOGGED");

    rerender(<Message message={pendingMessage} assistantState="WAITING" />);
    expect(container.querySelector(".message-event-header"))
      .toHaveTextContent("AGENTAgentWAITING");
  });

  it("promotes commitments without duplicating them in the work process", () => {
    const message: ChatMessage = {
      id: "commitments",
      runId: "run-commitments",
      role: "assistant",
      text: "",
      thinking: "",
      tools: [
        {
          id: "budget",
          name: "request_edit_budget",
          args: { fileCount: 2, reason: "修改两个客户端文件。" },
          status: "done",
        },
        {
          id: "committed-wait",
          name: "wait_for_session",
          args: {
            conversationId: "reviewer",
            runId: "review-run",
            singleWaitCommitment: "审查结果位于提交前关键路径。",
          },
          status: "pending",
        },
        {
          id: "warning-wait",
          name: "wait_for_session",
          args: { conversationId: "blocked-peer", runId: "blocked-run" },
          result: {
            content: [],
            details: { outcome: "single_wait_commitment_required" },
          },
          status: "done",
        },
        {
          id: "read",
          name: "read",
          args: { path: "src/index.ts" },
          status: "done",
        },
        {
          id: "plain-wait",
          name: "wait_for_session",
          args: {
            conversationId: "other-peer",
            runId: "other-run",
            singleWaitCommitment: "   ",
          },
          status: "pending",
        },
        {
          id: "invalid-aggregate-wait",
          name: "wait_for_session",
          args: {
            targets: [{ conversationId: "peer", runId: "peer-run" }],
            singleWaitCommitment: "This mixed shape must be rejected.",
          },
          result: { message: "wait_for_session cannot mix targets" },
          status: "error",
        },
      ],
      parts: [
        { kind: "tool", toolId: "budget" },
        { kind: "tool", toolId: "committed-wait" },
        { kind: "tool", toolId: "warning-wait" },
        { kind: "tool", toolId: "read" },
        { kind: "tool", toolId: "plain-wait" },
        { kind: "tool", toolId: "invalid-aggregate-wait" },
      ],
    };
    const { container } = render(<Message message={message} />);

    expect(container.querySelectorAll(".commitment-card")).toHaveLength(3);
    expect(screen.getByText("BUDGET ESTIMATE")).toBeInTheDocument();
    expect(screen.getByLabelText("2 FILES PLANNED"))
      .toHaveTextContent("2FILES PLANNED");
    expect(screen.getByText("单会话等待承诺")).toBeInTheDocument();
    expect(screen.getByText("等待未开始")).toBeInTheDocument();
    expect(screen.getByText("1 步 · 3 次工具调用")).toBeInTheDocument();
    expect(container.querySelectorAll("details.tool")).toHaveLength(3);
    expect(container.querySelectorAll("details.tool-error")).toHaveLength(1);
    expect(screen.queryByText("工具调用（4）")).not.toBeInTheDocument();
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
    const spinner = container.querySelector(".thinking-spinner");
    expect(spinner?.tagName).toBe("svg");
    expect(spinner?.querySelectorAll("circle")).toHaveLength(2);
    const arc = spinner?.querySelector(".activity-spinner-arc");
    expect(arc).toHaveAttribute("stroke-linecap", "round");
    expect(arc).toHaveAttribute("pathLength", "100");
    expect(arc).toHaveAttribute("stroke-dasharray", "25 75");
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
        "message-event-header",
        "markdown",
        "assistant-activity-group is-complete",
        "markdown",
        "message-actions assistant-message-actions",
      ]);
    const activity = article.querySelector(".assistant-activity-group");
    expect(Array.from(activity?.children ?? []).map((element) => element.className))
      .toEqual(["", "activity-timeline"]);
    expect(screen.getAllByText("工具调用（1）")).toHaveLength(2);
    expect(Array.from(activity?.querySelector(".activity-timeline")?.children ?? [])
      .map((element) => element.className))
      .toEqual(["tools", "thinking", "tools", "thinking"]);
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

  it("renders fenced Mermaid diagrams through the lazy sanitized pipeline", async () => {
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: [
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 2400 240" style="max-width: 2400px" onload="alert(1)">',
        "<script>alert(1)</script>",
        '<defs><linearGradient id="safe-gradient" /></defs>',
        '<rect fill="url(#safe-gradient)" />',
        '<a href="https://attacker.example/link"><text>流程图</text></a>',
        "</svg>",
      ].join(""),
    });
    const onContentSettled = vi.fn();
    const message: ChatMessage = {
      id: "mermaid-final",
      runId: "run-mermaid-final",
      role: "assistant",
      text: [
        "```mermaid",
        "flowchart LR",
        "  A[开始] --> B[完成]",
        "```",
      ].join("\n"),
      thinking: "",
      tools: [],
    };

    const { container } = render(
      <Message message={message} onContentSettled={onContentSettled} />,
    );
    const diagram = await screen.findByRole("img", { name: "Mermaid 图" });

    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({
      htmlLabels: false,
      maxEdges: 500,
      maxTextSize: 50_000,
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
    }));
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringMatching(/^piweb-mermaid-\d+$/),
      expect.stringContaining("A[开始] --> B[完成]"),
    );
    expect(diagram.closest(".mermaid-diagram")).toBeInTheDocument();
    expect(diagram.style.width).toBe("2400px");
    expect(diagram.style.getPropertyPriority("width")).toBe("important");
    expect(diagram.style.maxWidth).toBe("none");
    expect(diagram).not.toHaveAttribute("onload");
    expect(diagram.querySelector("script")).not.toBeInTheDocument();
    expect(diagram.querySelector("foreignObject")).not.toBeInTheDocument();
    expect(diagram.querySelector("a")).not.toHaveAttribute("href");
    expect(diagram.querySelector("rect")).toHaveAttribute("fill", "url(#safe-gradient)");
    expect(container.querySelector("pre[data-piweb-mermaid]"))
      .not.toBeInTheDocument();
    expect(onContentSettled).toHaveBeenCalledTimes(1);
  });

  it("does not submit a stale Mermaid render during StrictMode remounting", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>strict diagram</text></svg>',
    });
    const message: ChatMessage = {
      id: "mermaid-strict",
      runId: "run-mermaid-strict",
      role: "assistant",
      text: "```mermaid\nflowchart LR\nA --> B\n```",
      thinking: "",
      tools: [],
    };

    render(<StrictMode><Message message={message} /></StrictMode>);

    expect(await screen.findByRole("img", { name: "Mermaid 图" }))
      .toHaveTextContent("strict diagram");
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("does not promote raw HTML that imitates a Mermaid code block", async () => {
    mermaidMock.render.mockClear();
    const message: ChatMessage = {
      id: "mermaid-forged",
      runId: "run-mermaid-forged",
      role: "assistant",
      text: '<pre data-piweb-mermaid="forged"><code class="language-mermaid">flowchart LR; A-->B</code></pre>',
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(container.querySelector("pre code.language-mermaid"))
      .toHaveTextContent("flowchart LR; A-->B");
  });

  it("rejects Mermaid metadata before an escaped image key can load a resource", async () => {
    mermaidMock.render.mockClear();
    const message: ChatMessage = {
      id: "mermaid-external-source",
      runId: "run-mermaid-external-source",
      role: "assistant",
      text: '```mermaid\nflowchart LR\nA@{ "i\\u006dg": "//127.0.0.1:8123/pixel" }\n```',
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} />);

    expect(await screen.findByRole("note"))
      .toHaveTextContent("Mermaid 图包含不支持的资源或扩展语法，已显示源码。");
    expect(container.querySelector("pre.mermaid-fallback code"))
      .toHaveTextContent("127.0.0.1:8123/pixel");
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("rejects CSS-escaped resources before invoking Mermaid", async () => {
    mermaidMock.render.mockClear();
    const message: ChatMessage = {
      id: "mermaid-escaped-css-source",
      runId: "run-mermaid-escaped-css-source",
      role: "assistant",
      text: "```mermaid\nflowchart LR\nA --> B\nstyle A fill:u\\72l(h\\74tp://127.0.0.1/pixel)\n```",
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} />);

    expect(await screen.findByRole("note"))
      .toHaveTextContent("Mermaid 图包含不支持的资源或扩展语法，已显示源码。");
    expect(container.querySelector("pre.mermaid-fallback code"))
      .toHaveTextContent("127.0.0.1/pixel");
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("rejects external image references returned in Mermaid SVG", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://attacker.example/pixel" /></svg>',
    });
    const message: ChatMessage = {
      id: "mermaid-external-svg",
      runId: "run-mermaid-external-svg",
      role: "assistant",
      text: "```mermaid\nflowchart LR\nA --> B\n```",
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} />);

    expect(await screen.findByRole("note"))
      .toHaveTextContent("Mermaid 图无法渲染，已显示源码。");
    expect(container.querySelector("pre.mermaid-fallback code"))
      .toHaveTextContent("A --> B");
  });

  it("rejects CSS-escaped non-local resources returned in Mermaid SVG", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: [
        '<svg xmlns="http://www.w3.org/2000/svg">',
        '<rect fill="u\\72l(h\\74tp://attacker.example/resource.svg#g)" />',
        "</svg>",
      ].join(""),
    });
    const message: ChatMessage = {
      id: "mermaid-external-css",
      runId: "run-mermaid-external-css",
      role: "assistant",
      text: "```mermaid\nflowchart LR\nA --> B\n```",
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} />);

    expect(await screen.findByRole("note"))
      .toHaveTextContent("Mermaid 图无法渲染，已显示源码。");
    expect(container.querySelector("pre.mermaid-fallback code"))
      .toHaveTextContent("A --> B");
  });

  it("keeps Mermaid source visible when rendering fails", async () => {
    mermaidMock.render.mockReset().mockRejectedValue(new Error("invalid diagram"));
    const onContentSettled = vi.fn();
    const message: ChatMessage = {
      id: "mermaid-invalid",
      runId: "run-mermaid-invalid",
      role: "assistant",
      text: "```mermaid\nnot a diagram\n```",
      thinking: "",
      tools: [],
    };

    const { container } = render(
      <Message message={message} onContentSettled={onContentSettled} />,
    );

    expect(await screen.findByRole("note"))
      .toHaveTextContent("Mermaid 图无法渲染，已显示源码。");
    expect(container.querySelector("pre.mermaid-fallback code"))
      .toHaveTextContent("not a diagram");
    expect(onContentSettled).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized Mermaid source before invoking the renderer", async () => {
    mermaidMock.render.mockClear();
    const message: ChatMessage = {
      id: "mermaid-oversized",
      runId: "run-mermaid-oversized",
      role: "assistant",
      text: `\`\`\`mermaid\nflowchart LR\n${"A".repeat(50_001)}\n\`\`\``,
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} />);

    expect(await screen.findByRole("note"))
      .toHaveTextContent("Mermaid 图内容过大，已显示源码。");
    expect(container.querySelector("pre.mermaid-fallback code"))
      .toHaveTextContent("flowchart LR");
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("limits the number of Mermaid diagrams in one Markdown response", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
    });
    const message: ChatMessage = {
      id: "mermaid-many",
      runId: "run-mermaid-many",
      role: "assistant",
      text: Array.from({ length: 10 }, (_, index) => [
        "```mermaid",
        `flowchart LR; A${index} --> B${index}`,
        "```",
      ].join("\n")).join("\n\n"),
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} />);

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(8));
    expect(await screen.findAllByRole("img", { name: "Mermaid 图" }))
      .toHaveLength(8);
    expect(screen.getAllByText("Mermaid 图数量或总内容超出限制，已显示源码。"))
      .toHaveLength(2);
    expect(container.querySelectorAll("pre.mermaid-fallback")).toHaveLength(2);
  });

  it("shares the Mermaid budget across tool-separated response text", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
    });
    const diagrams = (start: number, count: number) => Array.from(
      { length: count },
      (_, offset) => [
        "```mermaid",
        `flowchart LR; A${start + offset} --> B${start + offset}`,
        "```",
      ].join("\n"),
    ).join("\n\n");
    const firstText = diagrams(0, 8);
    const secondText = diagrams(8, 2);
    const message: ChatMessage = {
      id: "mermaid-shared-budget",
      runId: "run-mermaid-shared-budget",
      role: "assistant",
      text: `${firstText}\n\n${secondText}`,
      thinking: "",
      tools: [{
        id: "budget-divider",
        name: "read",
        args: { path: "README.md" },
        result: { ok: true },
        status: "done",
      }],
      parts: [
        { kind: "text", text: firstText },
        { kind: "tool", toolId: "budget-divider" },
        { kind: "text", text: secondText },
      ],
    };

    render(<Message message={message} />);

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(8));
    expect(await screen.findAllByRole("img", { name: "Mermaid 图" }))
      .toHaveLength(8);
    expect(screen.getAllByText("Mermaid 图数量或总内容超出限制，已显示源码。"))
      .toHaveLength(2);
  });

  it("keeps collapsed Mermaid allocation independent of expansion order", async () => {
    mermaidMock.render.mockReset().mockImplementation(async (_id, source) => ({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${source.slice(0, 8)}</text></svg>`,
    }));
    const diagram = (label: string) => [
      "```mermaid",
      `flowchart LR\n${label}[${"x".repeat(39_850)}]`,
      "```",
    ].join("\n");
    const firstText = diagram("FIRST");
    const secondText = diagram("SECOND");
    const thirdText = diagram("THIRD");
    const message: ChatMessage = {
      id: "mermaid-collapsed-allocation",
      runId: "run-mermaid-collapsed-allocation",
      role: "assistant",
      text: `${firstText}\n${secondText}\n${thirdText}`,
      thinking: "first divider\nsecond divider",
      tools: [],
      parts: [
        { kind: "text", text: firstText },
        { kind: "thinking", text: "first divider" },
        { kind: "text", text: secondText },
        { kind: "thinking", text: "second divider" },
        { kind: "text", text: thirdText },
      ],
    };

    render(<Message message={message} collapsed />);
    const responseToggles = screen.getAllByText("回复正文");

    fireEvent.click(responseToggles[2]);
    expect(await screen.findByRole("note"))
      .toHaveTextContent("Mermaid 图数量或总内容超出限制，已显示源码。");
    expect(mermaidMock.render).not.toHaveBeenCalled();

    fireEvent.click(responseToggles[0]);
    fireEvent.click(responseToggles[1]);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
    expect(mermaidMock.render.mock.calls[0]?.[1]).toContain("FIRST");
    expect(mermaidMock.render.mock.calls[1]?.[1]).toContain("SECOND");
  });

  it("defers Mermaid rendering in a collapsed historical response", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>deferred diagram</text></svg>',
    });
    const message: ChatMessage = {
      id: "mermaid-collapsed",
      runId: "run-mermaid-collapsed",
      role: "assistant",
      text: "```mermaid\nflowchart LR\nA --> B\n```",
      thinking: "",
      tools: [],
    };

    const { container } = render(<Message message={message} collapsed />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(container.querySelector("pre code")).toHaveTextContent("A --> B");

    fireEvent.click(screen.getByText("回复正文"));

    expect(await screen.findByRole("img", { name: "Mermaid 图" }))
      .toHaveTextContent("deferred diagram");
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
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

  it("waits for a streaming Mermaid fence to close before rendering it", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>streamed diagram</text></svg>',
    });
    const message: ChatMessage = {
      id: "streaming-mermaid",
      runId: "run-streaming-mermaid",
      role: "assistant",
      text: "```mermaid\nflowchart LR\nA --> B",
      thinking: "",
      tools: [],
    };
    const rendered = render(<Message message={message} streamingText />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(rendered.container.querySelector(".streaming-tail"))
      .toHaveTextContent("flowchart LR");

    rendered.rerender(<Message
      message={{ ...message, text: `${message.text}\n\`\`\`\n` }}
      streamingText
    />);

    expect(await screen.findByRole("img", { name: "Mermaid 图" }))
      .toHaveTextContent("streamed diagram");
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("applies the Mermaid budget across stable streaming blocks", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>streamed diagram</text></svg>',
    });
    const message: ChatMessage = {
      id: "streaming-mermaid-budget",
      runId: "run-streaming-mermaid-budget",
      role: "assistant",
      text: `${Array.from({ length: 10 }, (_, index) => [
        "```mermaid",
        `flowchart LR; A${index} --> B${index}`,
        "```",
      ].join("\n")).join("\n\n")}\n`,
      thinking: "",
      tools: [],
    };

    render(<Message message={message} streamingText />);

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(8));
    expect(await screen.findAllByRole("img", { name: "Mermaid 图" }))
      .toHaveLength(8);
    expect(screen.getAllByText("Mermaid 图数量或总内容超出限制，已显示源码。"))
      .toHaveLength(2);
  });

  it("counts every Mermaid token inside one stable streaming block", async () => {
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>streamed diagram</text></svg>',
    });
    const overloadedBlock = (index: number) => [
      "```invalid`",
      "~~~mermaid",
      `flowchart LR; A${index}a --> B${index}a`,
      "~~~",
      "~~~mermaid",
      `flowchart LR; A${index}b --> B${index}b`,
      "~~~",
      "```",
    ].join("\n");
    const message: ChatMessage = {
      id: "streaming-mermaid-multi-token-budget",
      runId: "run-streaming-mermaid-multi-token-budget",
      role: "assistant",
      text: `${Array.from({ length: 8 }, (_, index) => overloadedBlock(index)).join("\n")}\n`,
      thinking: "",
      tools: [],
    };

    render(<Message message={message} streamingText />);

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(8));
    expect(await screen.findAllByRole("img", { name: "Mermaid 图" }))
      .toHaveLength(8);
    expect(screen.getAllByText("Mermaid 图数量或总内容超出限制，已显示源码。"))
      .toHaveLength(8);
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

    const { container } = render(
      <Message message={message} onRewind={onRewind} />,
    );
    expect(container.querySelector(".message-event-header"))
      .toHaveTextContent("COMMANDUSERSENT");
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

  it("fails closed after a Mermaid render exceeds the watchdog", async () => {
    vi.useFakeTimers();
    mermaidMock.render.mockReset().mockReturnValue(new Promise(() => undefined));
    const message: ChatMessage = {
      id: "mermaid-timeout",
      runId: "run-mermaid-timeout",
      role: "assistant",
      text: "```mermaid\nflowchart LR\nA --> B\n```",
      thinking: "",
      tools: [],
    };
    const first = render(<Message message={message} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.getByRole("note"))
      .toHaveTextContent("Mermaid 图无法渲染，已显示源码。");
    first.unmount();

    render(<Message message={{ ...message, id: "mermaid-after-timeout" }} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole("note"))
      .toHaveTextContent("Mermaid 图无法渲染，已显示源码。");
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
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
