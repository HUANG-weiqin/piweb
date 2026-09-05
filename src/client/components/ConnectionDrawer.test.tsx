// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicProvider, PublicState } from "../../shared/protocol";
import { ConnectionDrawer } from "./ConnectionDrawer";

afterEach(cleanup);

const commandId = "b55e4225-e07f-4874-b760-015f7982d999";

const state: PublicState = {
  sessionId: "session-1",
  projectId: "project-1",
  conversationId: "conversation-1",
  cwd: "E:\\work",
  busy: false,
  selectedServiceTier: null,
  thinkingLevel: "off",
  toolMode: "full_access",
  availableThinkingLevels: ["off", "low"],
  providers: [{
    id: "test",
    name: "Test",
    configured: true,
    oauth: false,
    models: [
      { provider: "test", id: "ready", name: "Ready", reasoning: false, thinkingLevels: ["off"], input: ["text"], contextWindow: 100, available: true },
      { provider: "test", id: "locked", name: "Locked", reasoning: false, thinkingLevels: ["off"], input: ["text"], contextWindow: 100, available: false },
    ],
  }],
};

function drawerProps(overrides: Partial<Parameters<typeof ConnectionDrawer>[0]> = {}) {
  return {
    state,
    open: true,
    online: true,
    onClose: () => undefined,
    onKey: () => commandId,
    onOAuth: () => undefined,
    onLogout: () => undefined,
    onRefresh: () => undefined,
    onClearSettingResult: () => undefined,
    onKeyDialogChange: () => undefined,
    ...overrides,
  } satisfies Parameters<typeof ConnectionDrawer>[0];
}

function renderDrawer(overrides: Partial<Parameters<typeof ConnectionDrawer>[0]> = {}) {
  return render(<ConnectionDrawer {...drawerProps(overrides)} />);
}

function ConnectionDrawerBackdropFixture({
  onKey,
  onOAuth,
  onLogout,
  onRefresh,
}: Pick<Parameters<typeof ConnectionDrawer>[0],
  "onKey" | "onOAuth" | "onLogout" | "onRefresh">) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开模型连接测试</button>
    <ConnectionDrawer {...drawerProps({
      open,
      onClose: () => setOpen(false),
      onKey,
      onOAuth,
      onLogout,
      onRefresh,
    })} />
  </>;
}

