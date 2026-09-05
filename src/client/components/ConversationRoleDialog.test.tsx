// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("ConversationRoleDialog", () => {
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
    expect(dialog).toHaveTextContent("Reviewer");
    expect(dialog).toHaveTextContent("gpt-5");
    expect(screen.getByRole("button", { name: "应用角色" })).toBeDisabled();
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
