// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PublicProvider,
  RoleTemplate,
} from "../../shared/protocol";
import {
  RoleManagerDialog,
  type RoleOperationResult,
} from "./RoleManagerDialog";

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
    model: { provider: "alpha", id: "good" },
    defaultThinkingLevel: "high",
    toolMode: "full_access",
    canManageSessions: true,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    available: true,
    ...overrides,
  };
}

const providers: PublicProvider[] = [
  {
    id: "alpha",
    name: "Alpha",
    configured: true,
    oauth: false,
    models: [
      {
        provider: "alpha",
        id: "good",
        name: "Good",
        reasoning: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
        input: ["text"],
        contextWindow: 100_000,
        available: true,
      },
      {
        provider: "alpha",
        id: "offline",
        name: "Offline",
        reasoning: false,
        thinkingLevels: ["off"],
        input: ["text"],
        contextWindow: 10_000,
        available: false,
      },
      {
        provider: "alpha",
        id: "plain",
        name: "Plain",
        reasoning: false,
        thinkingLevels: ["off"],
        input: ["text"],
        contextWindow: 10_000,
        available: true,
      },
    ],
  },
  {
    id: "beta",
    name: "Beta",
    configured: false,
    oauth: false,
    models: [{
      provider: "beta",
      id: "hidden",
      name: "Hidden",
      reasoning: false,
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 10_000,
      available: true,
    }],
  },
];

function renderManager(overrides: Partial<Parameters<typeof RoleManagerDialog>[0]> = {}) {
  const props: Parameters<typeof RoleManagerDialog>[0] = {
    open: true,
    roles: [
      role("default", "Default"),
      role("reviewer", "Reviewer"),
    ],
    providers,
    onClose: () => undefined,
    onCreate: () => undefined,
    onUpdate: () => undefined,
    onDelete: () => undefined,
    ...overrides,
  };
  return render(<RoleManagerDialog {...props} />);
}

