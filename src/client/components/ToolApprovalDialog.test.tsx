// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolApprovalDialog } from "./ToolApprovalDialog";

afterEach(cleanup);

const request = {
  approvalId: "8f310256-f2ab-481d-8ca2-f20a43392ba3",
  toolCallId: "tool-1",
  toolName: "write",
  args: { path: "C:\\outside\\file.ts" },
  reason: "目标位于工作区外。",
};

describe("ToolApprovalDialog", () => {
  it("shows the effective arguments, focuses the safe action, and submits only once", () => {
    const decide = vi.fn();
    const abort = vi.fn();
    render(<ToolApprovalDialog
      request={request}
      pendingCount={1}
      online
      cancelling={false}
      submitting={false}
      onDecision={(decision) => {
        decide(decision);
        return true;
      }}
      onAbort={abort}
    />);

    expect(screen.getByRole("dialog", { name: "工具执行审批" })).toHaveTextContent("outside");
    expect(screen.getByRole("button", { name: "拒绝此次工具" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    fireEvent.click(screen.getByRole("button", { name: "停止本次运行" }));

    expect(decide.mock.calls).toEqual([["allow"]]);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("requires an explicit re-arm before a following approval can be decided", () => {
    const decide = vi.fn(() => true);
    const view = render(<ToolApprovalDialog
      request={request}
      pendingCount={2}
      online
      cancelling={false}
      submitting={false}
      onDecision={decide}
      onAbort={() => undefined}
    />);
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));

    const next = {
      ...request,
      approvalId: "68aaf24e-0bb5-4e64-ad5f-fffe4503324e",
      toolCallId: "tool-2",
      args: { command: "second command" },
    };
    view.rerender(<ToolApprovalDialog
      request={next}
      pendingCount={1}
      online
      cancelling={false}
      submitting={false}
      onDecision={decide}
      onAbort={() => undefined}
    />);

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(decide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "处理下一项" }));
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(decide.mock.calls).toEqual([["allow"], ["allow"]]);
  });

  it("disables authorization while the run is cancelling", () => {
    render(<ToolApprovalDialog
      request={request}
      pendingCount={1}
      online
      cancelling
      submitting={false}
      onDecision={() => true}
      onAbort={() => undefined}
    />);

    expect(screen.getByRole("button", { name: "拒绝此次工具" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在停止…" })).toBeDisabled();
  });

  it("keeps focus inside the modal and treats Escape as a safe denial", () => {
    const decide = vi.fn(() => true);
    render(<>
      <button>背景操作</button>
      <ToolApprovalDialog
        request={request}
        pendingCount={1}
        online
        cancelling={false}
        submitting={false}
        onDecision={decide}
        onAbort={() => undefined}
      />
    </>);

    const background = screen.getByRole("button", { name: "背景操作" });
    background.focus();
    expect(screen.getByRole("button", { name: "拒绝此次工具" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(decide).toHaveBeenCalledWith("deny");
  });
});
