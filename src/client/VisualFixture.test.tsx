// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VisualFixture } from "./VisualFixture";

afterEach(cleanup);

describe("VisualFixture", () => {
  it("renders the stable populated workbench state through production components", () => {
    const { container } = render(<VisualFixture />);

    expect(container.querySelector(
      '[data-visual-fixture="populated-workbench"]',
    )).toBeInTheDocument();
    expect(container.querySelectorAll(".workspace-rail-entry")).toHaveLength(4);
    expect(container.querySelectorAll("[data-conversation-id]").length)
      .toBeGreaterThanOrEqual(5);
    expect(screen.getByRole("button", {
      name: "当前会话 建立稳定的视觉验证基线",
    })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("status", { name: "等待其他会话" }))
      .toBeInTheDocument();
    expect(container.querySelector(".activity-running")).toBeInTheDocument();
    expect(container.querySelector(".activity-idle")).toBeInTheDocument();

    expect(screen.getByText("继续：固定丰富状态，并生成两张桌面截图。"))
      .toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "上下文已压缩" }))
      .toBeInTheDocument();
    expect(screen.getByText("01", { selector: ".topbar-session-ordinal" }))
      .toBeInTheDocument();
    expect(screen.getByText("4 AGENTS")).toBeInTheDocument();
    expect(screen.getByLabelText("会话状态：IN PROGRESS"))
      .toBeInTheDocument();
    expect(screen.getByText("BOSS")).toBeInTheDocument();
    const activeAgentEvent = screen.getByText(
      "Tech Lead",
      { selector: ".message-event-actor" },
    ).closest(".message-event-header");
    expect(activeAgentEvent).toHaveTextContent("AGENTTech LeadRUNNING");
    expect(screen.getByText("正在运行命令")).toBeInTheDocument();
    expect(screen.getByText("预计修改 5 个文件")).toBeInTheDocument();
    expect(screen.getByLabelText("4 / 5 FILES LEFT"))
      .toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tasks" }))
      .toHaveTextContent("1/4 · 3 项未完成");
    const mission = screen.getByRole("complementary", {
      name: "Mission Command",
    });
    expect(within(mission).getByRole("heading", { name: "OBJECTIVES" }))
      .toBeInTheDocument();
    expect(within(mission).getByLabelText("3 个未完成目标"))
      .toHaveTextContent("1 CLEARED");
    expect(within(mission).getByText("复用真实工作台组件与状态样式")
      .closest("li")).toHaveClass("is-active");
    expect(mission).toHaveTextContent("Tech Lead");
    expect(mission).toHaveTextContent("RUNRUNNING");
    expect(within(mission).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("COMMAND", {
      selector: ".composer-command-label",
    })).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "发送" }))
      .toHaveTextContent("SEND");
    expect(screen.getByRole("button", { name: "停止" }))
      .toHaveTextContent("STOP");
    const composerMeta = container.querySelector(".composer-meta");
    expect(composerMeta).toHaveTextContent("Tech Lead");
    for (const key of ["TO", "MODEL", "EFFORT", "SERVICE"]) {
      expect(within(composerMeta as HTMLElement).getByText(key, {
        selector: ".composer-meta-key",
      })).toBeInTheDocument();
    }
    expect(screen.getByDisplayValue("检查两张截图中的层级、密度与状态辨识度。"))
      .toBeInTheDocument();
  });
});
