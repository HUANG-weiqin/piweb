// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("正在运行命令")).toBeInTheDocument();
    expect(screen.getByText("预计修改 5 个文件")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tasks" }))
      .toHaveTextContent("1/4 · 3 项未完成");
    expect(screen.getByDisplayValue("检查两张截图中的层级、密度与状态辨识度。"))
      .toBeInTheDocument();
  });
});
