// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../shared/protocol";
import type { ToolItem } from "../chat/reducer";
import { createConversationTitleLookup } from "../lib/conversation-display";
import { ToolCard } from "./ToolCard";

const tool: ToolItem = {
  id: "1",
  name: "read",
  args: { path: "src/index.ts" },
  result: { ok: true },
  status: "done",
};

afterEach(() => {
  cleanup();
});

describe("ToolCard", () => {
  it("is compact by default and describes the action and target", () => {
    const { container } = render(<ToolCard tool={tool} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = container.querySelector("summary") as HTMLElement;

    expect(details?.open).toBe(false);
    expect(summary).toBeTruthy();
    expect(summary).toHaveTextContent("读取文件");
    expect(summary).toHaveTextContent("src/index.ts");
    expect(summary).not.toHaveTextContent("---");
  });

  it.each([
    ["peek_session", "查看会话消息"],
    ["send_session_message", "发送会话消息"],
    ["wait_for_session", "等待 Agent 会话"],
    ["abort_session", "终止 Agent 会话"],
    ["delete_session", "删除 Agent 会话"],
  ])("resolves the project title for %s without hiding its raw details", (
    name,
    label,
  ) => {
    const conversationId = "12345678-1234-4234-8234-123456789abc";
    const conversation: ConversationSummary = {
      id: conversationId,
      name: "架构审查",
      preview: "",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T09:00:00.000Z",
      messageCount: 1,
      activity: { kind: "idle" },
      compacting: false,
    };
    const targetedTool: ToolItem = {
      id: `target-${name}`,
      name,
      args: name === "wait_for_session"
        ? { targets: [{ conversationId, runId: "peer-run" }] }
        : { conversationId, runId: "peer-run" },
      status: "pending",
    };
    const { container } = render(
      <ToolCard
        tool={targetedTool}
        conversationTitleLookup={createConversationTitleLookup(
          [conversation],
          false,
        )}
      />,
    );
    const summary = container.querySelector("summary") as HTMLElement;

    expect(summary).toHaveTextContent(label);
    const targetTitle = name === "wait_for_session"
      ? "1 个会话 · 架构审查"
      : "架构审查";
    expect(summary).toHaveTextContent(targetTitle);
    expect(summary.querySelector(".tool-target")).toHaveAttribute(
      "title",
      targetTitle,
    );
    expect(summary).not.toHaveTextContent(conversationId);

    fireEvent.click(summary);
    expect(screen.getByText(conversationId)).toBeInTheDocument();
  });

  it("keeps a multi-target wait aggregate while resolving every current title", () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const conversations = [
      { id: firstId, name: "安全审查" },
      { id: secondId, name: "视觉核对" },
    ].map(({ id, name }): ConversationSummary => ({
      id,
      name,
      preview: "",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T09:00:00.000Z",
      messageCount: 1,
      activity: { kind: "idle" },
      compacting: false,
    }));
    const aggregateTool: ToolItem = {
      id: "wait-many",
      name: "wait_for_session",
      args: {
        targets: [
          { conversationId: firstId, runId: "run-1" },
          { conversationId: secondId, runId: "run-2" },
        ],
      },
      status: "pending",
    };
    const { container } = render(
      <ToolCard
        tool={aggregateTool}
        conversationTitleLookup={createConversationTitleLookup(
          conversations,
          false,
        )}
      />,
    );
    const summary = container.querySelector("summary") as HTMLElement;

    expect(summary).toHaveTextContent("2 个会话");
    expect(summary).toHaveTextContent("安全审查");
    expect(summary).toHaveTextContent("视觉核对");
  });

  it("keeps a multi-target send aggregate while resolving every current title", () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const conversations = [
      { id: firstId, name: "安全审查" },
      { id: secondId, name: "视觉核对" },
    ].map(({ id, name }): ConversationSummary => ({
      id,
      name,
      preview: "",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T09:00:00.000Z",
      messageCount: 1,
      activity: { kind: "idle" },
      compacting: false,
    }));
    const aggregateTool: ToolItem = {
      id: "send-many",
      name: "send_session_message",
      args: {
        conversationIds: [firstId, secondId],
        summary: "同时核对",
        message: "Review the same change.",
      },
      status: "pending",
    };
    const { container } = render(
      <ToolCard
        tool={aggregateTool}
        conversationTitleLookup={createConversationTitleLookup(
          conversations,
          false,
        )}
      />,
    );
    const summary = container.querySelector("summary") as HTMLElement;

    expect(summary).toHaveTextContent("2 个会话");
    expect(summary).toHaveTextContent("安全审查");
    expect(summary).toHaveTextContent("视觉核对");
    expect(summary).not.toHaveTextContent(firstId);

    fireEvent.click(summary);
    expect(screen.getByText("会话句柄列表")).toBeInTheDocument();
    expect(screen.getByText(firstId)).toBeInTheDocument();
    expect(screen.getByText(secondId)).toBeInTheDocument();
  });

  it("expands to reveal readable fields instead of raw JSON", () => {
    const { container } = render(<ToolCard tool={tool} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = container.querySelector("summary") as HTMLElement;

    fireEvent.click(summary);

    expect(details.open).toBe(true);
    expect(screen.getByText("调用内容")).toBeInTheDocument();
    expect(screen.getByText("路径")).toBeInTheDocument();
    expect(screen.getByText("结果")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("\"path\"");
    expect(container).not.toHaveTextContent("\"ok\"");
  });

  it("presents bash commands and output as task-oriented content", () => {
    const bashTool: ToolItem = {
      id: "bash-1",
      name: "bash",
      args: { command: "npm test", timeout: 30_000 },
      result: {
        content: [{ type: "text", text: "42 tests passed" }],
        details: {},
      },
      status: "done",
    };
    const { container } = render(<ToolCard tool={bashTool} />);
    const summary = container.querySelector("summary") as HTMLElement;

    expect(summary).toHaveTextContent("运行命令");
    expect(summary).toHaveTextContent("npm test");
    fireEvent.click(summary);

    expect(screen.getByText("命令")).toBeInTheDocument();
    expect(screen.getByText("超时")).toBeInTheDocument();
    expect(screen.getByText("30 秒")).toBeInTheDocument();
    expect(screen.getByText("42 tests passed")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("\"content\"");
  });

  it.each([
    ["bash", "in_progress", "返回时命令仍在执行", "tool-bash-in-progress"],
    ["bash_output", "in_progress", "返回时命令仍在执行", "tool-bash-in-progress"],
    ["bash_poll", "in_progress", "返回时命令仍在执行", "tool-bash-in-progress"],
    ["bash_stop", "stopping", "已请求停止，尚未确认退出", "tool-bash-stopping"],
  ])("does not present a background or stopping Bash result as command success", (
    name,
    state,
    label,
    className,
  ) => {
    const backgroundTool: ToolItem = {
      id: `background-${name}`,
      name,
      args: name === "bash"
        ? { command: "npm test", run_in_background: true }
        : { task_id: "task-1" },
      result: {
        content: [{ type: "text", text: "The tool call returned." }],
        details: {
          piwebBash: { executionId: "execution-1", state },
        },
      },
      status: "done",
    };
    const { container } = render(<ToolCard tool={backgroundTool} />);
    const summary = container.querySelector("summary") as HTMLElement;

    expect(summary).toHaveTextContent(label);
    expect(summary).not.toHaveTextContent("已完成");
    expect(summary.querySelector(".tool-status")).toHaveAttribute(
      "aria-label",
      label,
    );
    expect(container.querySelector("details")).toHaveClass(className);
  });

  it("summarizes legacy execution lists and current Bash task lists", () => {
    const poll: ToolItem = {
      id: "poll-many",
      name: "bash_output",
      args: {},
      result: {
        content: [{ type: "text", text: "Two active commands." }],
        details: {
          piwebBash: {
            executions: [
              { executionId: "one", state: "in_progress" },
              { executionId: "two", state: "stopping" },
            ],
          },
        },
      },
      status: "done",
    };
    const { container } = render(<ToolCard tool={poll} />);
    const summary = container.querySelector("summary") as HTMLElement;

    expect(summary).toHaveTextContent("本次查询时仍有 1 个执行中，1 个停止中");
    expect(container.querySelector("details")).toHaveClass("tool-bash-stopping");

    const tasks: ToolItem = {
      ...poll,
      id: "tasks-many",
      result: {
        content: [{ type: "text", text: "Two background tasks." }],
        details: {
          piwebBash: {
            tasks: [
              { taskId: "task-one", state: "in_progress" },
              { taskId: "task-two", state: "stopping" },
            ],
          },
        },
      },
    };
    const taskView = render(<ToolCard tool={tasks} />);
    const taskSummary = taskView.container.querySelector("summary") as HTMLElement;

    expect(taskSummary).toHaveTextContent("本次查询时仍有 1 个执行中，1 个停止中");
    expect(taskView.container.querySelector("details")).toHaveClass("tool-bash-stopping");
  });

  it("shows bash_output task_id and blocking timeout using the new API labels", () => {
    const outputTool: ToolItem = {
      id: "bash-output-1",
      name: "bash_output",
      args: { task_id: "task-7", block: true, timeout: 30_000 },
      result: {
        content: [{ type: "text", text: "build finished" }],
        details: {},
      },
      status: "done",
    };
    const { container } = render(<ToolCard tool={outputTool} />);
    const summary = container.querySelector("summary") as HTMLElement;

    expect(summary).toHaveTextContent("获取后台命令结果");
    expect(summary).toHaveTextContent("task-7");
    fireEvent.click(summary);
    expect(screen.getByText("后台任务句柄")).toBeInTheDocument();
    expect(screen.getByText("阻塞等待")).toBeInTheDocument();
    expect(screen.getByText("30 秒")).toBeInTheDocument();
    expect(screen.getByText("build finished")).toBeInTheDocument();
  });

  it("does not call partial output successful even with exit code zero", () => {
    const { container } = render(<ToolCard tool={{
      id: "partial-output",
      name: "bash_output",
      args: { task_id: "task-1" },
      result: {
        content: [{ type: "text", text: "partial output" }],
        details: { piwebBash: { taskId: "task-1", state: "finished", exitCode: 0, partial: true } },
      },
      status: "done",
    }} />);
    expect(container.querySelector("summary")).toHaveTextContent("命令已结束，输出不完整");
    expect(container.querySelector("summary")).not.toHaveTextContent("命令正常结束");
  });

  it("renders Agent session tool results as structured information", () => {
    const sessionsTool: ToolItem = {
      id: "sessions-1",
      name: "list_sessions",
      args: { scope: "created_by_me", limit: 20 },
      result: {
        content: [{
          type: "text",
          text: "{\"sessions\":[{\"title\":\"API 审查\",\"handle\":\"peer-7\"}]}",
        }],
        details: {
          sessions: [{
            title: "API 审查",
            handle: "peer-7",
            canManageSessions: true,
            activity: { kind: "running" },
            lastActiveAt: "2026-07-19T09:45:24.828Z",
          }],
          nextCursor: null,
        },
      },
      status: "done",
    };
    const { container } = render(<ToolCard tool={sessionsTool} />);
    const summary = container.querySelector("summary") as HTMLElement;

    expect(summary).toHaveTextContent("查看会话");
    expect(summary).toHaveTextContent("我创建的会话");
    fireEvent.click(summary);

    expect(screen.getByText("会话")).toBeInTheDocument();
    expect(screen.getByText("API 审查")).toBeInTheDocument();
    expect(screen.getByText("peer-7")).toBeInTheDocument();
    expect(screen.getByText("可管理会话")).toBeInTheDocument();
    expect(screen.getByText("运行状态")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("最后活跃")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("\"sessions\"");
  });

  it("renders mixed and image-only result blocks through durable image locators", () => {
    const onOpenImage = vi.fn();
    const imageTool: ToolItem = {
      id: "image-tool",
      name: "custom_image_tool",
      args: {},
      result: {
        content: [
          { type: "text", text: "before" },
          { type: "image" },
          { type: "text", text: "after" },
          { type: "image" },
        ],
      },
      resultImageRefs: [{
        contentIndex: 1,
        source: { messageId: "tool-result-entry", imageOrdinal: 0 },
      }, {
        contentIndex: 3,
        source: { messageId: "tool-result-entry", imageOrdinal: 1 },
      }],
      status: "done",
    };
    const { container } = render(
      <ToolCard tool={imageTool} onOpenImage={onOpenImage} />,
    );

    fireEvent.click(container.querySelector("summary") as HTMLElement);
    const links = screen.getAllByRole("button", {
      name: /在新标签页中打开图片/,
    });
    expect(links).toHaveLength(2);
    expect(container.querySelector(".tool-section:last-child")?.textContent)
      .toBe("结果before查看图片 01 ↗after查看图片 02 ↗");

    fireEvent.click(links[1]!);
    expect(onOpenImage).toHaveBeenCalledWith({
      messageId: "tool-result-entry",
      imageOrdinal: 1,
    });
  });

  it("renders an unmatched image marker as explicitly unavailable", () => {
    const unavailableTool: ToolItem = {
      id: "unavailable-image-tool",
      name: "custom_image_tool",
      result: {
        content: [
          { type: "image" },
          { type: "image" },
        ],
      },
      resultImageRefs: [{
        contentIndex: 1,
        source: { messageId: "retained-tool-result", imageOrdinal: 1 },
      }],
      status: "done",
    };
    const { container } = render(
      <ToolCard tool={unavailableTool} onOpenImage={vi.fn()} />,
    );

    fireEvent.click(container.querySelector("summary") as HTMLElement);

    expect(screen.getByText("[图片已省略]")).toBeInTheDocument();
    expect(screen.getAllByRole("button", {
      name: /在新标签页中打开图片/,
    })).toHaveLength(1);
  });

  it("describes an empty tool result without exposing implementation values", () => {
    const emptyTool: ToolItem = {
      ...tool,
      result: { content: [], details: undefined },
    };
    const { container } = render(<ToolCard tool={emptyTool} />);

    fireEvent.click(container.querySelector("summary") as HTMLElement);

    expect(screen.getByText("无输出")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("undefined");
  });
});
