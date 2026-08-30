// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolItem } from "../chat/reducer";
import { CommitmentCard } from "./CommitmentCard";

afterEach(() => {
  cleanup();
});

describe("CommitmentCard", () => {
  it("keeps an edit commitment and its budget facts visible with readable details", () => {
    const tool: ToolItem = {
      id: "budget-1",
      name: "request_edit_budget",
      args: {
        fileCount: 3,
        reason: "修复 active run 与历史恢复之间的参数一致性。",
      },
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            outcome: "edit_budget_granted",
            addedFiles: 3,
            grantedFiles: 3,
            touchedFiles: 1,
            remainingFiles: 2,
            blockedAttempts: 0,
          }),
        }],
        details: {
          outcome: "edit_budget_granted",
          addedFiles: 3,
          grantedFiles: 3,
          touchedFiles: 1,
          remainingFiles: 2,
          blockedAttempts: 0,
        },
      },
      status: "done",
    };
    const { container } = render(
      <CommitmentCard tool={tool} observedEditBudgetRemainingFiles={2} />,
    );
    const card = container.querySelector("details.commitment-card") as HTMLDetailsElement;

    expect(card.open).toBe(false);
    expect(screen.getByText("编辑承诺")).toBeInTheDocument();
    expect(screen.getByText("预计修改 3 个文件")).toBeInTheDocument();
    expect(container.querySelector(".commitment-reason"))
      .toHaveTextContent("修复 active run 与历史恢复之间的参数一致性。");
    expect(container.querySelector(".commitment-reason"))
      .toHaveAttribute("title", "修复 active run 与历史恢复之间的参数一致性。");
    expect(screen.getByText("新增额度 3")).toBeInTheDocument();
    expect(screen.getByText("本轮剩余 2")).toBeInTheDocument();

    fireEvent.click(card.querySelector("summary") as HTMLElement);

    expect(card.open).toBe(true);
    expect(screen.getByText("调用内容")).toBeInTheDocument();
    expect(screen.getByText("预计文件数")).toBeInTheDocument();
    expect(screen.queryByText("单独等待理由")).not.toBeInTheDocument();
    expect(screen.getByText("总额度")).toBeInTheDocument();
    expect(screen.getByText("已修改文件")).toBeInTheDocument();
    expect(screen.getByText("已授予编辑额度")).toBeInTheDocument();
  });

  it("shows a pending single-session wait with its reason and spinner", () => {
    const tool: ToolItem = {
      id: "wait-1",
      name: "wait_for_session",
      args: {
        conversationId: "API 审查 Agent",
        runId: "run-peer",
        singleWaitCommitment: "  该审查位于提交前关键路径；没有独立工作可继续。  ",
      },
      status: "pending",
    };
    const { container } = render(<CommitmentCard tool={tool} />);

    expect(screen.getByText("单会话等待承诺")).toBeInTheDocument();
    expect(screen.getByText("等待 API 审查 Agent")).toBeInTheDocument();
    expect(container.querySelector(".commitment-reason"))
      .toHaveTextContent("该审查位于提交前关键路径；没有独立工作可继续。");
    expect(screen.getByText("等待中")).toBeInTheDocument();
    expect(container.querySelector(".commitment-spinner")).toBeInTheDocument();
  });

  it("uses the warning variant when a single-session wait was not started", () => {
    const tool: ToolItem = {
      id: "wait-warning",
      name: "wait_for_session",
      args: { conversationId: "peer", runId: "peer-run" },
      result: {
        content: [],
        details: { outcome: "single_wait_commitment_required" },
      },
      status: "done",
    };
    const { container } = render(<CommitmentCard tool={tool} />);

    expect(container.querySelector(".commitment-card")).toHaveClass("is-warning");
    expect(screen.getByText("等待未开始")).toBeInTheDocument();
    expect(screen.getByText("需要先说明单独等待的理由")).toBeInTheDocument();
    expect(screen.getByText("可以继续本地工作、改为多目标等待，或带承诺再次调用。"))
      .toBeInTheDocument();
    expect(screen.queryByText("等待中")).not.toBeInTheDocument();
  });

  it("uses the error variant only when a declared action is rejected", () => {
    const tool: ToolItem = {
      id: "budget-error",
      name: "request_edit_budget",
      args: { fileCount: 2, reason: "扩大服务端改动范围。" },
      result: { message: "request rejected" },
      status: "error",
    };
    const { container } = render(<CommitmentCard tool={tool} />);

    expect(container.querySelector(".commitment-card")).toHaveClass("is-error");
    expect(container.querySelector(".commitment-card")).not.toHaveClass("is-warning");
    expect(screen.getByText("执行失败")).toBeInTheDocument();
  });
});
