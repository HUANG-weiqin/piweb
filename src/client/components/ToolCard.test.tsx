// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolItem } from "../chat/reducer";
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

  it("shows an unfinished wait as active rather than failed", () => {
    const waitingTool: ToolItem = {
      id: "wait-1",
      name: "wait_for_session",
      args: { conversationId: "peer", runId: "peer-run" },
      status: "pending",
    };
    const { container } = render(<ToolCard tool={waitingTool} />);
    const summary = container.querySelector("summary") as HTMLElement;

    expect(screen.getByLabelText("等待执行")).toBeInTheDocument();
    expect(summary).not.toHaveTextContent("执行失败");
    expect(summary).toHaveTextContent("等待 Agent 会话");
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
