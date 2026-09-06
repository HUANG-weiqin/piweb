// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRoleSnapshot } from "../../shared/protocol";
import { ConversationRoleDialog } from "./ConversationRoleDialog";

afterEach(cleanup);

const role: ConversationRoleSnapshot = {
  id: "reviewer",
  revision: 7,
  name: "Reviewer",
  description: "Reviews risky changes",
  systemPrompt: "Inspect the exact diff before drawing conclusions.",
  model: {
    provider: "openai",
    id: "gpt-5",
  },
  compactionModel: null,
  defaultThinkingLevel: "off",
  defaultServiceTier: null,
  toolMode: "read_only",
  canManageSessions: true,
};
const roles = [{
  ...role,
  model: { ...role.model },
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  available: true,
}];

function ConversationRoleBackdropFixture({
  onSwitch,
}: {
  onSwitch(roleId: string): void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开会话角色</button>
    <ConversationRoleDialog
      open={open}
      role={role}
      roles={roles}
      switchDisabled={false}
      switching={false}
      onSwitch={onSwitch}
      onClose={() => setOpen(false)}
    />
  </>;
}

describe("ConversationRoleDialog", () => {
  it("dismisses only from the exact backdrop and restores its launcher", async () => {
    const onSwitch = vi.fn();
    render(<ConversationRoleBackdropFixture onSwitch={onSwitch} />);

    const launcher = screen.getByRole("button", { name: "打开会话角色" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "更换会话角色" });
    const backdrop = dialog.parentElement!;
    await waitFor(() => expect(screen.getByRole("button", {
      name: "关闭",
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
      expect(screen.queryByRole("dialog", { name: "更换会话角色" }))
        .not.toBeInTheDocument();
      expect(launcher.isConnected).toBe(true);
      expect(launcher).toHaveFocus();
    });
    expect(onSwitch).not.toHaveBeenCalled();
  });
  it("shows the current role and disables reapplying the same revision", () => {
    render(<ConversationRoleDialog
      open
      role={role}
      roles={roles}
      switchDisabled={false}
      switching={false}
      onSwitch={() => true}
      onClose={() => undefined}
    />);

    const dialog = screen.getByRole("dialog", { name: "更换会话角色" });
    expect(dialog).toHaveTextContent("当前角色：Reviewer · 修订 7");
    expect(dialog).toHaveTextContent("角色模型：openai / gpt-5");
    expect(dialog).toHaveTextContent(
      "Pi 默认压缩：跟随角色模型 · openai / gpt-5",
    );
    expect(screen.getByRole("button", { name: "应用角色" })).toBeDisabled();
  });

  it("keeps an explicit compaction model distinct when it equals the primary", () => {
    const explicitRole: ConversationRoleSnapshot = {
      ...role,
      compactionModel: { ...role.model },
    };
    render(<ConversationRoleDialog
      open
      role={explicitRole}
      roles={roles}
      switchDisabled={false}
      switching={false}
      onSwitch={() => true}
      onClose={() => undefined}
    />);

    const dialog = screen.getByRole("dialog", { name: "更换会话角色" });
    expect(dialog).toHaveTextContent("角色模型：openai / gpt-5");
    expect(dialog).toHaveTextContent(
      "Pi 默认压缩：专用配置 · openai / gpt-5（与角色模型相同）",
    );
    expect(dialog).not.toHaveTextContent("Pi 默认压缩：跟随角色模型");
  });

  it("applies another available role only while switching is enabled", () => {
    const onSwitch = vi.fn(() => true);
    const alternative = {
      ...roles[0]!,
      id: "21f01ca1-e28e-4f5e-bb46-442a2fdadafd",
      revision: 1,
      name: "Builder",
    };
    render(<ConversationRoleDialog
      open
      role={role}
      roles={[...roles, alternative]}
      switchDisabled={false}
      switching={false}
      onSwitch={onSwitch}
      onClose={() => undefined}
    />);

    fireEvent.change(screen.getByRole("combobox", {
      name: "选择新的会话角色",
    }), {
      target: { value: alternative.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用角色" }));

    expect(onSwitch).toHaveBeenCalledWith(alternative.id);
  });

  it("closes without modifying the snapshot", () => {
    const close = vi.fn();
    const view = render(<ConversationRoleDialog
      open
      role={role}
      roles={roles}
      switchDisabled={false}
      switching={false}
      onSwitch={() => true}
      onClose={close}
    />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(close).toHaveBeenCalledOnce();

    view.rerender(<ConversationRoleDialog
      open={false}
      role={role}
      roles={roles}
      switchDisabled={false}
      switching={false}
      onSwitch={() => true}
      onClose={close}
    />);
    expect(screen.queryByRole("dialog", { name: "更换会话角色" }))
      .not.toBeInTheDocument();
  });

  it("discards a canceled role draft before the dialog is usable again", () => {
    const close = vi.fn();
    const onSwitch = vi.fn();
    const alternative = {
      ...roles[0]!,
      id: "21f01ca1-e28e-4f5e-bb46-442a2fdadafd",
      revision: 1,
      name: "Builder",
    };
    const props = {
      role,
      roles: [...roles, alternative],
      switchDisabled: false,
      switching: false,
      onSwitch,
      onClose: close,
    };
    const view = render(<ConversationRoleDialog open {...props} />);
    const select = () => screen.getByRole("combobox", {
      name: "选择新的会话角色",
    });

    fireEvent.change(select(), { target: { value: alternative.id } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(close).toHaveBeenCalledOnce();
    expect(onSwitch).not.toHaveBeenCalled();

    view.rerender(<ConversationRoleDialog open={false} {...props} />);
    view.rerender(<ConversationRoleDialog open {...props} />);

    expect(select()).toHaveValue(role.id);
    expect(screen.getByRole("button", { name: "应用角色" })).toBeDisabled();

    fireEvent.change(select(), { target: { value: alternative.id } });
    fireEvent.click(screen.getByRole("button", { name: "应用角色" }));
    expect(onSwitch).toHaveBeenCalledOnce();
    expect(onSwitch).toHaveBeenCalledWith(alternative.id);
  });
});
