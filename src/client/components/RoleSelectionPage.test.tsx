// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleTemplate } from "../../shared/protocol";
import { RoleSelectionPage } from "./RoleSelectionPage";

afterEach(cleanup);

function role(
  id: string,
  name: string,
  overrides: Partial<RoleTemplate> = {},
): RoleTemplate {
  return {
    id,
    revision: 1,
    name,
    description: `${name} description`,
    systemPrompt: `${name} prompt`,
    model: { provider: "openai", id: "gpt-5" },
    defaultThinkingLevel: "off",
    toolMode: "read_only",
    canManageSessions: true,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    available: true,
    ...overrides,
  };
}

describe("RoleSelectionPage", () => {
  it("preserves role order and starts directly from each card", () => {
    const start = vi.fn();
    render(<RoleSelectionPage
      roles={[
        role("reviewer", "Reviewer"),
        role("default", "Default"),
      ]}
      onStart={start}
    />);

    const cards = screen.getAllByRole("article");
    expect(cards[0]).toHaveAccessibleName("角色 Reviewer");
    expect(cards[1]).toHaveAccessibleName("角色 Default");
    expect(screen.queryByRole("button", { name: "开始新会话" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理角色" }))
      .not.toBeInTheDocument();
    expect(screen.getByText(
      "角色和模型会作为会话的初始配置；会话空闲时可在角色详情中更换。",
    )).toBeInTheDocument();

    fireEvent.click(within(cards[0]!).getByRole("button", {
      name: "使用 Reviewer 开始会话",
    }));
    expect(start).toHaveBeenCalledWith("reviewer");
  });

  it("manages a role from its card and keeps the add-role card", () => {
    const manageRole = vi.fn();
    const addRole = vi.fn();
    render(<RoleSelectionPage
      roles={[
        role("default", "Default"),
        role("reviewer", "Reviewer"),
      ]}
      onStart={() => undefined}
      onManageRole={manageRole}
      onAddRole={addRole}
    />);

    fireEvent.click(screen.getByRole("button", {
      name: "管理角色 Reviewer",
    }));
    expect(manageRole).toHaveBeenCalledWith("reviewer");

    fireEvent.click(screen.getByRole("button", { name: "添加角色" }));
    expect(addRole).toHaveBeenCalledOnce();
  });

  it("disables starting an unavailable role but keeps its settings reachable", () => {
    const manageRole = vi.fn();
    render(<RoleSelectionPage
      roles={[
        role("offline", "Offline specialist", {
          available: false,
          unavailableReason: "模型当前不可用",
          model: { provider: "acme", id: "retired-model" },
        }),
      ]}
      onStart={() => undefined}
      onManageRole={manageRole}
    />);

    const card = screen.getByRole("article", {
      name: "角色 Offline specialist",
    });
    expect(card).toHaveClass("unavailable");
    expect(within(card).getByRole("button", {
      name: "使用 Offline specialist 开始会话",
    })).toBeDisabled();
    expect(within(card).getByRole("button", {
      name: "管理角色 Offline specialist",
    })).toBeEnabled();
    expect(within(card).getByText(/retired-model/)).toBeInTheDocument();
    expect(within(card).queryByText(/acme \//)).not.toBeInTheDocument();
    expect(within(card).getByText("模型当前不可用")).toBeInTheDocument();
  });

  it("locks card actions while creation is pending", () => {
    const view = render(<RoleSelectionPage
      roles={[role("default", "Default")]}
      onStart={() => undefined}
      onManageRole={() => undefined}
      onAddRole={() => undefined}
    />);

    view.rerender(<RoleSelectionPage
      roles={[role("default", "Default")]}
      pending
      onStart={() => undefined}
      onManageRole={() => undefined}
      onAddRole={() => undefined}
    />);

    expect(screen.getByRole("button", {
      name: "使用 Default 开始会话",
    })).toBeDisabled();
    expect(screen.getByRole("button", { name: "管理角色 Default" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "添加角色" })).toBeDisabled();
  });

  it("keeps only provider settings in the page header", () => {
    const settings = vi.fn();
    render(<RoleSelectionPage
      roles={[]}
      onStart={() => undefined}
      onSettings={settings}
      onAddRole={() => undefined}
    />);

    fireEvent.click(screen.getByRole("button", { name: "模型连接" }));
    expect(settings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "切换项目" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理角色" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始新会话" }))
      .not.toBeInTheDocument();
  });
});
