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
  it("shows the complete role snapshot and disables reapplying the same revision", () => {
    render(<ConversationRoleDialog
      open
      role={role}
      roles={roles}
      switchDisabled={false}
      switching={false}
      onSwitch={() => true}
      onClose={() => undefined}
    />);

    expect(screen.getByRole("dialog", { name: "会话角色" })).toHaveTextContent("Reviewer");
    expect(screen.getByText("Reviews risky changes")).toBeInTheDocument();
    expect(screen.getByText("Inspect the exact diff before drawing conclusions."))
      .toBeInTheDocument();
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
    expect(screen.queryByText(/openai \//)).not.toBeInTheDocument();
    expect(screen.getByText("修订 7")).toBeInTheDocument();
    expect(screen.getByText("允许")).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
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
    expect(screen.queryByRole("dialog", { name: "会话角色" }))
      .not.toBeInTheDocument();
  });
});