describe("RoleManagerDialog", () => {
  it("opens the role requested by its card", () => {
    renderManager({ initialRoleId: "reviewer" });

    expect(screen.getByRole("button", { name: "编辑角色 Reviewer" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "角色名称" }))
      .toHaveValue("Reviewer");
  });

  it("lets the seeded role be edited and deleted like any other role", () => {
    const remove = vi.fn();
    renderManager({ onDelete: remove });

    const roleButtons = screen.getAllByRole("button", { name: /编辑角色/ });
    expect(roleButtons[0]).toHaveAccessibleName("编辑角色 Default");
    expect(screen.getByRole("textbox", { name: "角色名称" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "删除角色" }));
    expect(remove).toHaveBeenCalledWith("default", 1);
  });

  it("only offers configured available models while preserving the current invalid model", () => {
    renderManager({
      roles: [
        role("default", "Default"),
        role("reviewer", "Reviewer", {
          available: false,
          unavailableReason: "模型当前不可用",
          model: { provider: "alpha", id: "retired" },
        }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑角色 Reviewer" }));

    const select = screen.getByRole("combobox", { name: "角色模型" });
    expect(select).toHaveValue(JSON.stringify(["alpha", "retired"]));
    const options = within(select).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "当前不可用 · retired",
      "Good",
      "Plain",
    ]);
    expect(within(select).getByRole("group", { name: "Alpha" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Offline/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Hidden/ })).not.toBeInTheDocument();
  });

  it("submits an update without changing the durable role projection", () => {
    const update = vi.fn();
    renderManager({ onUpdate: update });

    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Edited default" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    expect(update).toHaveBeenCalledWith("default", 1, {
      name: "Edited default",
      description: "Default description",
      systemPrompt: "Default prompt",
      model: { provider: "alpha", id: "good" },
      defaultThinkingLevel: "high",
      toolMode: "full_access",
      canManageSessions: true,
    });
    expect(screen.getByRole("button", { name: "编辑角色 Default" }))
      .toBeInTheDocument();
  });

  it("preserves draft edits when availability changes without a new revision", () => {
    const view = renderManager();
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Unsaved name" },
    });

    view.rerender(<RoleManagerDialog
      open
      roles={[
        role("default", "Default", {
          available: false,
          unavailableReason: "连接刚刚失效",
        }),
      ]}
      providers={[]}
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={() => undefined}
      onDelete={() => undefined}
    />);

    expect(screen.getByRole("textbox", { name: "角色名称" }))
      .toHaveValue("Unsaved name");
    expect(screen.getByRole("combobox", { name: "角色模型" }))
      .toHaveValue(JSON.stringify(["alpha", "good"]));
  });

  it("creates and deletes roles through callbacks without optimistic list changes", () => {
    const create = vi.fn();
    const remove = vi.fn();
    renderManager({ onCreate: create, onDelete: remove });

    fireEvent.click(screen.getByRole("button", { name: "新建角色" }));
    expect(screen.getByRole("switch", { name: /允许管理会话/ }))
      .not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "工具权限" }))
      .toHaveValue("read_only");
    expect(screen.getByRole("combobox", { name: "默认思考强度" }))
      .toHaveValue("off");
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Researcher" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "角色简介" }), {
      target: { value: "Finds primary sources" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "专属提示词" }), {
      target: { value: "Use primary sources." },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "角色模型" }), {
      target: { value: JSON.stringify(["alpha", "good"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建角色" }));

    expect(create).toHaveBeenCalledWith({
      name: "Researcher",
      description: "Finds primary sources",
      systemPrompt: "Use primary sources.",
      model: { provider: "alpha", id: "good" },
      defaultThinkingLevel: "off",
      toolMode: "read_only",
      canManageSessions: false,
    });
    expect(screen.queryByRole("button", { name: "编辑角色 Researcher" }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编辑角色 Reviewer" }));
    fireEvent.click(screen.getByRole("button", { name: "删除角色" }));
    expect(remove).toHaveBeenCalledWith("reviewer", 1);
    expect(screen.getByRole("button", { name: "编辑角色 Reviewer" }))
      .toBeInTheDocument();
  });

  it("edits the role-level session management capability explicitly", () => {
    const update = vi.fn();
    renderManager({ onUpdate: update });
    const capability = screen.getByRole("switch", {
      name: /允许管理会话/,
    });
    expect(capability).toBeChecked();

    fireEvent.click(capability);
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    expect(update).toHaveBeenCalledWith(
      "default",
      1,
      expect.objectContaining({ canManageSessions: false }),
    );
  });

  it("edits tool permission as part of the role snapshot", () => {
    const update = vi.fn();
    renderManager({ onUpdate: update });

    fireEvent.change(screen.getByRole("combobox", { name: "工具权限" }), {
      target: { value: "read_only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    expect(update).toHaveBeenCalledWith(
      "default",
      1,
      expect.objectContaining({ toolMode: "read_only" }),
    );
  });

  it("limits the default thinking level to the selected model", () => {
    const update = vi.fn();
    renderManager({ onUpdate: update });

    const thinking = screen.getByRole("combobox", {
      name: "默认思考强度",
    });
    expect(within(thinking).getAllByRole("option").map((option) => (
      option.getAttribute("value")
    ))).toEqual(["off", "minimal", "low", "medium", "high"]);

    fireEvent.change(thinking, { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(update).toHaveBeenCalledWith(
      "default",
      1,
      expect.objectContaining({ defaultThinkingLevel: "medium" }),
    );
  });

  it("uses model default when the selected model has no adjustable level", () => {
    renderManager();
    fireEvent.change(screen.getByRole("combobox", { name: "角色模型" }), {
      target: { value: JSON.stringify(["alpha", "plain"]) },
    });

    const thinking = screen.getByRole("combobox", {
      name: "默认思考强度",
    });
    expect(thinking).toBeDisabled();
    expect(thinking).toHaveValue("off");
    expect(within(thinking).getByRole("option")).toHaveTextContent("模型默认");
    expect(screen.getByText("此模型没有可调思考强度，将使用模型默认行为。"))
      .toBeInTheDocument();
  });

  it("only renders a result matching the exact pending command", () => {
    const pending = {
      operation: "update_role" as const,
      commandId: "command-1",
    };
    const mismatch: RoleOperationResult = {
      operation: "update_role",
      commandId: "command-2",
      ok: false,
      message: "stale failure",
    };
    const view = renderManager({ pending, result: mismatch });

    expect(screen.queryByText("stale failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();

    view.rerender(<RoleManagerDialog
      open
      roles={[role("default", "Default")]}
      providers={providers}
      pending={pending}
      result={{
        operation: "update_role",
        commandId: "command-1",
        ok: false,
        message: "save failed",
      }}
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={() => undefined}
      onDelete={() => undefined}
    />);
    expect(screen.getByRole("alert")).toHaveTextContent("save failed");
  });
});
