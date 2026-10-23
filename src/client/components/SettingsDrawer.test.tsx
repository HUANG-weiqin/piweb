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
import type { PublicProvider, PublicState } from "../../shared/protocol";
import {
  SettingsDrawer,
  type CustomProvidersView,
  type SettingOperationResult,
} from "./SettingsDrawer";

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
    apiKey: true,
    oauth: false,
    models: [
      { provider: "test", id: "ready", name: "Ready", reasoning: false, thinkingLevels: ["off"], input: ["text"], contextWindow: 100, available: true },
      { provider: "test", id: "locked", name: "Locked", reasoning: false, thinkingLevels: ["off"], input: ["text"], contextWindow: 100, available: false },
    ],
  }],
};

type SettingsDrawerProps = Parameters<typeof SettingsDrawer>[0];
type SettingsDrawerTestOverrides = Partial<SettingsDrawerProps> & {
  settingResult?: Omit<SettingOperationResult, "sessionId"> & { sessionId?: string };
};

function settingsProps(overrides: SettingsDrawerTestOverrides = {}) {
  const { settingResult, settingResults, ...props } = overrides;
  return {
    state,
    open: true,
    online: true,
    preferencesOnline: true,
    colorScheme: "quiet-rebel" as const,
    colorSchemePending: false,
    colorSchemeUnsaved: false,
    colorSchemeError: "",
    settingResults: settingResults ?? (settingResult ? {
      [settingResult.operation]: {
        ...settingResult,
        sessionId: settingResult.sessionId ?? props.state?.sessionId ?? state.sessionId,
      },
    } : {}),
    customProviders: undefined,
    customProvidersRefreshing: false,
    customProvidersRefreshError: "",
    customProviderMutationPending: false,
    customProviderMutationResult: undefined,
    customProviderProbePending: false,
    customProviderProbeResult: undefined,
    onClose: () => undefined,
    onColorSchemeChange: () => undefined,
    onRetryColorScheme: () => undefined,
    onRefreshCustomProviders: () => undefined,
    onSaveCustomProvider: () => undefined,
    onDeleteCustomProvider: () => undefined,
    onProbeCustomProviderModels: () => undefined,
    onKey: () => commandId,
    onOAuth: () => undefined,
    onLogout: () => undefined,
    onRefresh: () => undefined,
    onConsumeSettingResult: () => undefined,
    onKeyDialogChange: () => undefined,
    ...props,
  } satisfies SettingsDrawerProps;
}

function renderSettings(overrides: SettingsDrawerTestOverrides = {}) {
  return render(<SettingsDrawer {...settingsProps(overrides)} />);
}

function openModelConnections() {
  fireEvent.click(screen.getByRole("button", { name: "打开模型连接设置" }));
}

function renderDrawer(overrides: SettingsDrawerTestOverrides = {}) {
  const view = renderSettings(overrides);
  openModelConnections();
  return view;
}

function SettingsDrawerBackdropFixture({
  onKey,
  onOAuth,
  onLogout,
  onRefresh,
}: Pick<Parameters<typeof SettingsDrawer>[0],
  "onKey" | "onOAuth" | "onLogout" | "onRefresh">) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开设置测试</button>
    <SettingsDrawer {...settingsProps({
      open,
      onClose: () => setOpen(false),
      onKey,
      onOAuth,
      onLogout,
      onRefresh,
    })} />
  </>;
}

function SettingsDrawerFocusOwnerFixture() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开设置测试</button>
    <SettingsDrawer {...settingsProps({
      open,
      onClose: () => setOpen(false),
    })} />
  </>;
}

