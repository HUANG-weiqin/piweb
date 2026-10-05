// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisualFixture } from "./VisualFixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VisualFixture", () => {
  it("offers a stopped original without replacing the fixture draft, then restores it after explicit draft clearing", () => {
    render(<VisualFixture showComposerStates />);
    const summary = screen.getByText("恢复输入 · 1 条");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    const panel = screen.getByRole("region", { name: "恢复输入" });
    expect(within(panel).getByRole("button", { name: "恢复到输入框" })).toBeDisabled();
    const draft = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    expect(draft).toHaveValue("检查两张截图中的层级、密度与状态辨识度。");
    fireEvent.change(draft, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "移除图片 1" }));
    fireEvent.click(within(panel).getByRole("button", { name: "恢复到输入框" }));
    expect(draft).toHaveValue("停止后保留的原输入。请先清空当前草稿，再手动恢复。");
    expect(screen.queryByText("恢复输入 · 1 条")).not.toBeInTheDocument();
  });
  it("starts its phone adapter on the conversation page", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(max-width: 600px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })));
    const { container } = render(<VisualFixture />);

    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "工作区" }))
      .not.toBeInTheDocument();
    expect(container.querySelectorAll(".app-shell")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", {
      name: "当前会话 建立稳定的视觉验证基线",
    }));
    expect(screen.getByRole("main")).toHaveClass("app-shell");
  });

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
    expect(screen.getAllByRole("status", { name: "等待其他会话" }))
      .toHaveLength(2);
    const cleanWaitingRow = container.querySelector<HTMLElement>(
      '[data-conversation-id="66666666-6666-4666-8666-666666666666"]',
    )!;
    const adjacentIdleRow = container.querySelector<HTMLElement>(
      '[data-conversation-id="77777777-7777-4777-8777-777777777777"]',
    )!;
    expect(cleanWaitingRow).toHaveClass("activity-waiting");
    expect(within(cleanWaitingRow).getByRole("status", {
      name: "等待其他会话",
    })).toHaveTextContent("⌛");
    expect(within(cleanWaitingRow).getByText("Tech Lead", {
      selector: ".conversation-sidebar-role",
    })).toBeInTheDocument();
    expect(adjacentIdleRow).toHaveClass("activity-idle");
    expect(within(adjacentIdleRow).queryByRole("status", {
      name: "等待其他会话",
    })).not.toBeInTheDocument();
    expect(container.querySelector(".activity-running")).toBeInTheDocument();
    expect(container.querySelector(".activity-idle")).toBeInTheDocument();

    const imageLinks = screen.getAllByRole("button", {
      name: "在新标签页中打开图片 1",
    });
    expect(imageLinks).toHaveLength(2);
    for (const imageLink of imageLinks) {
      expect(imageLink).toHaveTextContent("查看图片 01 ↗");
    }
    expect(screen.getByRole("separator", { name: "上下文已压缩：模型未记录" }))
      .toBeInTheDocument();
    expect(container.querySelectorAll("details.commitment-card"))
      .toHaveLength(1);
    expect(screen.getByText("BUDGET ESTIMATE")).toBeInTheDocument();
    expect(screen.getByText("01", { selector: ".topbar-session-ordinal" }))
      .toBeInTheDocument();
    expect(screen.getByText("4 AGENTS")).toBeInTheDocument();
    expect(screen.getByLabelText("会话状态：IN PROGRESS"))
      .toBeInTheDocument();
    expect(screen.getByText("USER")).toBeInTheDocument();
    const activeAgentEvent = screen.getByText(
      "Tech Lead",
      { selector: ".message-event-actor" },
    ).closest(".message-event-header");
    expect(activeAgentEvent).toHaveTextContent("AGENTTech LeadRUNNING");
    expect(screen.getByText("正在运行命令")).toBeInTheDocument();
    expect(screen.getByText("2 个会话 · 核对组件状态覆盖 · 历史验证记录"))
      .toHaveAttribute(
        "title",
        "2 个会话 · 核对组件状态覆盖 · 历史验证记录",
      );
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
    expect(within(mission).queryByRole("region", { name: "Activity" }))
      .not.toBeInTheDocument();
    expect(within(mission).queryByRole("heading", { name: "ACTIVITY" }))
      .not.toBeInTheDocument();
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
