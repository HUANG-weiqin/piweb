// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicState } from "../../shared/protocol";
import { ConnectionDrawer } from "./ConnectionDrawer";

afterEach(cleanup);

const commandId = "b55e4225-e07f-4874-b760-015f7982d999";

const state: PublicState = {
  sessionId: "session-1",
  projectId: "project-1",
  conversationId: "conversation-1",
  cwd: "E:\\work",
  busy: false,
  thinkingLevel: "off",
  toolMode: "full_access",
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

function drawerProps(overrides: Partial<Parameters<typeof ConnectionDrawer>[0]> = {}) {
  return {
    state,
    conversations,
    conversationIndexTruncated: false,
    open: true,
    online: true,
    toolModeBusy: false,
    conversationBusy: false,
    onClose: () => undefined,
    onNewConversation: () => undefined,
    onOpenConversation: () => undefined,
    onRenameConversation: () => undefined,
    onDeleteConversation: () => true,
    onKey: () => commandId,
    onOAuth: () => undefined,
    onLogout: () => undefined,
    onRefresh: () => undefined,
    onModel: () => commandId,
    onClearSettingResult: () => undefined,
    onKeyDialogChange: () => undefined,
    onThinking: () => undefined,
    onToolMode: () => undefined,
    ...overrides,
  } satisfies Parameters<typeof ConnectionDrawer>[0];
}

function renderDrawer(overrides: Partial<Parameters<typeof ConnectionDrawer>[0]> = {}) {
  return render(<ConnectionDrawer {...drawerProps(overrides)} />);
}

describe("ConnectionDrawer", () => {
  it("shows only models Pi reports as available", () => {
    renderDrawer();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("locked")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "低" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "high" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "工具权限" }))
      .getAllByRole("option")
      .map((option) => option.textContent)).toEqual(["全部授权", "只读"]);
  });

  it("explains that full access executes tools without prompting", () => {
    renderDrawer({ state: { ...state, toolMode: "full_access" } });

    expect(screen.getByText(/直接执行，不会询问/)).toBeInTheDocument();
    expect(screen.getByText(/项目外文件/)).toBeInTheDocument();
  });

  it("limits read-only mode to Pi's native reading tools", () => {
    renderDrawer({ state: { ...state, toolMode: "read_only" } });

    expect(screen.getByText(/read、grep、find 和 ls/)).toBeInTheDocument();
    expect(screen.getByText(/命令.*被阻止/)).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", {
      name: "打开对话 older work",
    }));
    expect(openConversation).toHaveBeenCalledWith("conversation-2");
    fireEvent.change(screen.getByRole("textbox", { name: "当前对话名称" }), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(renameConversation).toHaveBeenCalledWith("Renamed");
  });

  it("confirms before deleting a non-current conversation", () => {
    const deleteConversation = vi.fn(() => true);
    renderDrawer({
      conversations: [
        ...conversations,
        {
          id: "conversation-2",
          name: "Older work",
          preview: "older",
          createdAt: "2026-07-17T12:00:00.000Z",
          updatedAt: "2026-07-17T12:01:00.000Z",
          messageCount: 4,
        },
      ],
      onDeleteConversation: deleteConversation,
    });

    expect(screen.queryByRole("button", {
      name: "删除对话 Current",
    })).not.toBeInTheDocument();
    expect(screen.getByText("当前对话需先新建或切换后删除。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "删除对话 Older work",
    }));
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "永久删除“Older work”？此操作无法撤销。",
    );

    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(screen.queryByText(/永久删除“Older work”/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "删除对话 Older work",
    }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(deleteConversation).toHaveBeenCalledWith("conversation-2");
  });

  it("shows models only for the provider the user chose", () => {
    const secondProvider = {
      id: "other",
      name: "Other",
      configured: true,
      oauth: false,
      models: [{
        provider: "other",
        id: "other-model",
        name: "Other Model",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        available: true,
      }],
    };
    renderDrawer({ state: { ...state, providers: [...state.providers, secondProvider] } });

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Other Model")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "提供商" }), {
      target: { value: "other" },
    });
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Other Model")).toBeInTheDocument();
    expect(screen.getByText(/支持推理/)).toBeInTheDocument();
  });

  it("does not resend the model that is already active", () => {
    renderDrawer({
      state: {
        ...state,
        selectedModel: { provider: "test", id: "ready" },
      },
    });
    const current = screen.getByRole("button", { name: /Ready.*当前/ });
    expect(current).toBeDisabled();
    expect(current).toHaveAttribute("aria-current", "true");
  });

  it("keeps an API Key private and waits for an exact command acknowledgement", () => {
    const saveKey = vi.fn(() => commandId);
    const unconfiguredState: PublicState = {
      ...state,
      providers: state.providers.map((provider) => ({
        ...provider,
        configured: false,
        models: provider.models.map((model) => ({ ...model, available: false })),
      })),
    };
    const view = renderDrawer({ state: unconfiguredState, onKey: saveKey });

    fireEvent.click(screen.getByRole("button", { name: "使用 API Key" }));
    const dialog = screen.getByRole("dialog", { name: "Test API Key" });
    expect(dialog).toHaveTextContent("不写入项目");
    const keyInput = screen.getByLabelText("API Key");
    expect(keyInput).toHaveAttribute("type", "password");
    expect(keyInput).toHaveFocus();
    fireEvent.change(keyInput, { target: { value: "  secret-key  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));

    expect(saveKey).toHaveBeenCalledWith("test", "secret-key");
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(dialog).toBeInTheDocument();

    view.rerender(<ConnectionDrawer {...drawerProps({
      state,
      onKey: saveKey,
      settingResult: {
        operation: "set_api_key",
        commandId,
        ok: true,
        message: "",
      },
    })} />);
    expect(screen.queryByRole("dialog", { name: "Test API Key" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("API Key 已保存");
  });

  it("keeps the API Key dialog open and actionable when saving fails", () => {
    const saveKey = vi.fn(() => commandId);
    const view = renderDrawer({ onKey: saveKey });
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "replacement-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));

    view.rerender(<ConnectionDrawer {...drawerProps({
      onKey: saveKey,
      settingResult: {
        operation: "set_api_key",
        commandId,
        ok: false,
        message: "Key 保存失败",
      },
    })} />);
    expect(screen.getByRole("dialog", { name: "Test API Key" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Key 保存失败");
    expect(screen.getByRole("button", { name: "保存 API Key" })).toBeEnabled();
  });

  it("clears an unconfirmed Key and releases the dialog after disconnect", () => {
    const view = renderDrawer({ onKey: () => commandId });
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "unconfirmed-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));

    view.rerender(<ConnectionDrawer {...drawerProps({
      online: false,
      onKey: () => commandId,
    })} />);
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("无法确认");
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
  });

  it("confirms the global impact before removing a local credential", () => {
    const logout = vi.fn();
    renderDrawer({ onLogout: logout });

    fireEvent.click(screen.getByRole("button", { name: "移除本机凭据" }));
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("所有项目");

    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(logout).toHaveBeenCalledWith("test");
  });

  it("offers a real model refresh when a configured provider has no models", () => {
    const refresh = vi.fn();
    renderDrawer({
      state: {
        ...state,
        providers: state.providers.map((provider) => ({ ...provider, models: [] })),
      },
      onRefresh: refresh,
    });

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