describe("SettingsDrawer", () => {
  it("opens on a HOME with only category summaries", () => {
    renderSettings({
      state: { ...state, selectedModel: { provider: "test", id: "ready" } },
    });

    const dialog = screen.getByRole("dialog", { name: "设置" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开外观设置" }))
      .toHaveTextContent("Quiet Rebel");
    expect(screen.getByRole("button", { name: "打开模型连接设置" }))
      .toHaveTextContent("Ready");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "搜索模型" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新模型" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更新 API Key" }))
      .not.toBeInTheDocument();
  });

  it("reports pending preferences and offline runtime truth in HOME summaries", () => {
    renderSettings({
      state: { ...state, selectedModel: { provider: "test", id: "ready" } },
      colorScheme: "classic-rebel",
      colorSchemePending: true,
      online: false,
      preferencesOnline: false,
    });

    expect(screen.getByRole("button", { name: "打开外观设置" }))
      .toHaveTextContent(/Classic Rebel.*正在保存/);
    expect(screen.getByRole("button", { name: "打开模型连接设置" }))
      .toHaveTextContent(/离线.*Ready/);
  });

  it("shows only models Pi reports as available on the dedicated page", () => {
    renderDrawer();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("locked")).not.toBeInTheDocument();
  });

  it("focuses each dedicated page and restores its originating HOME row", async () => {
    renderSettings();
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const appearanceRow = screen.getByRole("button", { name: "打开外观设置" });
    expect(appearanceRow.tagName).toBe("BUTTON");

    appearanceRow.focus();
    fireEvent.click(appearanceRow);
    await waitFor(() => expect(screen.getByRole("heading", { name: "外观" })).toHaveFocus());
    expect(screen.getByRole("radio", { name: /Quiet Rebel/ })).toBeChecked();

    dialog.scrollTop = 96;
    fireEvent.click(screen.getByRole("button", { name: "返回设置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "打开外观设置" })).toHaveFocus());
    expect(dialog.scrollTop).toBe(0);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("uses Escape as nested page navigation before closing and reopens at HOME", async () => {
    render(<SettingsDrawerBackdropFixture
      onKey={() => undefined}
      onOAuth={() => undefined}
      onLogout={() => undefined}
      onRefresh={() => undefined}
    />);
    const launcher = screen.getByRole("button", { name: "打开设置测试" });
    launcher.focus();
    fireEvent.click(launcher);
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus());

    openModelConnections();
    await waitFor(() => expect(screen.getByRole("heading", { name: "模型连接" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "打开模型连接设置" })).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(launcher).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "设置" })).not.toBeInTheDocument();

    fireEvent.click(launcher);
    expect(screen.getByRole("button", { name: "打开外观设置" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "提供商" })).not.toBeInTheDocument();
  });

  it("shows and settles a pending refresh while HOME is projected", async () => {
    const refresh = vi.fn(() => commandId);
    const view = renderDrawer({ onRefresh: refresh });
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    fireEvent.click(screen.getByRole("button", { name: "返回设置" }));

    expect(screen.getByRole("button", { name: "打开模型连接设置" }))
      .toHaveTextContent("正在刷新模型");

    view.rerender(<SettingsDrawer {...settingsProps({
      onRefresh: refresh,
      settingResult: {
        operation: "refresh_models",
        commandId,
        ok: true,
        message: "",
      },
    })} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "打开模型连接设置" }))
      .not.toHaveTextContent("正在刷新模型"));
    openModelConnections();
    expect(screen.getByRole("status"))
      .toHaveTextContent("远程供应商模型目录已刷新");
  });

  it("owns modal focus and closes safely with Escape", () => {
    const close = vi.fn();
    renderSettings({ onClose: close });

    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("dismisses the drawer only from its exact backdrop and restores its launcher", async () => {
    const onKey = vi.fn(() => undefined);
    const onOAuth = vi.fn();
    const onLogout = vi.fn();
    const onRefresh = vi.fn(() => undefined);
    render(<SettingsDrawerBackdropFixture
      onKey={onKey}
      onOAuth={onOAuth}
      onLogout={onLogout}
      onRefresh={onRefresh}
    />);

    const launcher = screen.getByRole("button", { name: "打开设置测试" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "设置" });
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
      expect(screen.queryByRole("dialog", { name: "设置" }))
        .not.toBeInTheDocument();
      expect(launcher.isConnected).toBe(true);
      expect(launcher).toHaveFocus();
    });
    expect(onKey).not.toHaveBeenCalled();
    expect(onOAuth).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("restores exact focus owners through the nested API Key modal", async () => {
    render(<SettingsDrawerFocusOwnerFixture />);

    const launcher = screen.getByRole("button", { name: "打开设置测试" });
    expect(launcher.isConnected).toBe(true);
    launcher.focus();
    expect(launcher).toHaveFocus();
    fireEvent.click(launcher);

    const drawerClose = screen.getByRole("button", { name: "关闭" });
    await waitFor(() => expect(drawerClose).toHaveFocus());
    openModelConnections();
    await waitFor(() => expect(screen.getByRole("heading", { name: "模型连接" })).toHaveFocus());

    const keyTrigger = screen.getByRole("button", { name: "更新 API Key" });
    expect(keyTrigger.isConnected).toBe(true);
    keyTrigger.focus();
    expect(keyTrigger).toHaveFocus();
    fireEvent.click(keyTrigger);

    const keyInput = screen.getByLabelText("API Key");
    expect(keyInput).toHaveAttribute("data-modal-autofocus");
    await waitFor(() => expect(keyInput).toHaveFocus());

    const keyClose = screen.getByRole("button", { name: "关闭 API Key 设置" });
    keyClose.focus();
    fireEvent.click(keyClose);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Test API Key" }))
        .not.toBeInTheDocument();
      expect(keyTrigger.isConnected).toBe(true);
      expect(keyTrigger).toHaveFocus();
    });

    drawerClose.focus();
    fireEvent.click(drawerClose);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "设置" }))
        .not.toBeInTheDocument();
      expect(launcher.isConnected).toBe(true);
      expect(launcher).toHaveFocus();
    });
  });

  it("shows models only for the provider the user chose", () => {
    const secondProvider: PublicProvider = {
      id: "other",
      name: "Other",
      configured: true,
      apiKey: true,
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

    expect(saveKey).toHaveBeenCalledOnce();
    expect(saveKey).toHaveBeenCalledWith("test", "secret-key");
    expect(keyInput).toHaveValue("");
    expect(keyInput).toHaveAttribute("type", "password");
    const close = screen.getByRole("button", { name: "关闭 API Key 设置" });
    const cancel = screen.getByRole("button", { name: "取消" });
    const visibility = screen.getByRole("button", { name: "显示" });
    const save = screen.getByRole("button", { name: "正在保存…" });
    expect(close).toBeDisabled();
    expect(cancel).toBeDisabled();
    expect(keyInput).toBeDisabled();
    expect(visibility).toBeDisabled();
    expect(save).toBeDisabled();
    expect(keyInput).toHaveFocus();

    fireEvent.click(close);
    fireEvent.click(cancel);
    fireEvent.keyDown(document, { key: "Escape" });
    const backdropMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(dialog.parentElement!, backdropMouseDown);

    expect(backdropMouseDown.defaultPrevented).toBe(true);
    expect(dialog).toBeInTheDocument();
    expect(keyInput).toHaveFocus();
    expect(saveKey).toHaveBeenCalledOnce();

    view.rerender(<SettingsDrawer {...settingsProps({
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

  it("offers API Key and subscription login when the provider supports both", () => {
    renderDrawer({
      state: {
        ...state,
        providers: [{
          id: "anthropic",
          name: "Anthropic (Claude Pro/Max)",
          configured: false,
          apiKey: true,
          oauth: true,
          models: [],
        }],
      },
    });

    expect(screen.getByRole("button", { name: "使用 API Key" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "登录订阅账户" })).toBeEnabled();
  });

  it("hides the API Key entry for a subscription-only provider", () => {
    renderDrawer({
      state: {
        ...state,
        providers: [{
          id: "codex",
          name: "OpenAI (ChatGPT Plus/Pro)",
          configured: false,
          apiKey: false,
          oauth: true,
          models: [],
        }],
      },
    });

    expect(screen.queryByRole("button", { name: "使用 API Key" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录订阅账户" })).toBeEnabled();
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
    view.rerender(<SettingsDrawer {...settingsProps({
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

  it("clears an unsubmitted Key when its provider leaves the catalog", () => {
    const view = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "catalog-secret" },
    });

    view.rerender(<SettingsDrawer {...settingsProps({
      state: { ...state, providers: [] },
    })} />);
    expect(screen.queryByRole("dialog", { name: "Test API Key" }))
      .not.toBeInTheDocument();

    view.rerender(<SettingsDrawer {...settingsProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
  });

  it("keeps the pending API Key owner through same-session provider catalog drift", () => {
    const saveKey = vi.fn(() => commandId);
    const view = renderDrawer({ onKey: saveKey });

    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "pending-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));

    view.rerender(<SettingsDrawer {...settingsProps({
      state: { ...state, providers: [] },
      onKey: saveKey,
    })} />);
    expect(screen.getByRole("dialog", { name: "Test API Key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByLabelText("API Key")).toHaveValue("");

    view.rerender(<SettingsDrawer {...settingsProps({
      state: { ...state, providers: [] },
      onKey: saveKey,
      settingResult: {
        operation: "set_api_key",
        commandId,
        ok: false,
        message: "Key 保存失败",
      },
    })} />);
    expect(screen.queryByRole("dialog", { name: "Test API Key" }))
      .not.toBeInTheDocument();
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

    view.rerender(<SettingsDrawer {...settingsProps({
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

  it("clears an unsubmitted Key and provider owner when the drawer closes", () => {
    const view = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "drawer-secret" },
    });

    view.rerender(<SettingsDrawer {...settingsProps({ open: false })} />);
    view.rerender(<SettingsDrawer {...settingsProps()} />);
    openModelConnections();
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
  });

  it("clears an unsubmitted Key and provider owner after disconnect", () => {
    const view = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "offline-secret" },
    });

    view.rerender(<SettingsDrawer {...settingsProps({ online: false })} />);
    expect(screen.queryByRole("dialog", { name: "Test API Key" }))
      .not.toBeInTheDocument();

    view.rerender(<SettingsDrawer {...settingsProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
  });

  it("clears an unsubmitted Key when its opening session is replaced", () => {
    const view = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "old-session-secret" },
    });

    view.rerender(<SettingsDrawer {...settingsProps({
      state: { ...state, sessionId: "session-2" },
    })} />);
    expect(screen.queryByRole("dialog", { name: "Test API Key" }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
  });

  it("clears an unconfirmed Key and closes its provider owner after disconnect", () => {
    const onKeyDialogChange = vi.fn();
    const view = renderDrawer({ onKey: () => commandId, onKeyDialogChange });
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "unconfirmed-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));

    view.rerender(<SettingsDrawer {...settingsProps({
      online: false,
      onKey: () => commandId,
      onKeyDialogChange,
    })} />);
    expect(screen.queryByRole("dialog", { name: "Test API Key" }))
      .not.toBeInTheDocument();
    expect(onKeyDialogChange).toHaveBeenLastCalledWith(false);

    view.rerender(<SettingsDrawer {...settingsProps({
      onKey: () => commandId,
      onKeyDialogChange,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
  });

  it("closes an unconfirmed API Key owner when the observation session changes", () => {
    const saveKey = vi.fn(() => commandId);
    const onKeyDialogChange = vi.fn();
    const view = renderDrawer({ onKey: saveKey, onKeyDialogChange });
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "unconfirmed-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));

    view.rerender(<SettingsDrawer {...settingsProps({
      state: { ...state, sessionId: "session-2" },
      onKey: saveKey,
      onKeyDialogChange,
      settingResult: {
        operation: "set_api_key",
        commandId,
        ok: true,
        message: "",
      },
    })} />);

    expect(screen.queryByRole("dialog", { name: "Test API Key" }))
      .not.toBeInTheDocument();
    expect(onKeyDialogChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "保存 API Key" })).toBeDisabled();
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

    view.rerender(<SettingsDrawer {...settingsProps({
      onRefresh: refresh,
      settingResult: {
        operation: "refresh_models",
        commandId: "8ee64aa3-c8a8-4e21-b521-66029ce3673b",
        ok: false,
        message: "stale",
      },
    })} />);
    expect(screen.getByRole("button", { name: "正在刷新模型…" })).toBeDisabled();

    view.rerender(<SettingsDrawer {...settingsProps({
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
    view.rerender(<SettingsDrawer {...settingsProps({
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

    view.rerender(<SettingsDrawer {...settingsProps({
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

    view.rerender(<SettingsDrawer {...settingsProps({
      state: { ...state, providers: [] },
      online: false,
      onRefresh: refresh,
    })} />);
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeDisabled();

    view.rerender(<SettingsDrawer {...settingsProps({
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

const probeCommandId = "2b0f4fcb-7c62-49e5-92ca-6f8b6af0aab2";

function customProvidersView(
  overrides: Partial<CustomProvidersView> = {},
): CustomProvidersView {
  return {
    revision: "rev-1",
    providers: [
      {
        id: "local-llama",
        name: "Local Llama",
        baseUrl: "http://127.0.0.1:8065/v1",
        api: "openai-completions",
        storedAuth: "none",
        authEnvNames: [],
        models: [{
          id: "llama-3.1-8b",
          name: "Llama 3.1 8B",
          contextWindow: 131_072,
          maxTokens: 8_192,
          reasoning: false,
          input: ["text"],
          extraFields: [],
        }],
        extraFields: [],
        editable: true,
        builtinOverride: false,
      },
      {
        id: "vendor:legacy",
        name: "Legacy",
        baseUrl: "http://127.0.0.1:9000/v1",
        api: "anthropic-messages",
        storedAuth: "literal",
        authEnvNames: [],
        models: [],
        extraFields: ["headers"],
        editable: false,
        builtinOverride: false,
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        storedAuth: "env",
        authEnvNames: ["ANTHROPIC_API_KEY"],
        models: [],
        extraFields: [],
        editable: true,
        builtinOverride: true,
      },
    ],
    error: "",
    truncated: false,
    ...overrides,
  };
}

function openCustomProviders(
  view: CustomProvidersView | undefined,
  overrides: SettingsDrawerTestOverrides = {},
) {
  const rendered = renderSettings({ customProviders: view, ...overrides });
  fireEvent.click(screen.getByRole("button", { name: "打开自定义提供商设置" }));
  return rendered;
}

function providerEntry(name: string): HTMLElement {
  const entry = screen.getAllByRole("article").find((element) => (
    element.textContent?.includes(name)
  ));
  if (!entry) throw new Error(`provider entry ${name} not found`);
  return entry;
}

describe("SettingsDrawer custom providers", () => {
  it("shows a HOME row with the custom provider summary", () => {
    renderSettings({ customProviders: customProvidersView() });
    expect(screen.getByRole("button", { name: "打开自定义提供商设置" }))
      .toHaveTextContent("3 个自定义提供商 · 已保存");

    cleanup();
    renderSettings({
      customProviders: customProvidersView(),
      preferencesOnline: false,
    });
    expect(screen.getByRole("button", { name: "打开自定义提供商设置" }))
      .toHaveTextContent("离线 · 3 个自定义提供商");
  });

  it("reads the latest snapshot when the page opens and renders provider rows", () => {
    const refresh = vi.fn();
    openCustomProviders(customProvidersView(), {
      onRefreshCustomProviders: refresh,
    });
    expect(refresh).toHaveBeenCalledOnce();

    const local = providerEntry("Local Llama");
    expect(within(local).getByText("id：local-llama")).toBeInTheDocument();
    expect(local).toHaveTextContent("Base URL：http://127.0.0.1:8065/v1");
    expect(local).toHaveTextContent("模型：1 个");
    expect(local).toHaveTextContent("密钥：未写入密钥");

    const legacy = providerEntry("Legacy");
    expect(legacy).toHaveTextContent("密钥：文件内已写入字面量密钥");
    expect(legacy).toHaveTextContent("该条目含表单不支持的字段，请直接编辑文件。");
    expect(legacy).toHaveTextContent("表单未管理的字段：headers");
    expect(within(legacy).getByRole("button", { name: "编辑" })).toBeDisabled();
    expect(within(legacy).getByRole("button", { name: "删除" })).toBeDisabled();

    const builtin = providerEntry("anthropic");
    expect(builtin).toHaveTextContent("内置覆盖");
    expect(builtin).toHaveTextContent(
      "该 id 同时是内置提供商；表单不能覆盖它，请直接编辑文件。",
    );
    expect(builtin).toHaveTextContent("密钥：环境变量 $ANTHROPIC_API_KEY");
  });

  it("renders the read error and truncation banners with a retry", () => {
    const refresh = vi.fn();
    openCustomProviders(customProvidersView({
      error: "models.json 不是合法 JSON",
      truncated: true,
    }), { onRefreshCustomProviders: refresh });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "读取本机 models.json 失败：models.json 不是合法 JSON",
    );
    expect(screen.getByText(/条目多于可展示上限/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("edits an existing provider and saves the exact payload", () => {
    const save = vi.fn(() => commandId);
    openCustomProviders(customProvidersView(), { onSaveCustomProvider: save });
    fireEvent.click(within(providerEntry("Local Llama"))
      .getByRole("button", { name: "编辑" }));

    expect(screen.getByLabelText("提供商 id")).toBeDisabled();
    expect(screen.getByLabelText("提供商 id")).toHaveValue("local-llama");
    expect(screen.getByRole("radio", { name: "保持不变" })).toBeChecked();

    fireEvent.change(screen.getByLabelText("显示名"), {
      target: { value: "本地 Llama" },
    });
    fireEvent.click(screen.getByLabelText("支持推理"));
    fireEvent.click(screen.getByLabelText("图片输入"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(save).toHaveBeenCalledWith({
      id: "local-llama",
      name: "本地 Llama",
      baseUrl: "http://127.0.0.1:8065/v1",
      api: "openai-completions",
      auth: { kind: "keep" },
      models: [{
        id: "llama-3.1-8b",
        name: "Llama 3.1 8B",
        contextWindow: 131_072,
        maxTokens: 8_192,
        reasoning: true,
        input: ["text", "image"],
      }],
    });
  });

  it("validates a new provider before calling save", () => {
    const save = vi.fn(() => commandId);
    openCustomProviders(customProvidersView(), { onSaveCustomProvider: save });
    fireEvent.click(screen.getByRole("button", { name: "新建提供商" }));

    expect(screen.queryByRole("radio", { name: "保持不变" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "本地服务无需鉴权（写入占位值）" }))
      .toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("提供商 id");

    fireEvent.change(screen.getByLabelText("提供商 id"), {
      target: { value: "本地 模型" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("提供商 id"), {
      target: { value: "local-qwen" },
    });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Base URL");

    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "http://127.0.0.1:11434/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("至少需要填写一个模型");

    fireEvent.change(screen.getByLabelText("模型 id"), {
      target: { value: "qwen2.5:7b" },
    });
    fireEvent.change(screen.getByLabelText("上下文窗口"), {
      target: { value: "three" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("上下文窗口必须是正整数");

    fireEvent.change(screen.getByLabelText("上下文窗口"), {
      target: { value: "32768" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).toHaveBeenCalledWith({
      id: "local-qwen",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      auth: { kind: "local" },
      models: [{
        id: "qwen2.5:7b",
        contextWindow: 32_768,
        reasoning: false,
        input: ["text"],
      }],
    });
  });

  it("switches auth kinds and validates the env variable name", () => {
    const save = vi.fn(() => commandId);
    openCustomProviders(customProvidersView(), { onSaveCustomProvider: save });
    fireEvent.click(within(providerEntry("Local Llama"))
      .getByRole("button", { name: "编辑" }));

    fireEvent.click(screen.getByRole("radio", { name: "环境变量" }));
    expect(screen.getByLabelText("环境变量名")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("环境变量名"), {
      target: { value: "1BAD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("环境变量名");

    fireEvent.change(screen.getByLabelText("环境变量名"), {
      target: { value: "LOCAL_API_KEY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      auth: { kind: "env", envName: "LOCAL_API_KEY" },
    }));

    fireEvent.click(screen.getByRole("radio", {
      name: "不写入，改用模型连接里保存的 Key",
    }));
    expect(screen.queryByLabelText("环境变量名")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      auth: { kind: "credential" },
    }));
  });

  it("probes the endpoint and only fills missing model fields", () => {
    const probe = vi.fn(() => probeCommandId);
    const rendered = openCustomProviders(customProvidersView(), {
      onProbeCustomProviderModels: probe,
    });
    fireEvent.click(within(providerEntry("Local Llama"))
      .getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("最大输出"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", {
      name: "从端点拉取模型列表",
    }));
    expect(probe).toHaveBeenCalledWith("http://127.0.0.1:8065/v1");

    rendered.rerender(<SettingsDrawer {...settingsProps({
      customProviders: customProvidersView(),
      customProviderProbePending: true,
      onProbeCustomProviderModels: probe,
    })} />);
    expect(screen.getByRole("button", { name: "正在拉取模型列表…" }))
      .toBeDisabled();

    rendered.rerender(<SettingsDrawer {...settingsProps({
      customProviders: customProvidersView(),
      customProviderProbeResult: {
        commandId: probeCommandId,
        baseUrl: "http://127.0.0.1:8065/v1",
        models: [{
          id: "llama-3.1-8b",
          name: "Probed Llama",
          contextWindow: 256_000,
          maxTokens: 4_096,
          reasoning: true,
          input: ["text", "image"],
        }, {
          id: "qwen2.5-coder",
          name: "Qwen Coder",
          contextWindow: 32_768,
        }],
        truncated: true,
        error: "",
      },
      onProbeCustomProviderModels: probe,
    })} />);

    expect(screen.getAllByLabelText("最大输出")[0]).toHaveValue("4096");
    expect(screen.getAllByLabelText("上下文窗口")[0]).toHaveValue("131072");
    expect(screen.getAllByLabelText("支持推理")[0]).toBeChecked();
    expect(screen.getByRole("status"))
      .toHaveTextContent("端点返回的模型多于上限");
    expect(screen.getAllByLabelText("模型 id").map(
      (input) => (input as HTMLInputElement).value,
    )).toEqual(["llama-3.1-8b", "qwen2.5-coder"]);
    expect(screen.getAllByLabelText("模型名称").map(
      (input) => (input as HTMLInputElement).value,
    )).toEqual(["Llama 3.1 8B", "Qwen Coder"]);
    expect(screen.queryByText(/自动探测：/)).not.toBeInTheDocument();
  });

  it("shows the probed context source and clears it after a manual edit", () => {
    const probe = vi.fn(() => probeCommandId);
    const rendered = openCustomProviders(customProvidersView(), {
      onProbeCustomProviderModels: probe,
    });
    fireEvent.click(within(providerEntry("Local Llama"))
      .getByRole("button", { name: "编辑" }));
    expect(screen.getByText("留空则用 Pi 默认 128000")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("上下文窗口"), {
      target: { value: "" },
    });
    expect(screen.getByText("未探测到上下文（留空则用 Pi 默认 128000）"))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "从端点拉取模型列表" }));

    rendered.rerender(<SettingsDrawer {...settingsProps({
      customProviders: customProvidersView(),
      customProviderProbeResult: {
        commandId: probeCommandId,
        baseUrl: "http://127.0.0.1:8065/v1",
        models: [{
          id: "llama-3.1-8b",
          contextWindow: 256_000,
          contextSource: "/api/v1/models",
        }, {
          id: "qwen2.5-coder",
          contextWindow: 32_768,
          contextSource: "models[].max_model_len",
        }],
        truncated: false,
        error: "",
      },
      onProbeCustomProviderModels: probe,
    })} />);

    expect(screen.getAllByLabelText("上下文窗口")[0]).toHaveValue("256000");
    expect(screen.getByText("自动探测：/api/v1/models")).toBeInTheDocument();
    expect(screen.getByText("自动探测：models[].max_model_len"))
      .toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText("上下文窗口")[0], {
      target: { value: "128000" },
    });
    expect(screen.queryByText("自动探测：/api/v1/models"))
      .not.toBeInTheDocument();
    expect(screen.getByText("自动探测：models[].max_model_len"))
      .toBeInTheDocument();
    expect(screen.getByText("留空则用 Pi 默认 128000")).toBeInTheDocument();
  });

  it("confirms before deleting a provider", () => {
    const remove = vi.fn(() => commandId);
    openCustomProviders(customProvidersView(), { onDeleteCustomProvider: remove });

    fireEvent.click(within(providerEntry("Local Llama"))
      .getByRole("button", { name: "删除" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("此操作无法撤销");

    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "确认删除" }))
      .not.toBeInTheDocument();

    fireEvent.click(within(providerEntry("Local Llama"))
      .getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(remove).toHaveBeenCalledWith("local-llama");
    expect(screen.queryByRole("button", { name: "确认删除" }))
      .not.toBeInTheDocument();
  });

  it("keeps the page read-only while offline", () => {
    openCustomProviders(customProvidersView(), { preferencesOnline: false });

    expect(screen.getByText(/本机服务离线/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建提供商" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "读取最新配置" })).toBeDisabled();
    expect(within(providerEntry("Local Llama"))
      .getByRole("button", { name: "编辑" })).toBeDisabled();
    expect(within(providerEntry("Local Llama"))
      .getByRole("button", { name: "删除" })).toBeDisabled();
  });
});
