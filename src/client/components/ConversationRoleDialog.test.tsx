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
};

describe("ConversationRoleDialog", () => {
  it("shows the complete frozen role snapshot without a switch action", () => {
    render(<ConversationRoleDialog open role={role} onClose={() => undefined} />);

    expect(screen.getByRole("dialog", { name: "会话角色" })).toHaveTextContent("Reviewer");
    expect(screen.getByText("Reviews risky changes")).toBeInTheDocument();
    expect(screen.getByText("Inspect the exact diff before drawing conclusions."))
      .toBeInTheDocument();
    expect(screen.getByText("openai / gpt-5")).toBeInTheDocument();
    expect(screen.getByText("修订 7")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /切换/ })).not.toBeInTheDocument();
  });

  it("closes without modifying the snapshot", () => {
    const close = vi.fn();
    const view = render(<ConversationRoleDialog
      open
      role={role}
      onClose={close}
    />);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(close).toHaveBeenCalledOnce();

    view.rerender(<ConversationRoleDialog
      open={false}
      role={role}
      onClose={close}
    />);
    expect(screen.queryByRole("dialog", { name: "会话角色" }))
      .not.toBeInTheDocument();
  });
});
