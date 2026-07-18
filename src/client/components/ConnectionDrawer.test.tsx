// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicState } from "../../shared/protocol";
import { ConnectionDrawer } from "./ConnectionDrawer";

afterEach(cleanup);

const state: PublicState = {
  sessionId: "session-1",
  projectId: "project-1",
  conversationId: "conversation-1",
  cwd: "E:\\work",
  busy: false,
  thinkingLevel: "off",
  toolMode: "workspace_write",
  availableThinkingLevels: ["off", "low"],
  providers: [{
    id: "test",
    name: "Test",
    configured: true,
    oauth: false,
    models: [
      { provider: "test", id: "ready", name: "Ready", reasoning: false, input: ["text"], contextWindow: 100, available: true },
      { provider: "test", id: "locked", name: "Locked", reasoning: false, input: ["text"], contextWindow: 100, available: false },
    ],
  }],
};

const conversations = [{
  id: "conversation-1",
  name: "Current",
  preview: "hello",
  createdAt: "2026-07-18T12:00:00.000Z",
  updatedAt: "2026-07-18T12:01:00.000Z",
  messageCount: 2,
}];

function renderDrawer(overrides: Partial<Parameters<typeof ConnectionDrawer>[0]> = {}) {
  return render(<ConnectionDrawer
    state={state}
    conversations={conversations}
    conversationIndexTruncated={false}
    open
    toolModeBusy={false}
    conversationBusy={false}
    onClose={() => undefined}
    onNewConversation={() => undefined}
    onOpenConversation={() => undefined}
    onRenameConversation={() => undefined}
    onKey={() => undefined}
    onOAuth={() => undefined}
    onLogout={() => undefined}
    onModel={() => undefined}
    onThinking={() => undefined}
    onToolMode={() => undefined}
    {...overrides}
  />);
}

describe("ConnectionDrawer", () => {
  it("shows only models Pi reports as available", () => {
    renderDrawer();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.queryByText("locked")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "low" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "high" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "工作区可写" })).toBeInTheDocument();
  });

  it("does not crash if the browser briefly receives state from an older server", () => {
    const legacyState = { ...state, availableThinkingLevels: undefined } as unknown as PublicState;
    expect(() => renderDrawer({ state: legacyState })).not.toThrow();
  });

  it("owns modal focus and closes safely with Escape", () => {
    const close = vi.fn();
    renderDrawer({ onClose: close });

    expect(screen.getByRole("dialog", { name: "工作台设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("switches and renames project conversations", () => {
    const openConversation = vi.fn();
    const renameConversation = vi.fn();
    renderDrawer({
      conversations: [
        ...conversations,
        {
          id: "conversation-2",
          preview: "older work",
          createdAt: "2026-07-17T12:00:00.000Z",
          updatedAt: "2026-07-17T12:01:00.000Z",
          messageCount: 1,
        },
      ],
      onOpenConversation: openConversation,
      onRenameConversation: renameConversation,
    });

    fireEvent.click(screen.getByRole("button", { name: /older work/ }));
    expect(openConversation).toHaveBeenCalledWith("conversation-2");
    fireEvent.change(screen.getByRole("textbox", { name: "当前对话名称" }), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(renameConversation).toHaveBeenCalledWith("Renamed");
  });
});
