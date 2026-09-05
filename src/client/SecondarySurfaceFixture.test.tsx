// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecondarySurfaceFixture } from "./SecondarySurfaceFixture";

const { piSocketConstructor } = vi.hoisted(() => ({
  piSocketConstructor: vi.fn(),
}));

vi.mock("./lib/socket", () => ({
  PiSocket: piSocketConstructor,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  piSocketConstructor.mockClear();
  vi.restoreAllMocks();
});

function renderSurface(surface?: string) {
  const query = surface === undefined
    ? "?fixture=secondary"
    : `?fixture=secondary&surface=${encodeURIComponent(surface)}`;
  window.history.replaceState({}, "", `/${query}`);
  return render(<SecondarySurfaceFixture />);
}

const scenes: Array<{
  surface: string;
  group: "A" | "B";
  assertSurface(container: HTMLElement): void;
}> = [{
  surface: "drawer",
  group: "A",
  assertSurface: (container) => {
    const dialog = screen.getByRole("dialog", { name: "模型连接" });
    expect(dialog).toBeInTheDocument();
    expect(container.querySelector(".drawer")).toBeInTheDocument();
    expect(within(dialog).getAllByText("GPT-5.6 Luna")).toHaveLength(2);
  },
}, {
  surface: "role-manager",
  group: "A",
  assertSurface: (container) => {
    expect(screen.getByRole("dialog", { name: "管理角色" })).toBeInTheDocument();
    expect(container.querySelector(".role-manager-dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑角色 Legacy Explorer" }))
      .toHaveClass("unavailable");
  },
}, {
  surface: "role-switch",
  group: "A",
  assertSurface: (container) => {
    expect(screen.getByRole("dialog", { name: "更换会话角色" }))
      .toBeInTheDocument();
    expect(container.querySelector(".conversation-role-dialog"))
      .toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Read-only Reviewer/ }))
      .toBeInTheDocument();
  },
}, {
  surface: "directory",
  group: "A",
  assertSurface: (container) => {
    expect(screen.getByRole("dialog", { name: "选择项目目录" }))
      .toBeInTheDocument();
    expect(container.querySelector(".directory-browser-modal"))
      .toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^打开文件夹/ }))
      .toHaveLength(3);
  },
}, {
  surface: "auth",
  group: "A",
  assertSurface: (container) => {
    expect(screen.getByRole("dialog", { name: "登录订阅账户" }))
      .toBeInTheDocument();
    expect(container.querySelector(".device-code")).toHaveTextContent("PIWEB-4821");
    expect(screen.getByRole("link", { name: "打开验证页面" }))
      .toBeInTheDocument();
  },
}, {
  surface: "extension",
  group: "A",
  assertSurface: (container) => {
    expect(screen.getByRole("dialog", { name: "选择发布目标" }))
      .toBeInTheDocument();
    expect(container.querySelector(".extension-modal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "共享测试环境" }))
      .toBeInTheDocument();
  },
}, {
  surface: "feedback",
  group: "A",
  assertSurface: (container) => {
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toHaveClass("transition-status-overlay");
    expect(container.querySelector(".notice-toast.warning"))
      .toHaveTextContent("固定视觉样本");
    expect(screen.getByRole("alert")).toHaveClass("error-toast");
  },
}, {
  surface: "context-tooltip",
  group: "A",
  assertSurface: (container) => {
    const anchor = container.querySelector(".context-stat");
    const tooltip = screen.getByRole("tooltip");
    expect(anchor).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveClass("token-tooltip");
  },
}, {
  surface: "activity-expanded",
  group: "A",
  assertSurface: (container) => {
    const ledger = container.querySelector(
      "details.assistant-activity-group.is-active",
    ) as HTMLDetailsElement;
    fireEvent.click(ledger.querySelector(":scope > summary") as HTMLElement);
    const tools = ledger.querySelector(
      ".activity-timeline > details.tools",
    ) as HTMLDetailsElement;
    fireEvent.click(tools.querySelector(":scope > summary") as HTMLElement);
    fireEvent.click(within(tools).getByRole("button", { name: "展开全部 6 条" }));

    expect(ledger.open).toBe(true);
    expect(tools.open).toBe(true);
    expect(tools.querySelectorAll("details.tool")).toHaveLength(6);
  },
}, {
  surface: "commitment-expanded",
  group: "A",
  assertSurface: (container) => {
    const card = container.querySelector(
      "details.commitment-card",
    ) as HTMLDetailsElement;
    const summary = card.querySelector("summary") as HTMLElement;

    expect(card.open).toBe(false);
    fireEvent.click(summary);
    expect(card.open).toBe(true);
    expect(container.querySelector(".tool-text"))
      .toHaveTextContent("边界行 24 / 24");
  },
}, ...(["jump-latest", "jump-latest-focus"] as const).map((surface) => ({
  surface,
  group: "A" as const,
  assertSurface: (container: HTMLElement) => {
    expect(container.querySelector(".transcript")).toBeInTheDocument();
    expect(container.querySelector(".composer-wrap")).toBeInTheDocument();
  },
})), {
  surface: "composer-states",
  group: "A",
  assertSurface: () => {
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("先核对长路径与失败状态");
    expect(screen.getByRole("alert"))
      .toHaveTextContent("新指令会进入现有 steering 顺序");
    const tasks = screen.getByRole("button", { name: /Tasks/ });
    fireEvent.click(tasks);
    expect(tasks).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Tasks" }))
      .toHaveTextContent("复用真实工作台组件与状态样式");
  },
}, {
  surface: "setup",
  group: "B",
  assertSurface: (container) => {
    expect(screen.getByRole("dialog", { name: "开启工作区" }))
      .toBeInTheDocument();
    expect(container.querySelector(".workspace-setup-dialog .setup-card"))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "项目目录" }))
      .toHaveValue("E:\\workspaces\\piweb");
  },
}, {
  surface: "role-selection",
  group: "B",
  assertSurface: (container) => {
    expect(container.querySelector("main.role-selection-page"))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "选择这个会话的角色" }))
      .toBeInTheDocument();
    const unavailable = screen.getByRole("article", {
      name: "角色 Legacy Explorer",
    });
    expect(within(unavailable).getByRole("button", {
      name: "使用 Legacy Explorer 开始会话",
    })).toBeDisabled();
  },
}, {
  surface: "empty",
  group: "B",
  assertSurface: (container) => {
    expect(container.querySelector("main.workspace-placeholder"))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "还没有打开工作区" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开启工作区" }))
      .toBeInTheDocument();
  },
}, {
  surface: "opening",
  group: "B",
  assertSurface: (container) => {
    expect(screen.getByRole("heading", { name: "正在打开工作区" }))
      .toBeInTheDocument();
    expect(container.querySelector(".workspace-opening-spinner"))
      .toBeInTheDocument();
  },
}, {
  surface: "unavailable",
  group: "B",
  assertSurface: (container) => {
    expect(screen.getByRole("heading", { name: "工作区不可用" }))
      .toBeInTheDocument();
    expect(container.querySelector(".workspace-placeholder-mark.warning"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试打开工作区" }))
      .toBeInTheDocument();
  },
}, {
  surface: "error-boundary",
  group: "B",
  assertSurface: (container) => {
    expect(screen.getByRole("alert")).toHaveTextContent("页面出错了");
    expect(screen.getByRole("alert"))
      .toHaveTextContent("Secondary surface fixture render failure");
    expect(container.querySelector(".setup-card[role='alert']"))
      .toBeInTheDocument();
  },
}];

describe("SecondarySurfaceFixture", () => {
  it.each(scenes)(
    "renders the $surface production surface with stable fixture markers",
    ({ surface, group, assertSurface }) => {
      const errorSpy = surface === "error-boundary"
        ? vi.spyOn(console, "error").mockImplementation(() => undefined)
        : undefined;
      const { container } = renderSurface(surface);

      const root = container.querySelector(
        '[data-visual-fixture="secondary-surfaces"]',
      );
      expect(root).toHaveAttribute("data-visual-group", group);
      expect(root).toHaveAttribute("data-visual-surface", surface);
      assertSurface(container);
      expect(piSocketConstructor).not.toHaveBeenCalled();
      errorSpy?.mockRestore();
    },
  );

  it("keeps the real drawer nested-dialog focus and Escape lifecycle", () => {
    renderSurface("drawer");

    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));

    const keyDialog = screen.getByRole("dialog", { name: "OpenAI API Key" });
    expect(keyDialog).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "OpenAI API Key" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "模型连接" }))
      .toBeInTheDocument();
  });

  it.each([
    ["drawer", ".drawer"],
    ["role-manager", ".role-manager-dialog"],
    ["role-switch", ".conversation-role-dialog"],
    ["directory", ".directory-browser-modal"],
    ["auth", '[role="dialog"][aria-label="登录订阅账户"]'],
    ["extension", ".extension-modal"],
  ] as const)(
    "unmounts the real %s surface on Escape and restores prior focus",
    (surface, selector) => {
      const launcher = document.createElement("button");
      document.body.append(launcher);
      launcher.focus();

      const { container } = renderSurface(surface);
      expect(container.querySelector(selector)).toBeInTheDocument();
      expect(launcher).not.toHaveFocus();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(container.querySelector(selector)).not.toBeInTheDocument();
      expect(launcher).toHaveFocus();
      launcher.remove();
    },
  );

  it("keeps the real Setup controlled input and modal Escape lifecycle", () => {
    const { container } = renderSurface("setup");
    const input = screen.getByRole("textbox", { name: "项目目录" });

    fireEvent.change(input, { target: { value: "E:\\workspaces\\fixture-next" } });
    expect(input).toHaveValue("E:\\workspaces\\fixture-next");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "开启工作区" }))
      .not.toBeInTheDocument();
    expect(container.querySelector(
      '[data-visual-fixture="populated-workbench"]',
    )).toBeInTheDocument();
  });

  it("dismisses only the fixture-projected production error toast", () => {
    const { container } = renderSurface("feedback");

    fireEvent.click(screen.getByRole("button", { name: "关闭错误" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector(".notice-toast.warning"))
      .toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();
  });

  it.each([
    [undefined, "", "(missing surface)"],
    ["unknown", "unknown", "unknown"],
  ] as const)(
    "renders a marked fixture error for unsupported surface %s",
    (surface, attribute, message) => {
      const { container } = renderSurface(surface);
      const root = container.querySelector(
        '[data-visual-fixture="secondary-surfaces"]',
      );

      expect(root).not.toHaveAttribute("data-visual-group");
      expect(root).toHaveAttribute("data-visual-surface", attribute);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "未知的次级界面样本",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(piSocketConstructor).not.toHaveBeenCalled();
    },
  );
});
