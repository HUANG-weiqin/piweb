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
    canManageSessions: true,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    available: true,
    ...overrides,
  };
}

const projectControlProps = {
  toolMode: "full_access" as const,
  toolModeBusy: false,
  onToolMode: () => undefined,
};

describe("RoleSelectionPage", () => {
  it("puts the default role first without selecting it", () => {
    const start = vi.fn();
    render(<RoleSelectionPage
      {...projectControlProps}
      roles={[
        role("reviewer", "Reviewer"),
        role("default", "Default"),
      ]}
      onStart={start}
    />);

    const cards = screen.getAllByRole("button", { name: /选择角色/ });
    expect(cards[0]).toHaveAccessibleName("选择角色 Default");
    expect(cards[0]).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "开始新会话" })).toBeDisabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(cards[0]!);
    fireEvent.click(screen.getByRole("button", { name: "开始新会话" }));
    expect(start).toHaveBeenCalledWith("default");
  });

  it("disables unavailable roles and explains why", () => {
    render(<RoleSelectionPage
      {...projectControlProps}
      roles={[
        role("offline", "Offline specialist", {
          available: false,
          unavailableReason: "模型当前不可用",
          model: { provider: "acme", id: "retired-model" },
        }),
      ]}
      onStart={() => undefined}
    />);

    const card = screen.getByRole("button", {
      name: "选择角色 Offline specialist",
    });
    expect(card).toBeDisabled();
    expect(card).toHaveClass("unavailable");
    expect(within(card).getByText("acme / retired-model")).toBeInTheDocument();
    expect(within(card).getByText("模型当前不可用")).toBeInTheDocument();
  });

  it("locks role selection while creation is pending", () => {
    const view = render(<RoleSelectionPage
      {...projectControlProps}
      roles={[role("default", "Default")]}
      onStart={() => undefined}
    />);
    fireEvent.click(screen.getByRole("button", { name: "选择角色 Default" }));

    view.rerender(<RoleSelectionPage
      {...projectControlProps}
      roles={[role("default", "Default")]}
      pending
      onStart={() => undefined}
    />);

    expect(screen.getByRole("button", { name: "选择角色 Default" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在创建会话…" })).toBeDisabled();
  });

  it("keeps provider settings and project switching reachable before a role exists", () => {
    const settings = vi.fn();
    const changeProject = vi.fn();
    const changeToolMode = vi.fn();
    render(<RoleSelectionPage
      {...projectControlProps}
      roles={[]}
      onStart={() => undefined}
      onSettings={settings}
      onToolMode={changeToolMode}
      onChangeProject={changeProject}
    />);

    fireEvent.click(screen.getByRole("button", { name: "模型连接" }));
    fireEvent.change(screen.getByRole("combobox", {
      name: "项目工具权限",
    }), {
      target: { value: "read_only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    expect(settings).toHaveBeenCalledOnce();
    expect(changeToolMode).toHaveBeenCalledWith("read_only");
    expect(changeProject).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
  });
});
