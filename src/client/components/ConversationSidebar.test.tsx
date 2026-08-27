// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../shared/protocol";
import { ConversationSidebar } from "./ConversationSidebar";

const dateTimeFormatDescriptor = Object.getOwnPropertyDescriptor(
  Intl.DateTimeFormat.prototype,
  "format",
)!;

const baseConversation: ConversationSummary = {
  id: "01234567-89ab-cdef-0123-456789abcdef",
  name: "接口设计",
  preview: "整理服务端边界",
  createdAt: "2026-07-19T08:00:00.000Z",
  updatedAt: "2026-07-19T09:00:00.000Z",
  messageCount: 4,
  role: {
    id: "architect",
    revision: 1,
    name: "架构师",
    description: "负责系统设计",
    model: { provider: "openai", id: "gpt-5" },
    defaultThinkingLevel: "off",
    toolMode: "read_only",
    canManageSessions: true,
  },
  activity: { kind: "idle" },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(
    Intl.DateTimeFormat.prototype,
    "format",
    dateTimeFormatDescriptor,
  );
});

describe("ConversationSidebar", () => {
  it("bails out of unrelated parent renders and still updates changed facts", () => {
    const getFormat = dateTimeFormatDescriptor.get as (
      this: Intl.DateTimeFormat
    ) => Intl.DateTimeFormat["format"];
    const formatDates = vi.fn(function formatDates(this: Intl.DateTimeFormat) {
      return getFormat.call(this);
    });
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
      ...dateTimeFormatDescriptor,
      get: formatDates,
    });
    const trackedConversation = { ...baseConversation };
    const readName = vi.fn(() => baseConversation.name);
    const readUpdatedAt = vi.fn(() => baseConversation.updatedAt);
    Object.defineProperties(trackedConversation, {
      name: { enumerable: true, get: readName },
      updatedAt: { enumerable: true, get: readUpdatedAt },
    });
    const trackedConversations = [trackedConversation];
    const findConversations = vi.spyOn(trackedConversations, "find");
    const orderConversations = vi.spyOn(trackedConversations, "map");

    function Harness() {
      const [, setUnrelated] = useState(0);
      const [conversations, setConversations] = useState<ConversationSummary[]>(
        trackedConversations,
      );
      const [selectedId, setSelectedId] = useState<string>();
      const [online, setOnline] = useState(true);
      const onSelect = useCallback((conversationId: string) => {
        setSelectedId(conversationId);
      }, []);
      const onToggleCollapsed = useCallback(() => undefined, []);
      const onCreate = useCallback(() => undefined, []);
      const onRename = useCallback(() => undefined, []);
      const onDelete = useCallback(() => true, []);
      return <>
        <button type="button" onClick={() => setUnrelated((value) => value + 1)}>
          unrelated
        </button>
        <button type="button" onClick={() => setOnline((value) => !value)}>
          online
        </button>
        <button type="button" onClick={() => setConversations([
          {
            ...baseConversation,
            id: "older-12345678",
            name: "较早会话",
            updatedAt: "2026-07-19T07:00:00.000Z",
          },
          {
            ...baseConversation,
            id: "running-12345678",
            name: "事实已更新",
            activity: { kind: "running", runId: "run-1" },
          },
        ])}>
          update facts
        </button>
        <ConversationSidebar
          conversations={conversations}
          truncated={false}
          currentConversationId={selectedId}
          collapsed={false}
          navigationEnabled={online}
          actionsEnabled={online}
          onToggleCollapsed={onToggleCollapsed}
          onSelect={onSelect}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
        />
      </>;
    }

    render(<Harness />);
    const initialFinds = findConversations.mock.calls.length;
    const initialOrderings = orderConversations.mock.calls.length;
    const initialNameReads = readName.mock.calls.length;
    const initialTimeReads = readUpdatedAt.mock.calls.length;
    const initialFormats = formatDates.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "unrelated" }));
    expect(findConversations).toHaveBeenCalledTimes(initialFinds);
    expect(orderConversations).toHaveBeenCalledTimes(initialOrderings);
    expect(readName).toHaveBeenCalledTimes(initialNameReads);
    expect(readUpdatedAt).toHaveBeenCalledTimes(initialTimeReads);
    expect(formatDates).toHaveBeenCalledTimes(initialFormats);

    fireEvent.click(screen.getByRole("button", { name: "打开会话 接口设计" }));
    expect(screen.getByRole("button", { name: "当前会话 接口设计" }))
      .toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "online" }));
    expect(screen.getByRole("button", { name: "当前会话 接口设计" }))
      .toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "update facts" }));
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("事实已更新")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("status", { name: "运行中" }))
      .toBeInTheDocument();
  });

  it("renders one flat list with title, role, short handle and last active time", () => {
    render(
      <ConversationSidebar
        conversations={[
          baseConversation,
          {
            ...baseConversation,
            id: "fedcba98-7654-3210-fedc-ba9876543210",
            name: undefined,
            preview: "测试恢复流程",
            role: undefined,
          },
        ]}
        currentConversationId={baseConversation.id}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "项目会话" });
    expect(within(navigation).getAllByRole("list")).toHaveLength(1);
    expect(within(navigation).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("接口设计")).toBeInTheDocument();
    expect(screen.getByText("测试恢复流程")).toBeInTheDocument();
    expect(screen.getByText("架构师")).toBeInTheDocument();
    expect(screen.getByText("角色加载中")).toBeInTheDocument();
    expect(screen.getByText("#01234567")).toBeInTheDocument();
    expect(screen.getByText("#fedcba98")).toBeInTheDocument();
    expect(screen.getAllByText("最后活跃", { exact: false })).toHaveLength(2);
  });

  it("clips an automatic title to 24 characters", () => {
    render(
      <ConversationSidebar
        conversations={[{
          ...baseConversation,
          name: undefined,
          preview: "会".repeat(30),
        }]}
        currentConversationId={baseConversation.id}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    expect(screen.getByText(`${"会".repeat(23)}…`)).toBeInTheDocument();
  });

  it("marks only conversations created by an Agent", () => {
    render(
      <ConversationSidebar
        conversations={[
          {
            ...baseConversation,
            createdBy: { kind: "user" },
          },
          {
            ...baseConversation,
            id: "agent-created-12345678",
            name: "Agent 调研",
            createdBy: {
              kind: "conversation",
              conversationId: baseConversation.id,
            },
          },
        ]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    const badge = screen.getByTitle("由 Agent 创建");
    expect(badge).toHaveTextContent("Agent");
    expect(screen.getAllByText("Agent")).toHaveLength(1);
    expect(badge.closest("[data-conversation-id]"))
      .toHaveAttribute("data-conversation-id", "agent-created-12345678");
  });

  it("orders active work before attention and the remaining flat conversations", () => {
    const attention = {
      ...baseConversation,
      id: "attention-123456",
      name: "需要处理",
      attention: true,
      updatedAt: "2026-07-19T07:00:00.000Z",
    };
    const running = {
      ...baseConversation,
      id: "running-12345678",
      name: "正在运行",
      activity: { kind: "running", runId: "run-1" } as const,
      updatedAt: "2026-07-19T10:00:00.000Z",
    };

    render(
      <ConversationSidebar
        conversations={[baseConversation, running, attention]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("button", {
      name: /(?:打开|当前)会话/,
    }).textContent)).toEqual([
      expect.stringContaining("正在运行"),
      expect.stringContaining("需要处理"),
      expect.stringContaining("接口设计"),
    ]);
    expect(rows.every((row) => within(row).queryByRole("list") === null)).toBe(true);
  });

  it.each(["queued", "running"] as const)(
    "uses a semantic spinner for %s conversations",
    (kind) => {
      render(
        <ConversationSidebar
          conversations={[{
            ...baseConversation,
            activity: { kind, runId: "run-1" },
          }]}
          collapsed={false}
          truncated={false}
          navigationEnabled
        actionsEnabled
          onToggleCollapsed={vi.fn()}
          onSelect={vi.fn()}
          onCreate={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn(() => true)}
        />,
      );

      const status = screen.getByRole("status", {
        name: kind === "queued" ? "排队中" : "运行中",
      });
      expect(status).toHaveClass(`activity-${kind}`);
      expect(status.querySelector(".conversation-activity-spinner"))
        .toBeInTheDocument();
    },
  );

  it("shows an hourglass only for explicit waiting and highlights attention", () => {
    render(
      <ConversationSidebar
        conversations={[{
          ...baseConversation,
          attention: true,
          activity: {
            kind: "waiting",
            runId: "run-1",
            targetConversationId: "target",
            targetRunId: "run-2",
          },
        }]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    expect(screen.getByRole("status", { name: "等待其他会话" })).toHaveTextContent("⌛");
    expect(screen.queryByRole("status", { name: /排队中|运行中/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "需要处理" })).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveClass("needs-attention");
  });

  it("keeps running conversations navigable and never selects on a background update", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <ConversationSidebar
        conversations={[{
          ...baseConversation,
          activity: { kind: "running", runId: "run-1" },
        }]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /打开会话 接口设计/ }));
    expect(onSelect).toHaveBeenCalledWith(baseConversation.id);

    onSelect.mockClear();
    rerender(
      <ConversationSidebar
        conversations={[{
          ...baseConversation,
          activity: { kind: "idle" },
          updatedAt: "2026-07-19T11:00:00.000Z",
        }]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("is controlled when collapsed and keeps an explicit create action at the bottom", () => {
    const onToggleCollapsed = vi.fn();
    const onCreate = vi.fn();
    const { rerender } = render(
      <ConversationSidebar
        conversations={[baseConversation]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={onToggleCollapsed}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(onToggleCollapsed).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(onCreate).toHaveBeenCalledTimes(1);

    rerender(
      <ConversationSidebar
        conversations={[baseConversation]}
        collapsed
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={onToggleCollapsed}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );
    expect(screen.getByRole("complementary", { name: "项目会话栏" })).toHaveClass("collapsed");
    expect(screen.queryByRole("navigation", { name: "项目会话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(onToggleCollapsed).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "新建会话" })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "调整会话栏宽度" }))
      .not.toBeInTheDocument();
  });

  it("keeps navigation available while lifecycle actions are locked and disables all controls offline", () => {
    const onSelect = vi.fn();
    const onToggleCollapsed = vi.fn();
    const { rerender } = render(
      <ConversationSidebar
        conversations={[baseConversation]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled={false}
        onToggleCollapsed={onToggleCollapsed}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    const conversationButton = screen.getByRole("button", {
      name: "打开会话 接口设计",
    });
    const collapseButton = screen.getByRole("button", { name: "收起会话栏" });
    expect(conversationButton).toBeEnabled();
    expect(collapseButton).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重命名会话 接口设计" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "删除会话 接口设计" }))
      .toBeDisabled();
    fireEvent.click(conversationButton);
    fireEvent.click(collapseButton);
    expect(onSelect).toHaveBeenCalledWith(baseConversation.id);
    expect(onToggleCollapsed).toHaveBeenCalledWith(true);

    rerender(
      <ConversationSidebar
        conversations={[baseConversation]}
        collapsed={false}
        truncated={false}
        navigationEnabled={false}
        actionsEnabled={false}
        onToggleCollapsed={onToggleCollapsed}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );
    expect(screen.getByRole("button", { name: "打开会话 接口设计" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "收起会话栏" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    expect(screen.getByRole("separator", { name: "调整会话栏宽度" }))
      .toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("separator", { name: "调整会话栏宽度" }))
      .toHaveAttribute("tabindex", "-1");
  });

  it("resizes the expanded sidebar within fixed pointer and keyboard bounds", () => {
    render(
      <ConversationSidebar
        conversations={[baseConversation]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    const sidebar = screen.getByRole("complementary", { name: "项目会话栏" });
    const handle = screen.getByRole("separator", { name: "调整会话栏宽度" });
    expect(handle).toHaveAttribute("aria-valuemin", "240");
    expect(handle).toHaveAttribute("aria-valuemax", "640");
    expect(handle).toHaveAttribute("aria-valuenow", "286");
    expect(sidebar.style.getPropertyValue("--conversation-sidebar-width"))
      .toBe("286px");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "302");
    expect(sidebar.style.getPropertyValue("--conversation-sidebar-width"))
      .toBe("302px");

    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "640");
    fireEvent.pointerDown(handle, { button: 0, clientX: 640, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle).toHaveAttribute("aria-valuenow", "640");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "240");
    expect(sidebar.style.getPropertyValue("--conversation-sidebar-width"))
      .toBe("240px");
  });

  it("confirms deletion for the current idle conversation and blocks active deletion", () => {
    const onDelete = vi.fn(() => true);
    render(
      <ConversationSidebar
        conversations={[
          baseConversation,
          {
            ...baseConversation,
            id: "running-12345678",
            name: "正在运行",
            activity: { kind: "running", runId: "run-1" },
          },
        ]}
        currentConversationId={baseConversation.id}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByRole("button", { name: "删除会话 接口设计" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "删除会话 正在运行" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "删除会话 接口设计" }));
    expect(onDelete).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", { name: "确认删除会话" });
    expect(dialog).toHaveTextContent("派生的空闲子孙会话");
    expect(dialog).toHaveTextContent("此操作无法撤销");
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除会话 接口设计" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(onDelete).toHaveBeenCalledWith(baseConversation.id);
  });

  it("renames an idle conversation from its sidebar lifecycle actions", () => {
    const onRename = vi.fn();
    render(
      <ConversationSidebar
        conversations={[baseConversation]}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn(() => true)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重命名会话 接口设计" }));
    expect(screen.getByRole("dialog", { name: "重命名会话" })).toBeInTheDocument();
    const nameInput = screen.getByRole("textbox", { name: "会话名称" });
    expect(nameInput).toHaveValue("接口设计");

    fireEvent.change(nameInput, { target: { value: "😀".repeat(25) } });
    expect(nameInput).toHaveValue("😀".repeat(24));
    fireEvent.change(nameInput, { target: { value: "新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(onRename).toHaveBeenCalledWith(baseConversation.id, "新名称");
  });

  it("blocks deletion while the focused runtime is busy even before its summary refreshes", () => {
    render(
      <ConversationSidebar
        conversations={[baseConversation]}
        currentConversationId={baseConversation.id}
        busyConversationId={baseConversation.id}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    expect(screen.getByRole("button", { name: "删除会话 接口设计" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "重命名会话 接口设计" }))
      .toBeDisabled();
  });

  it("projects unread as a low-emphasis dot and owns the truncated-list hint", () => {
    render(
      <ConversationSidebar
        conversations={[{ ...baseConversation, unread: true }]}
        collapsed={false}
        truncated
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />,
    );

    const unread = screen.getByRole("status", { name: "未读消息" });
    expect(unread).toHaveClass("conversation-unread-indicator");
    expect(unread).toBeEmptyDOMElement();
    expect(screen.getByText("仅显示最近会话")).toBeInTheDocument();
  });
});
