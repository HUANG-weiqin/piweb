// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSessionRepairReport } from "../../shared/protocol";
import { WorkspaceSessionRepairDialog } from "./WorkspaceSessionRepairDialog";

afterEach(cleanup);

const cleanReport: WorkspaceSessionRepairReport = {
  cwd: "E:\\workspace",
  checkedFiles: 1,
  issues: [],
  truncated: false,
};

function callbacks() {
  return {
    onInspect: vi.fn(),
    onRepair: vi.fn(),
    onRetryRecovery: vi.fn(),
    onRevalidateAndEnter: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("WorkspaceSessionRepairDialog", () => {
  it("does not treat a clean inspect as completed recovery", () => {
    const handlers = callbacks();
    render(<WorkspaceSessionRepairDialog
      open
      cwd={cleanReport.cwd}
      online
      report={cleanReport}
      reportFresh
      backups={[]}
      {...handlers}
    />);

    expect(screen.getByText(/进入时将重新校验服务端恢复状态/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新校验并进入工作区" }));
    expect(handlers.onRevalidateAndEnter).toHaveBeenCalledOnce();
  });

  it("explains that truncated issues must be repaired before another complete inspection", () => {
    render(<WorkspaceSessionRepairDialog
      open
      cwd={cleanReport.cwd}
      online
      report={{ ...cleanReport, truncated: true }}
      reportFresh
      backups={[]}
      {...callbacks()}
    />);

    expect(screen.getByText(/尚有未展示的问题；先修复列出的可修复项，再重新检查/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新校验并进入工作区" }))
      .not.toBeInTheDocument();
  });

  it("allows leaving an unknown repair result while preserving confirmed backups for review", () => {
    const handlers = callbacks();
    render(<WorkspaceSessionRepairDialog
      open
      cwd={cleanReport.cwd}
      online={false}
      report={cleanReport}
      reportFresh={false}
      backups={[{ fileName: "session.jsonl", backupPath: "E:\\workspace\\backup.jsonl" }]}
      needsRecheck
      error="连接已断开，修复结果未确认。"
      {...handlers}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("修复结果未确认");
    expect(screen.getByText("E:\\workspace\\backup.jsonl")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新校验并进入工作区" })).not.toBeInTheDocument();
    const close = screen.getByRole("button", { name: "关闭会话数据检查" });
    expect(close).toBeEnabled();
    fireEvent.click(close);
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("temporarily locks dismissal only while an actual repair command is pending", () => {
    render(<WorkspaceSessionRepairDialog
      open
      cwd={cleanReport.cwd}
      online={false}
      report={cleanReport}
      reportFresh={false}
      backups={[]}
      pending="repair"
      needsRecheck
      {...callbacks()}
    />);

    expect(screen.getByRole("button", { name: "关闭会话数据检查" })).toBeDisabled();
  });
});
