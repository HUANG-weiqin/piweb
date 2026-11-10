import type { RefObject } from "react";
import type { ColorScheme, PublicState } from "../../../shared/protocol";
import { THEMES } from "../../lib/theme-registry";
import type {
  CustomProviderMutationResult,
  CustomProvidersView,
} from "./CustomProvidersSettingsPage";

export function appearanceSummary(
  colorScheme: ColorScheme,
  pending: boolean,
  unsaved: boolean,
): string {
  const status = pending ? "正在保存" : unsaved ? "尚未保存" : "已保存";
  return `${THEMES[colorScheme].name} · ${status}`;
}

export function modelConnectionsSummary(
  state: PublicState | undefined,
  online: boolean,
  preferencesOnline: boolean,
  refreshing: boolean,
): string {
  let summary: string;
  if (!preferencesOnline) {
    summary = state ? `离线 · ${modelStateSummary(state)}` : "离线 · 无可管理会话";
  } else if (!state) {
    summary = "当前会话未就绪";
  } else if (!online) {
    summary = `当前会话暂不可管理 · ${modelStateSummary(state)}`;
  } else if (state.busy) {
    summary = `会话运行中 · ${modelStateSummary(state)}`;
  } else {
    summary = modelStateSummary(state);
  }
  return refreshing ? `正在刷新模型 · ${summary}` : summary;
}

function modelStateSummary(state: PublicState): string {
  const providers = state.providers;
  const selectedModel = state.selectedModel;
  const currentModel = providers
    .flatMap((provider) => provider.models)
    .find((model) => (
      model.provider === selectedModel?.provider
      && model.id === selectedModel.id
    ));
  const model = currentModel?.name ?? selectedModel?.id;
  const configuredCount = providers.filter((provider) => provider.configured).length;
  const providerSummary = configuredCount > 0
    ? `${configuredCount} 个提供商已配置`
    : "尚无提供商凭据";
  return `${model ? `当前 ${model}` : "尚未选择模型"} · ${providerSummary}`;
}

interface SettingsHomeProps {
  appearance: string;
  modelConnections: string;
  customProviders: string;
  rowRefs: Record<"appearance" | "model-connections" | "custom-providers", RefObject<HTMLButtonElement | null>>;
  onOpen(route: "appearance" | "model-connections" | "custom-providers"): void;
}

export function customProvidersSummary(
  view: CustomProvidersView | undefined,
  online: boolean,
  refreshing: boolean,
  refreshError: string,
  mutationPending: boolean,
  mutationResult: CustomProviderMutationResult | undefined,
): string {
  const count = view
    ? `${view.providers.length} 个自定义提供商`
    : "尚未读取本机配置";
  const status = mutationPending
    ? "正在保存"
    : mutationResult && !mutationResult.ok
      ? "最近一次操作失败"
      : refreshError || view?.error
        ? "读取失败"
        : refreshing
          ? "正在读取"
          : "已保存";
  return online ? `${count} · ${status}` : `离线 · ${count}`;
}

export function SettingsHome({
  appearance,
  modelConnections,
  customProviders,
  rowRefs,
  onOpen,
}: SettingsHomeProps) {
  const menu = [{
    route: "appearance" as const,
    title: "外观",
    description: "调整 Pi Web 的配色与视觉偏好",
    summary: appearance,
  }, {
    route: "model-connections" as const,
    title: "模型连接",
    description: "管理本机凭据并查看可用模型",
    summary: modelConnections,
  }, {
    route: "custom-providers" as const,
    title: "自定义提供商",
    description: "编辑与 pi CLI 共享的 models.json",
    summary: customProviders,
  }];

  return <nav className="settings-home" aria-label="设置分类">
    {menu.map((item) => <button
      key={item.route}
      ref={rowRefs[item.route]}
      type="button"
      className="settings-menu-row"
      aria-label={`打开${item.title}设置`}
      onClick={() => onOpen(item.route)}
    >
      <span className="settings-menu-copy">
        <strong>{item.title}</strong>
        <small>{item.description}</small>
        <span className="settings-menu-summary">{item.summary}</span>
      </span>
      <span className="settings-menu-chevron" aria-hidden="true">›</span>
    </button>)}
  </nav>;
}