describe("ConnectionDrawer", () => {
  it("shows only models Pi reports as available", () => {
    renderDrawer();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("locked")).not.toBeInTheDocument();
  });

  it("contains only provider connection and model catalog controls", () => {
    renderDrawer();

    expect(screen.getByRole("dialog", { name: "模型连接" }))
      .toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "提供商" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "工具权限" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "思考级别" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "当前会话名称" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理角色" }))
      .not.toBeInTheDocument();
  });

  it("owns modal focus and closes safely with Escape", () => {
    const close = vi.fn();
    renderDrawer({ onClose: close });

    expect(screen.getByRole("dialog", { name: "模型连接" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("dismisses the drawer only from its exact backdrop and restores its launcher", async () => {
    const onKey = vi.fn(() => undefined);
    const onOAuth = vi.fn();
    const onLogout = vi.fn();
    const onRefresh = vi.fn(() => undefined);
    render(<ConnectionDrawerBackdropFixture
      onKey={onKey}
      onOAuth={onOAuth}
      onLogout={onLogout}
      onRefresh={onRefresh}
    />);

    const launcher = screen.getByRole("button", { name: "打开模型连接测试" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "模型连接" });
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
      expect(screen.queryByRole("dialog", { name: "模型连接" }))
        .not.toBeInTheDocument();
      expect(launcher.isConnected).toBe(true);
      expect(launcher).toHaveFocus();
    });
    expect(onKey).not.toHaveBeenCalled();
    expect(onOAuth).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("shows models only for the provider the user chose", () => {
    const secondProvider: PublicProvider = {
      id: "other",
      name: "Other",
      configured: true,
      oauth: false,
      models: [{
        provider: "other",
        id: "other-model",
        name: "Other Model",
        reasoning: true,
        thinkingLevels: ["off", "low", "medium", "high"],
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
    expect(screen.queryByText("test / ready")).not.toBeInTheDocument();
  });

  it("keeps model choices read-only", () => {
    renderDrawer();
    const model = screen.getByRole("button", {
      name: /Ready.*在角色中选择/,
    });
    expect(model).toBeDisabled();
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
    fireEvent.click(screen.getByRole("button", { name: "显示" }));
    expect(keyInput).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));

    expect(saveKey).toHaveBeenCalledWith("test", "secret-key");
    expect(keyInput).toHaveValue("");
    expect(keyInput).toHaveAttribute("type", "password");
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

  it("closes from the API Key backdrop and disposes every local secret state", () => {
    const saveKey = vi.fn(() => commandId);
    const view = renderDrawer({ onKey: saveKey });

    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "failed-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "显示" }));
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
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "unsaved-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "显示" }));
    saveKey.mockClear();

    const dialog = screen.getByRole("dialog", { name: "Test API Key" });
    const backdrop = dialog.parentElement;
    expect(backdrop).toHaveClass("modal-backdrop");
    const backdropMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(backdrop!, backdropMouseDown);

    expect(backdropMouseDown.defaultPrevented).toBe(true);
    expect(saveKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Test API Key" }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
    expect(screen.queryByText("Key 保存失败")).not.toBeInTheDocument();
  });

  it("does not close the API Key dialog from a bubbled form-child mouse-down", () => {
    const saveKey = vi.fn();
    renderDrawer({ onKey: saveKey });

    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    const keyInput = screen.getByLabelText("API Key");
    fireEvent.change(keyInput, { target: { value: "unsaved-key" } });
    const interiorMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(keyInput, interiorMouseDown);

    expect(interiorMouseDown.defaultPrevented).toBe(false);
    expect(screen.getByRole("dialog", { name: "Test API Key" }))
      .toBeInTheDocument();
    expect(keyInput).toHaveValue("unsaved-key");
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("keeps the API Key backdrop inert while an exact save is pending", () => {
    const saveKey = vi.fn(() => commandId);
    renderDrawer({ onKey: saveKey });

    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "pending-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));
    const dialog = screen.getByRole("dialog", { name: "Test API Key" });
    const backdropMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(dialog.parentElement!, backdropMouseDown);

    expect(backdropMouseDown.defaultPrevented).toBe(true);
    expect(dialog).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(saveKey).toHaveBeenCalledTimes(1);
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
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "retry-key" },
    });
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

  it("always offers refresh and settles only its exact command result", () => {
    const secondCommandId = "8ee64aa3-c8a8-4e21-b521-66029ce3673b";
    const refresh = vi.fn()
      .mockReturnValueOnce(commandId)
      .mockReturnValueOnce(secondCommandId);
    const view = renderDrawer({ onRefresh: refresh });

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "正在刷新模型…" })).toBeDisabled();

    view.rerender(<ConnectionDrawer {...drawerProps({
      onRefresh: refresh,
      settingResult: {
        operation: "refresh_models",
        commandId: "8ee64aa3-c8a8-4e21-b521-66029ce3673b",
        ok: false,
        message: "stale",
      },
    })} />);
    expect(screen.getByRole("button", { name: "正在刷新模型…" })).toBeDisabled();

    view.rerender(<ConnectionDrawer {...drawerProps({
      onRefresh: refresh,
      settingResult: {
        operation: "refresh_models",
        commandId,
        ok: true,
        message: "",
      },
    })} />);
    expect(screen.getByRole("status")).toHaveTextContent("远程供应商模型目录已刷新");
    expect(screen.getByRole("status")).toHaveClass("success");
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    view.rerender(<ConnectionDrawer {...drawerProps({
      onRefresh: refresh,
      settingResult: {
        operation: "refresh_models",
        commandId: secondCommandId,
        ok: false,
        message: "刷新失败",
      },
    })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("刷新失败");
    expect(screen.getByRole("alert")).toHaveClass("error");
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled();
  });

  it("invalidates a pending refresh when the observed session changes", () => {
    const view = renderDrawer({ onRefresh: () => commandId });
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));

    view.rerender(<ConnectionDrawer {...drawerProps({
      state: { ...state, sessionId: "session-2" },
      onRefresh: () => commandId,
    })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("状态未确认");
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled();
  });

  it("keeps refresh available with no provider and disables it offline or while busy", () => {
    const refresh = vi.fn(() => commandId);
    const view = renderDrawer({
      state: { ...state, providers: [] },
      onRefresh: refresh,
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    expect(refresh).toHaveBeenCalledOnce();

    view.rerender(<ConnectionDrawer {...drawerProps({
      state: { ...state, providers: [] },
      online: false,
      onRefresh: refresh,
    })} />);
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeDisabled();

    view.rerender(<ConnectionDrawer {...drawerProps({
      state: { ...state, busy: true },
      onRefresh: refresh,
    })} />);
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeDisabled();
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
