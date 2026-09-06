// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
    compactionModel: null,
    defaultThinkingLevel: "high",
    defaultServiceTier: null,
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
        serviceTiers: ["priority"],
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

type RoleManagerBackdropFixtureProps = Pick<
  Parameters<typeof RoleManagerDialog>[0],
  "pending" | "onClose" | "onCreate" | "onUpdate" | "onDelete"
>;

function RoleManagerBackdropFixture({
  pending,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: RoleManagerBackdropFixtureProps) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开角色管理测试</button>
    <RoleManagerDialog
      open={open}
      roles={[role("default", "Default"), role("reviewer", "Reviewer")]}
      providers={providers}
      pending={pending}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />
  </>;
}

describe("RoleManagerDialog", () => {
  it("dismisses only from the exact backdrop and restores its launcher", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn();
    const onUpdate = vi.fn();
    const onDelete = vi.fn();
    render(<RoleManagerBackdropFixture
      onClose={onClose}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />);

    const launcher = screen.getByRole("button", { name: "打开角色管理测试" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "管理角色" });
    const backdrop = dialog.parentElement!;
    await waitFor(() => expect(screen.getByRole("button", {
      name: "关闭角色管理",
    })).toHaveFocus());

    const interiorMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(dialog, interiorMouseDown);
    expect(interiorMouseDown.defaultPrevented).toBe(false);
    expect(dialog).toBeInTheDocument();

    const backdropMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(backdrop, backdropMouseDown);
    expect(backdropMouseDown.defaultPrevented).toBe(true);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "管理角色" }))
        .not.toBeInTheDocument();
      expect(launcher.isConnected).toBe(true);
      expect(launcher).toHaveFocus();
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("keeps a busy role operation focused and inert on its backdrop", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn();
    const onUpdate = vi.fn();
    const onDelete = vi.fn();
    render(<RoleManagerBackdropFixture
      pending={{ operation: "delete_role", commandId: "pending-delete" }}
      onClose={onClose}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />);

    fireEvent.click(screen.getByRole("button", { name: "打开角色管理测试" }));
    const dialog = screen.getByRole("dialog", { name: "管理角色" });
    await waitFor(() => expect(dialog).toHaveFocus());
    const backdropMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(dialog.parentElement!, backdropMouseDown);

    expect(backdropMouseDown.defaultPrevented).toBe(true);
    expect(dialog).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
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

  it("allows an explicit compaction model and preserves it when the main model changes", () => {
    const create = vi.fn();
    renderManager({ onCreate: create });

    fireEvent.click(screen.getByRole("button", { name: "新建角色" }));
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Researcher" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "角色模型" }), {
      target: { value: JSON.stringify(["alpha", "good"]) },
    });
    const compactionModel = screen.getByRole("combobox", {
      name: "上下文压缩模型",
    });
    fireEvent.change(compactionModel, {
      target: { value: JSON.stringify(["alpha", "good"]) },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "角色模型" }), {
      target: { value: JSON.stringify(["alpha", "plain"]) },
    });

    expect(compactionModel).toHaveValue(JSON.stringify(["alpha", "good"]));
    fireEvent.click(screen.getByRole("button", { name: "创建角色" }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "alpha", id: "plain" },
      compactionModel: { provider: "alpha", id: "good" },
    }));
  });

  it("disables smaller compaction models and explains the first-version limit", () => {
    renderManager();

    const compactionModel = screen.getByRole("combobox", {
      name: "上下文压缩模型",
    });
    expect(within(compactionModel).getByRole("option", {
      name: /Plain.*10/,
    })).toBeDisabled();
    expect(screen.getByText(
      "默认跟随角色模型；第一版不支持小窗口压缩模型。",
    )).toBeInTheDocument();
  });

  it("preserves an incompatible saved compaction model after the main model changes", () => {
    renderManager({
      roles: [role("default", "Default", {
        model: { provider: "alpha", id: "plain" },
        compactionModel: { provider: "alpha", id: "plain" },
        defaultThinkingLevel: "off",
      })],
    });

    fireEvent.change(screen.getByRole("combobox", { name: "角色模型" }), {
      target: { value: JSON.stringify(["alpha", "good"]) },
    });

    const compactionModel = screen.getByRole("combobox", {
      name: "上下文压缩模型",
    });
    expect(compactionModel).toHaveValue(JSON.stringify(["alpha", "plain"]));
    expect(within(compactionModel).getByRole("option", {
      name: /当前不兼容.*Plain/,
    })).toBeDisabled();
    expect(screen.getByText(
      "当前压缩模型的上下文窗口小于角色模型；第一版不支持小窗口压缩模型，请明确选择其他模型或跟随角色模型。",
    )).toBeInTheDocument();
  });

  it("preserves a retired saved compaction model instead of following the main model", () => {
    renderManager({
      roles: [role("default", "Default", {
        compactionModel: { provider: "alpha", id: "retired" },
      })],
    });

    const compactionModel = screen.getByRole("combobox", {
      name: "上下文压缩模型",
    });
    expect(compactionModel).toHaveValue(JSON.stringify(["alpha", "retired"]));
    expect(within(compactionModel).getByRole("option", {
      name: "当前不可用 · retired",
    })).toBeDisabled();
  });

  it("submits an update without changing the durable role projection", () => {
    const update = vi.fn();
    renderManager({ onUpdate: update });

    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Edited default" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    expect(update).toHaveBeenCalledWith("default", 1, "Default prompt", {
      name: "Edited default",
      description: "Default description",
      systemPrompt: "Default prompt",
      model: { provider: "alpha", id: "good" },
      compactionModel: null,
      defaultThinkingLevel: "high",
      defaultServiceTier: null,
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

  it("keeps the base prompt separate from a same-revision catalog refresh", () => {
    const update = vi.fn();
    const view = renderManager({ onUpdate: update });
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Unsaved name" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "专属提示词" }), {
      target: { value: "Draft prompt" },
    });

    view.rerender(<RoleManagerDialog
      open
      roles={[role("default", "Default", { systemPrompt: "External prompt" })]}
      providers={providers}
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={update}
      onDelete={() => undefined}
    />);

    expect(screen.getByRole("textbox", { name: "角色名称" }))
      .toHaveValue("Unsaved name");
    expect(screen.getByRole("textbox", { name: "专属提示词" }))
      .toHaveValue("Draft prompt");
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(update).toHaveBeenCalledWith(
      "default",
      1,
      "Default prompt",
      expect.objectContaining({
        name: "Unsaved name",
        systemPrompt: "Draft prompt",
      }),
    );
  });

  it("keeps every dirty field and the immutable CAS base across a newer catalog revision", () => {
    const update = vi.fn();
    const remove = vi.fn();
    const baseRole = role("default", "Default", {
      description: "Base description",
      systemPrompt: "Base prompt N",
      model: { provider: "alpha", id: "plain" },
      compactionModel: { provider: "alpha", id: "plain" },
      defaultThinkingLevel: "off",
      toolMode: "read_only",
      canManageSessions: false,
    });
    const view = renderManager({
      roles: [baseRole],
      onUpdate: update,
      onDelete: remove,
    });

    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Dirty name" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "角色简介" }), {
      target: { value: "Dirty description" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "专属提示词" }), {
      target: { value: "Dirty prompt" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "上下文压缩模型" }), {
      target: { value: JSON.stringify(["alpha", "good"]) },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "角色模型" }), {
      target: { value: JSON.stringify(["alpha", "good"]) },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "默认思考强度" }), {
      target: { value: "medium" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "默认服务层级" }), {
      target: { value: "priority" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "工具权限" }), {
      target: { value: "full_access" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /允许管理会话/ }));

    view.rerender(<RoleManagerDialog
      open
      roles={[role("default", "External N+1", {
        revision: 2,
        description: "External description",
        systemPrompt: "External prompt N+1",
        model: { provider: "alpha", id: "plain" },
        compactionModel: null,
        defaultThinkingLevel: "off",
        toolMode: "read_only",
        canManageSessions: false,
      })]}
      providers={providers}
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={update}
      onDelete={remove}
    />);

    expect(screen.getByRole("textbox", { name: "角色名称" })).toHaveValue("Dirty name");
    expect(screen.getByRole("textbox", { name: "角色简介" })).toHaveValue("Dirty description");
    expect(screen.getByRole("textbox", { name: "专属提示词" })).toHaveValue("Dirty prompt");
    expect(screen.getByRole("combobox", { name: "角色模型" }))
      .toHaveValue(JSON.stringify(["alpha", "good"]));
    expect(screen.getByRole("combobox", { name: "上下文压缩模型" }))
      .toHaveValue(JSON.stringify(["alpha", "good"]));
    expect(screen.getByRole("combobox", { name: "默认思考强度" })).toHaveValue("medium");
    expect(screen.getByRole("combobox", { name: "默认服务层级" })).toHaveValue("priority");
    expect(screen.getByRole("combobox", { name: "工具权限" })).toHaveValue("full_access");
    expect(screen.getByRole("switch", { name: /允许管理会话/ })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(update).toHaveBeenCalledWith("default", 1, "Base prompt N", {
      name: "Dirty name",
      description: "Dirty description",
      systemPrompt: "Dirty prompt",
      model: { provider: "alpha", id: "good" },
      compactionModel: { provider: "alpha", id: "good" },
      defaultThinkingLevel: "medium",
      defaultServiceTier: "priority",
      toolMode: "full_access",
      canManageSessions: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "删除角色" }));
    expect(remove).toHaveBeenCalledWith("default", 1);
  });

  it("preserves a dirty open form but reloads its current role when reopened", () => {
    const update = vi.fn();
    const baseRole = role("default", "Default", {
      description: "Base description",
      systemPrompt: "Base prompt N",
      toolMode: "read_only",
      canManageSessions: false,
    });
    const nextRole = role("default", "External N+1", {
      revision: 2,
      description: "External N+1 description",
      systemPrompt: "External prompt N+1",
      toolMode: "read_only",
      canManageSessions: false,
    });
    const view = renderManager({
      roles: [baseRole],
      initialRoleId: "default",
      onUpdate: update,
    });

    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Dirty name" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "角色简介" }), {
      target: { value: "Dirty description" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "专属提示词" }), {
      target: { value: "Dirty prompt" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "工具权限" }), {
      target: { value: "full_access" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /允许管理会话/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    const pending = { operation: "update_role" as const, commandId: "stale-command" };
    view.rerender(<RoleManagerDialog
      open
      roles={[nextRole]}
      providers={providers}
      initialRoleId="default"
      pending={pending}
      result={{ ...pending, ok: false, message: "revision changed" }}
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={update}
      onDelete={() => undefined}
    />);

    expect(screen.getByRole("textbox", { name: "角色名称" })).toHaveValue("Dirty name");
    expect(screen.getByRole("textbox", { name: "角色简介" })).toHaveValue("Dirty description");
    expect(screen.getByRole("textbox", { name: "专属提示词" })).toHaveValue("Dirty prompt");
    expect(screen.getByRole("combobox", { name: "工具权限" })).toHaveValue("full_access");
    expect(screen.getByRole("switch", { name: /允许管理会话/ })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("revision changed");

    view.rerender(<RoleManagerDialog
      open={false}
      roles={[nextRole]}
      providers={providers}
      initialRoleId="default"
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={update}
      onDelete={() => undefined}
    />);
    view.rerender(<RoleManagerDialog
      open
      roles={[nextRole]}
      providers={providers}
      initialRoleId="default"
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={update}
      onDelete={() => undefined}
    />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "角色名称" })).toHaveValue("External N+1");
    expect(screen.getByRole("textbox", { name: "角色简介" }))
      .toHaveValue("External N+1 description");
    expect(screen.getByRole("textbox", { name: "专属提示词" }))
      .toHaveValue("External prompt N+1");
    expect(screen.getByRole("combobox", { name: "工具权限" })).toHaveValue("read_only");
    expect(screen.getByRole("switch", { name: /允许管理会话/ })).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(update).toHaveBeenLastCalledWith(
      "default",
      2,
      "External prompt N+1",
      expect.objectContaining({
        name: "External N+1",
        description: "External N+1 description",
        systemPrompt: "External prompt N+1",
        toolMode: "read_only",
        canManageSessions: false,
      }),
    );
  });

  it("shows an exact stale error without changing the dirty draft", () => {
    const update = vi.fn();
    const baseRole = role("default", "Default", { systemPrompt: "Base prompt N" });
    const view = renderManager({ roles: [baseRole], onUpdate: update });
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Stale dirty name" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "角色简介" }), {
      target: { value: "Stale dirty description" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "专属提示词" }), {
      target: { value: "Stale dirty prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    const pending = { operation: "update_role" as const, commandId: "stale-command" };
    view.rerender(<RoleManagerDialog
      open
      roles={[role("default", "External N+1", {
        revision: 2,
        systemPrompt: "External prompt N+1",
      })]}
      providers={providers}
      pending={pending}
      result={{ ...pending, ok: false, message: "revision changed" }}
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={update}
      onDelete={() => undefined}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("revision changed");
    expect(screen.getByRole("textbox", { name: "角色名称" })).toHaveValue("Stale dirty name");
    expect(screen.getByRole("textbox", { name: "角色简介" })).toHaveValue("Stale dirty description");
    expect(screen.getByRole("textbox", { name: "专属提示词" })).toHaveValue("Stale dirty prompt");
  });

  it("rebases an exact own success once without letting its sticky result erase later edits", () => {
    const update = vi.fn();
    const view = renderManager({
      roles: [role("default", "Default", { systemPrompt: "Base prompt N" })],
      onUpdate: update,
    });
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "  Submitted N+1  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "角色简介" }), {
      target: { value: "Submitted description" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "专属提示词" }), {
      target: { value: "Submitted prompt N+1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(update).toHaveBeenLastCalledWith(
      "default",
      1,
      "Base prompt N",
      expect.objectContaining({ name: "Submitted N+1" }),
    );

    const pending = { operation: "update_role" as const, commandId: "own-command" };
    const committedN1 = role("default", "Submitted N+1", {
      revision: 2,
      description: "Submitted description",
      systemPrompt: "Submitted prompt N+1",
    });
    view.rerender(<RoleManagerDialog
      open
      roles={[committedN1]}
      providers={providers}
      pending={pending}
      result={{ ...pending, ok: true, message: "角色已保存" }}
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={update}
      onDelete={() => undefined}
    />);
    expect(screen.getByRole("textbox", { name: "角色名称" })).toHaveValue("Submitted N+1");

    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Post-success local edit" },
    });
    view.rerender(<RoleManagerDialog
      open
      roles={[role("default", "External N+2", {
        revision: 3,
        description: "External N+2 description",
        systemPrompt: "External prompt N+2",
      })]}
      providers={providers}
      pending={pending}
      result={{ ...pending, ok: true, message: "角色已保存" }}
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={update}
      onDelete={() => undefined}
    />);
    expect(screen.getByRole("textbox", { name: "角色名称" }))
      .toHaveValue("Post-success local edit");

    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(update).toHaveBeenLastCalledWith(
      "default",
      2,
      "Submitted prompt N+1",
      expect.objectContaining({
        name: "Post-success local edit",
        description: "Submitted description",
        systemPrompt: "Submitted prompt N+1",
      }),
    );
  });

  it("falls back to the first remaining role when the edited role disappears", () => {
    const view = renderManager({ initialRoleId: "reviewer" });
    view.rerender(<RoleManagerDialog
      open
      roles={[role("default", "Default N+1", { revision: 2 })]}
      providers={providers}
      initialRoleId="reviewer"
      onClose={() => undefined}
      onCreate={() => undefined}
      onUpdate={() => undefined}
      onDelete={() => undefined}
    />);

    expect(screen.getByRole("button", { name: "编辑角色 Default N+1" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "角色名称" }))
      .toHaveValue("Default N+1");
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
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
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
      "Default prompt",
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
      "Default prompt",
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
      "Default prompt",
      expect.objectContaining({ defaultThinkingLevel: "medium" }),
    );
  });

  it("edits the role default service tier and resets it when the model changes", () => {
    const update = vi.fn();
    renderManager({
      roles: [role("default", "Default", { defaultServiceTier: "priority" })],
      onUpdate: update,
    });

    const serviceTier = screen.getByRole("combobox", {
      name: "默认服务层级",
    });
    expect(within(serviceTier).getAllByRole("option").map((option) => (
      option.textContent
    ))).toEqual(["供应商默认", "快速"]);

    fireEvent.change(screen.getByRole("combobox", { name: "角色模型" }), {
      target: { value: JSON.stringify(["alpha", "plain"]) },
    });
    expect(serviceTier).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(update).toHaveBeenCalledWith(
      "default",
      1,
      "Default prompt",
      expect.objectContaining({ defaultServiceTier: null }),
    );
  });

  it("preserves and labels an unavailable role service tier", () => {
    const update = vi.fn();
    renderManager({
      roles: [role("default", "Default", {
        defaultServiceTier: "priority",
        available: false,
      })],
      providers: [],
      onUpdate: update,
    });

    const serviceTier = screen.getByRole("combobox", {
      name: "默认服务层级",
    });
    expect(serviceTier).toHaveValue("priority");
    expect(within(serviceTier).getByRole("option", {
      name: "当前不支持 · 快速",
    })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(update).toHaveBeenCalledWith(
      "default",
      1,
      "Default prompt",
      expect.objectContaining({ defaultServiceTier: "priority" }),
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
    const close = vi.fn();
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
    const view = renderManager({ pending, result: mismatch, onClose: close });

    expect(screen.queryByText("stale failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭角色管理" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭角色管理" }));
    expect(close).not.toHaveBeenCalled();

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
