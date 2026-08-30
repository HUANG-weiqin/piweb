// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../shared/protocol";
import { ConversationSidebar } from "./ConversationSidebar";

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
    defaultServiceTier: null,
    toolMode: "read_only",
    canManageSessions: true,
  },
  activity: { kind: "idle" },
};

function conversation(
  id: string,
  name: string,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    ...baseConversation,
    id,
    name,
    preview: name,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationSidebar", () => {
  it("bails out of unrelated parent renders and still updates changed facts", () => {
    const trackedConversations = [baseConversation];
    const findConversations = vi.spyOn(trackedConversations, "find");

    function Harness() {
      const [, setUnrelated] = useState(0);
      const [conversations, setConversations] = useState<ConversationSummary[]>(
        trackedConversations,
      );
      const [selectedId, setSelectedId] = useState<string>();
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
          navigationEnabled
          actionsEnabled
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

    fireEvent.click(screen.getByRole("button", { name: "unrelated" }));
    expect(findConversations).toHaveBeenCalledTimes(initialFinds);

    fireEvent.click(screen.getByRole("button", { name: "打开会话 接口设计" }));
    expect(screen.getByRole("button", { name: "当前会话 接口设计" }))
      .toHaveAttribute("aria-current", "page");

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

  it("gives primary conversations and nested Agents distinct visual roles", () => {
    const root = conversation("root-visual", "发布主任务");
    const member = conversation("member-visual", "检查回归 Agent", {
      rootConversationId: root.id,
      createdBy: { kind: "conversation", conversationId: root.id },
    });
    const standalone = conversation("standalone-visual", "独立主会话");

    render(
      <ConversationSidebar
        conversations={[root, member, standalone]}
        currentConversationId={member.id}
        focusedConversationId={member.id}
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

    const rootRow = screen.getByRole("button", { name: "打开会话 发布主任务" })
      .closest<HTMLElement>("[data-conversation-id]");
    const memberRow = screen.getByRole("button", {
      name: "当前会话 检查回归 Agent",
    }).closest<HTMLElement>("[data-conversation-id]");
    const standaloneRow = screen.getByRole("button", {
      name: "打开会话 独立主会话",
    }).closest<HTMLElement>("[data-conversation-id]");

    expect(rootRow).toHaveClass("hierarchy-root");
    expect(memberRow).toHaveClass("hierarchy-member");
    expect(standaloneRow).toHaveClass("hierarchy-standalone");
    expect(within(rootRow!).getByText("主任务")).toBeInTheDocument();
    expect(within(standaloneRow!).getByText("主会话")).toBeInTheDocument();
    expect(screen.getByText("协作 Agent")).toBeInTheDocument();
  });

  it("orders standalone conversations with the grouped-view priority", () => {
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
      expect.stringContaining("需要处理"),
      expect.stringContaining("正在运行"),
      expect.stringContaining("接口设计"),
    ]);
  });

  it("keeps standalone positions stable when selection changes", () => {
    const recent = conversation("recent-standalone", "最近会话", {
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    const older = conversation("older-standalone", "较早会话", {
      updatedAt: "2026-07-19T08:00:00.000Z",
    });

    function Harness() {
      const [selectedId, setSelectedId] = useState(recent.id);
      return <ConversationSidebar
        conversations={[older, recent]}
        currentConversationId={selectedId}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={setSelectedId}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />;
    }

    const { container } = render(<Harness />);
    const rowOrder = () => Array.from(
      container.querySelectorAll<HTMLElement>(".hierarchy-standalone"),
      (row) => row.dataset.conversationId,
    );
    expect(rowOrder()).toEqual([recent.id, older.id]);

    fireEvent.click(screen.getByRole("button", { name: "打开会话 较早会话" }));

    expect(screen.getByRole("button", { name: "当前会话 较早会话" }))
      .toHaveAttribute("aria-current", "page");
    expect(rowOrder()).toEqual([recent.id, older.id]);
  });

  it("keeps collaboration member positions stable when selection changes", () => {
    const root = conversation("stable-root", "稳定任务");
    const recent = conversation("recent-member", "最近 Agent", {
      rootConversationId: root.id,
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    const older = conversation("older-member", "较早 Agent", {
      rootConversationId: root.id,
      updatedAt: "2026-07-19T08:00:00.000Z",
    });

    function Harness() {
      const [selectedId, setSelectedId] = useState(recent.id);
      return <ConversationSidebar
        conversations={[root, older, recent]}
        currentConversationId={selectedId}
        focusedConversationId={root.id}
        collapsed={false}
        truncated={false}
        navigationEnabled
        actionsEnabled
        onToggleCollapsed={vi.fn()}
        onSelect={setSelectedId}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn(() => true)}
      />;
    }

    const { container } = render(<Harness />);
    const memberOrder = () => Array.from(
      container.querySelectorAll<HTMLElement>(".hierarchy-member"),
      (row) => row.dataset.conversationId,
    );
    expect(memberOrder()).toEqual([recent.id, older.id]);

    fireEvent.click(screen.getByRole("button", { name: "打开会话 较早 Agent" }));

    expect(screen.getByRole("button", { name: "当前会话 较早 Agent" }))
      .toHaveAttribute("aria-current", "page");
    expect(memberOrder()).toEqual([recent.id, older.id]);
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
      expect(status.closest("[data-conversation-id]"))
        .toHaveClass(`activity-${kind}`);
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

    expect(screen.getByRole("button", { name: "删除会话 接口设计" }))
      .toBeEnabled();
    expect(screen.getByRole("button", { name: "删除会话 正在运行" }))
      .toBeDisabled();

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

  it("groups two roots, orders aggregate state, and navigates root and child", () => {
    const onSelect = vi.fn();
    const rootA = conversation("root-a", "任务 A");
    const rootB = conversation("root-b", "任务 B", {
      updatedAt: "2026-07-19T12:00:00.000Z",
    });
    const childA = conversation("child-a", "A 当前 Agent", {
      rootConversationId: rootA.id,
      createdBy: { kind: "conversation", conversationId: rootA.id },
      attention: true,
      activity: { kind: "running", runId: "run-a" },
    });
    const waitingA = conversation("waiting-a", "A 等待 Agent", {
      rootConversationId: rootA.id,
      createdBy: { kind: "conversation", conversationId: rootA.id },
      unread: true,
      activity: { kind: "waiting", runId: "run-w", targetCount: 2 },
    });
    const childB = conversation("child-b", "B Agent", {
      rootConversationId: rootB.id,
      createdBy: { kind: "conversation", conversationId: rootB.id },
      attention: true,
    });
    const rootC = conversation("root-c", "任务 C", {
      updatedAt: "2026-07-19T13:00:00.000Z",
    });
    const childC = conversation("child-c", "C 运行 Agent", {
      rootConversationId: rootC.id,
      createdBy: { kind: "conversation", conversationId: rootC.id },
      activity: { kind: "running", runId: "run-c" },
    });
    const orphan = conversation("orphan", "缺根会话", {
      rootConversationId: "missing-root",
    });

    render(
      <ConversationSidebar
        conversations={[
          rootB,
          childB,
          rootC,
          childC,
          orphan,
          rootA,
          waitingA,
          childA,
        ]}
        currentConversationId={childA.id}
        focusedConversationId={childA.id}
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

    const cards = screen.getAllByRole("listitem").filter((item) =>
      item.hasAttribute("data-root-conversation-id")
    );
    expect(cards).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "按任务" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "全部" }))
      .not.toBeInTheDocument();
    expect(cards.map((card) => card.getAttribute("data-root-conversation-id")))
      .toEqual([rootA.id, rootB.id, rootC.id]);
    const taskADisclosure = within(cards[0]!).getByRole("button", {
      name: "收起协作组 任务 A",
    });
    expect(taskADisclosure).toHaveClass("conversation-group-disclosure");
    expect(taskADisclosure).toHaveAccessibleDescription(
      /2 个 Agent · 1 运行 · 1 等待 · 1 需处理 · 1 未读 · 最近 /,
    );
    expect(taskADisclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("缺根会话")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开会话 任务 A" }));
    fireEvent.click(screen.getByRole("button", { name: "当前会话 A 当前 Agent" }));
    expect(onSelect.mock.calls.map(([id]) => id)).toEqual([rootA.id, childA.id]);
  });

  it("keeps a manual collapse through background members and reveals idle agents", () => {
    const root = conversation("root-idle", "空闲任务");
    const members = Array.from({ length: 5 }, (_, index) => conversation(
      `idle-${index}`,
      `空闲 Agent ${index}`,
      {
        rootConversationId: root.id,
        createdBy: { kind: "conversation", conversationId: root.id },
        updatedAt: `2026-07-19T0${index + 1}:00:00.000Z`,
      },
    ));
    const props = {
      currentConversationId: root.id,
      focusedConversationId: root.id,
      collapsed: false,
      truncated: false,
      navigationEnabled: true,
      actionsEnabled: true,
      onToggleCollapsed: vi.fn(),
      onSelect: vi.fn(),
      onCreate: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(() => true),
    };
    const { rerender } = render(
      <ConversationSidebar conversations={[root, ...members]} {...props} />,
    );

    const expand = screen.getByRole("button", { name: "收起协作组 空闲任务" });
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "展开协作组 空闲任务" }))
      .toHaveAttribute("aria-expanded", "false");

    const newcomer = conversation("idle-new", "新 Agent", {
      rootConversationId: root.id,
      createdBy: { kind: "conversation", conversationId: root.id },
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    rerender(
      <ConversationSidebar
        conversations={[root, ...members, newcomer]}
        {...props}
      />,
    );
    expect(screen.getByRole("button", { name: "展开协作组 空闲任务" }))
      .toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "展开协作组 空闲任务" }));
    expect(screen.getAllByText(/^(空闲 Agent \d|新 Agent)$/)).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", {
      name: "显示其余 3 个空闲 Agent",
    }));
    expect(screen.getAllByText(/^(空闲 Agent \d|新 Agent)$/)).toHaveLength(6);
  });

  it("expands only confirmed focus changes and resets group state per workspace", () => {
    const rootA = conversation("root-focus-a", "任务 A");
    const childA = conversation("child-focus-a", "A Agent", {
      rootConversationId: rootA.id,
      createdBy: { kind: "conversation", conversationId: rootA.id },
    });
    const rootB = conversation("root-focus-b", "任务 B");
    const childB = conversation("child-focus-b", "B Agent", {
      rootConversationId: rootB.id,
      createdBy: { kind: "conversation", conversationId: rootB.id },
    });
    const common = {
      conversations: [rootA, childA, rootB, childB],
      collapsed: false,
      truncated: false,
      navigationEnabled: true,
      actionsEnabled: true,
      onToggleCollapsed: vi.fn(),
      onSelect: vi.fn(),
      onCreate: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(() => true),
    };
    const { rerender } = render(
      <ConversationSidebar
        {...common}
        scopeKey="workspace-a:project"
        currentConversationId={childA.id}
        focusedConversationId={childA.id}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "收起协作组 任务 A" }));
    rerender(
      <ConversationSidebar
        {...common}
        scopeKey="workspace-a:project"
        currentConversationId={childB.id}
        focusedConversationId={childA.id}
      />,
    );
    expect(screen.getByRole("button", { name: "展开协作组 任务 A" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "展开协作组 任务 B" }))
      .toHaveAttribute("aria-expanded", "false");

    rerender(
      <ConversationSidebar
        {...common}
        scopeKey="workspace-a:project"
        currentConversationId={childA.id}
        focusedConversationId={childA.id}
      />,
    );
    expect(screen.getByRole("button", { name: "展开协作组 任务 A" }))
      .toHaveAttribute("aria-expanded", "false");

    rerender(
      <ConversationSidebar
        {...common}
        scopeKey="workspace-a:project"
        currentConversationId={childB.id}
        focusedConversationId={childB.id}
      />,
    );
    expect(screen.getByRole("button", { name: "收起协作组 任务 B" }))
      .toHaveAttribute("aria-expanded", "true");

    rerender(
      <ConversationSidebar
        {...common}
        scopeKey="workspace-b:project"
        currentConversationId={childA.id}
        focusedConversationId={childA.id}
      />,
    );
    expect(screen.getByRole("button", { name: "收起协作组 任务 A" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("gates group controls and exposes the original row actions directly", () => {
    const root = conversation("root-gate", "受控任务");
    const child = conversation("child-gate", "受控 Agent", {
      rootConversationId: root.id,
      createdBy: { kind: "conversation", conversationId: root.id },
    });
    const common = {
      conversations: [root, child],
      currentConversationId: root.id,
      focusedConversationId: root.id,
      collapsed: false,
      truncated: false,
      onToggleCollapsed: vi.fn(),
      onSelect: vi.fn(),
      onCreate: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(() => true),
    };
    const { rerender } = render(
      <ConversationSidebar
        {...common}
        navigationEnabled
        actionsEnabled={false}
      />,
    );

    expect(screen.getByRole("button", { name: "收起协作组 受控任务" }))
      .toBeEnabled();
    expect(screen.getByRole("button", { name: "重命名会话 受控任务" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "删除会话 受控任务" }))
      .toBeDisabled();
    expect(screen.queryByRole("button", { name: /会话操作/ }))
      .not.toBeInTheDocument();

    rerender(
      <ConversationSidebar
        {...common}
        navigationEnabled
        actionsEnabled
        pendingDeletionId={child.id}
      />,
    );
    expect(screen.getByRole("button", { name: /协作组 受控任务/ }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "重命名会话 受控任务" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "删除会话 受控任务" }))
      .toBeDisabled();

    rerender(
      <ConversationSidebar {...common} navigationEnabled actionsEnabled />,
    );
    expect(screen.getByRole("button", { name: "重命名会话 受控任务" }))
      .toBeEnabled();
    expect(screen.getByRole("button", { name: "删除会话 受控任务" }))
      .toBeEnabled();
  });

  it("renders a waiting group root with the original row status and actions", () => {
    const root = conversation("root-waiting", "等待任务", {
      activity: { kind: "waiting", runId: "run-root", targetCount: 1 },
    });
    const child = conversation("child-waiting", "被等待 Agent", {
      rootConversationId: root.id,
      createdBy: { kind: "conversation", conversationId: root.id },
    });

    render(
      <ConversationSidebar
        conversations={[root, child]}
        currentConversationId={root.id}
        focusedConversationId={root.id}
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

    const rootButton = screen.getByRole("button", { name: "当前会话 等待任务" });
    const rootRow = rootButton.closest("li");
    expect(rootButton).toHaveClass("conversation-sidebar-conversation");
    expect(rootRow).toHaveClass("conversation-sidebar-item", "activity-waiting");
    expect(within(rootRow!).getByRole("status", { name: "等待其他会话" }))
      .toBeInTheDocument();
    expect(within(rootRow!).getByRole("button", {
      name: "重命名会话 等待任务",
    })).toBeDisabled();
    expect(within(rootRow!).getByRole("button", { name: "删除会话 等待任务" }))
      .toBeDisabled();
    expect(screen.queryByRole("button", { name: /会话操作/ }))
      .not.toBeInTheDocument();
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
    expect(screen.getByText("仅显示最近协作组和会话")).toBeInTheDocument();
  });
});
