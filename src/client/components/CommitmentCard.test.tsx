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
            grantedFiles: 3,
            touchedFiles: 1,
            remainingFiles: 2,
            blockedAttempts: 0,
          }),
        }],
        details: {
          outcome: "edit_budget_granted",
          grantedFiles: 3,
          touchedFiles: 1,
          remainingFiles: 2,
          blockedAttempts: 0,
        },
      },
      status: "done",
    };
    const { container, rerender } = render(
      <CommitmentCard tool={tool} observedEditBudgetRemainingFiles={2} />,
    );
    const card = container.querySelector("details.commitment-card") as HTMLDetailsElement;

    expect(card.open).toBe(false);
    expect(screen.getByText("BUDGET ESTIMATE")).toBeInTheDocument();
    expect(screen.getByText("预计修改 3 个文件")).toBeInTheDocument();
    expect(container.querySelector(".commitment-reason"))
      .toHaveTextContent("修复 active run 与历史恢复之间的参数一致性。");
    expect(container.querySelector(".commitment-reason"))
      .toHaveAttribute("title", "修复 active run 与历史恢复之间的参数一致性。");
    expect(screen.getByText("本轮额度 3")).toBeInTheDocument();
    expect(screen.getByText("本轮剩余 2")).toBeInTheDocument();
    expect(screen.getByLabelText("2 / 3 FILES LEFT")).toBeInTheDocument();

    rerender(<CommitmentCard tool={tool} observedEditBudgetRemainingFiles={10} />);
    expect(screen.getByLabelText("10 FILES LEFT")).toBeInTheDocument();
    expect(screen.queryByLabelText("10 / 3 FILES LEFT")).not.toBeInTheDocument();

    fireEvent.click(card.querySelector("summary") as HTMLElement);

    expect(card.open).toBe(true);
    expect(screen.getByText("调用内容")).toBeInTheDocument();
    expect(screen.getByText("预计文件数")).toBeInTheDocument();
    expect(screen.queryByText("单独等待理由")).not.toBeInTheDocument();
    expect(screen.getByText("总额度")).toBeInTheDocument();
    expect(screen.getByText("已修改文件")).toBeInTheDocument();
    expect(screen.getByText("已授予编辑额度")).toBeInTheDocument();
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
