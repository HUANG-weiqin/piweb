import { useEffect, useState, type ReactNode } from "react";
import type {
  ConversationRoleSnapshot,
  PublicProvider,
  PublicState,
  RoleTemplate,
} from "../shared/protocol";
import { AuthDialog } from "./components/AuthDialog";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ConversationRoleDialog } from "./components/ConversationRoleDialog";
import { DirectoryBrowserDialog } from "./components/DirectoryBrowserDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { RoleManagerDialog } from "./components/RoleManagerDialog";
import { RoleSelectionPage } from "./components/RoleSelectionPage";
import { Setup } from "./components/Setup";
import { WorkspacePlaceholder } from "./components/WorkspacePlaceholder";
import { useModalFocus } from "./lib/use-modal-focus";
import { VisualFixture } from "./VisualFixture";

const FIXTURE_CWD = "E:\\workspaces\\piweb";
const FIXTURE_TIMESTAMP = "2026-09-04T12:00:00.000Z";
const GROUP_A_SURFACES: readonly string[] = [
  "drawer",
  "drawer-appearance",
  "drawer-model-connections",
  "role-manager",
  "role-switch",
  "directory",
  "auth",
  "extension",
  "feedback",
  "context-tooltip",
  "activity-expanded",
  "commitment-expanded",
  "jump-latest",
  "jump-latest-focus",
  "composer-states",
];
const GROUP_B_SURFACES: readonly string[] = [
  "setup",
  "role-selection",
  "empty",
  "opening",
  "unavailable",
  "error-boundary",
];

const providers: PublicProvider[] = [{
  id: "openai",
  name: "OpenAI",
  configured: true,
  authSource: "environment",
  authLabel: "sk-proj-••••fixture",
  oauth: false,
  models: [{
    provider: "openai",
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    serviceTiers: ["auto", "priority", "flex"],
    input: ["text", "image"],
    contextWindow: 468_000,
    available: true,
  }, {
    provider: "openai",
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium"],
    serviceTiers: ["auto", "priority"],
    input: ["text"],
    contextWindow: 200_000,
    available: true,
  }, {
    provider: "openai",
    id: "retired-preview",
    name: "Retired Preview",
    reasoning: false,
    thinkingLevels: ["off"],
    input: ["text"],
    contextWindow: 64_000,
    available: false,
  }],
}, {
  id: "anthropic",
  name: "Anthropic",
  configured: true,
  authSource: "oauth",
  authLabel: "订阅账户",
  oauth: true,
  models: [{
    provider: "anthropic",
    id: "claude-opus-4-1",
    name: "Claude Opus 4.1",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text", "image"],
    contextWindow: 200_000,
    available: true,
  }],
}];

const roles: RoleTemplate[] = [{
  id: "default",
  revision: 6,
  name: "Implementation Lead",
  description: "负责实现、验证与集成交付",
  systemPrompt: "Implement the approved design and verify the complete diff.",
  model: { provider: "openai", id: "gpt-5.6-luna" },
  compactionModel: null,
  defaultThinkingLevel: "high",
  defaultServiceTier: "priority",
  toolMode: "full_access",
  canManageSessions: true,
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  available: true,
}, {
  id: "22222222-2222-4222-8222-222222222222",
  revision: 3,
  name: "Read-only Reviewer",
  description: "审查边界、测试证据与回归风险",
  systemPrompt: "Inspect source and tests without modifying the project.",
  model: { provider: "anthropic", id: "claude-opus-4-1" },
  compactionModel: null,
  defaultThinkingLevel: "medium",
  defaultServiceTier: null,
  toolMode: "read_only",
  canManageSessions: false,
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  available: true,
}, {
  id: "33333333-3333-4333-8333-333333333333",
  revision: 2,
  name: "Legacy Explorer",
  description: "保留失效模型的历史角色模板",
  systemPrompt: "Map the existing repository without changing files.",
  model: { provider: "openai", id: "retired-preview" },
  compactionModel: null,
  defaultThinkingLevel: "off",
  defaultServiceTier: null,
  toolMode: "read_only",
  canManageSessions: false,
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  available: false,
  unavailableReason: "模型 retired-preview 当前不可用",
}];

const currentRole: ConversationRoleSnapshot = {
  id: roles[0]!.id,
  revision: roles[0]!.revision,
  name: roles[0]!.name,
  description: roles[0]!.description,
  systemPrompt: roles[0]!.systemPrompt,
  model: roles[0]!.model!,
  compactionModel: roles[0]!.compactionModel,
  defaultThinkingLevel: roles[0]!.defaultThinkingLevel,
  defaultServiceTier: roles[0]!.defaultServiceTier,
  toolMode: roles[0]!.toolMode,
  canManageSessions: roles[0]!.canManageSessions,
};

const drawerState: PublicState = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  projectId: "44444444-4444-4444-8444-444444444444",
  conversationId: "visual-secondary",
  focusId: "55555555-5555-4555-8555-555555555555",
  cwd: FIXTURE_CWD,
  busy: false,
  selectedModel: { provider: "openai", id: "gpt-5.6-luna" },
  selectedServiceTier: "priority",
  thinkingLevel: "high",
  toolMode: "full_access",
  availableThinkingLevels: ["off", "low", "medium", "high"],
  providers,
};

const LONG_COMMITMENT_REASON = [
  "验证真实展开披露在长内容下的正文密度、内部滚动与视口边界。",
  ...Array.from(
    { length: 24 },
    (_, index) => `边界行 ${String(index + 1).padStart(2, "0")} / 24 · 保持工具参数完整可读，不截断真实生产投影。`,
  ),
].join("\n");

const noOp = () => undefined;

function WorkbenchOverlay({
  children,
  commitmentReason,
  showComposerStates,
}: {
  children?: ReactNode;
  commitmentReason?: string;
  showComposerStates?: boolean;
}) {
  return <>
    <VisualFixture
      commitmentReason={commitmentReason}
      showComposerStates={showComposerStates}
    />
    {children}
  </>;
}

function DrawerSurface({ page = "home" }: {
  page?: "home" | "appearance" | "model-connections";
}) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (page === "home") return;
    const label = page === "appearance" ? "打开外观设置" : "打开模型连接设置";
    document.querySelector<HTMLButtonElement>(`.drawer button[aria-label="${label}"]`)?.click();
  }, [page]);

  return <WorkbenchOverlay>
    <SettingsDrawer
      state={drawerState}
      open={open}
      online
      preferencesOnline
      colorScheme="quiet-rebel"
      colorSchemePending={false}
      colorSchemeUnsaved={false}
      colorSchemeError=""
      settingResults={{}}
      onClose={() => setOpen(false)}
      onColorSchemeChange={noOp}
      onRetryColorScheme={noOp}
      onKey={() => undefined}
      onOAuth={noOp}
      onLogout={noOp}
      onRefresh={() => undefined}
      onConsumeSettingResult={noOp}
      onKeyDialogChange={noOp}
    />
  </WorkbenchOverlay>;
}

function RoleManagerSurface() {
  const [open, setOpen] = useState(true);

  return <WorkbenchOverlay>
    <RoleManagerDialog
      open={open}
      roles={roles}
      providers={providers}
      initialRoleId={roles[1]!.id}
      onClose={() => setOpen(false)}
      onCreate={noOp}
      onUpdate={noOp}
      onDelete={noOp}
    />
  </WorkbenchOverlay>;
}

function RoleSwitchSurface() {
  const [open, setOpen] = useState(true);

  return <WorkbenchOverlay>
    <ConversationRoleDialog
      open={open}
      role={currentRole}
      roles={roles}
      switchDisabled={false}
      switching={false}
      onSwitch={noOp}
      onClose={() => setOpen(false)}
    />
  </WorkbenchOverlay>;
}

function DirectorySurface() {
  const [open, setOpen] = useState(true);

  return <WorkbenchOverlay>
    {open && <DirectoryBrowserDialog
      listing={{
        path: FIXTURE_CWD,
        parentPath: "E:\\workspaces",
        directories: [{
          name: "docs",
          path: `${FIXTURE_CWD}\\docs`,
        }, {
          name: "packages",
          path: `${FIXTURE_CWD}\\packages`,
        }, {
          name: "src",
          path: `${FIXTURE_CWD}\\src`,
        }],
        truncated: false,
      }}
      loading={false}
      online
      onNavigate={noOp}
      onOpenStartup={noOp}
      onSelect={noOp}
      onClose={() => setOpen(false)}
    />}
  </WorkbenchOverlay>;
}

function AuthSurface() {
  const [open, setOpen] = useState(true);

  return <WorkbenchOverlay>
    {open && <AuthDialog
      requestId="66666666-6666-4666-8666-666666666666"
      request={{
        kind: "device",
        userCode: "PIWEB-4821",
        verificationUri: "https://example.invalid/device",
      }}
      progress="等待浏览器授权完成…"
      onRespond={() => setOpen(false)}
      onCancel={() => setOpen(false)}
    />}
  </WorkbenchOverlay>;
}

function ExtensionSurface() {
  const [open, setOpen] = useState(true);

  return <WorkbenchOverlay>
    {open && <ExtensionDialog
      pending={{
        requestId: "77777777-7777-4777-8777-777777777777",
        request: {
          kind: "select",
          title: "选择发布目标",
          options: ["本机预览", "共享测试环境", "生成静态报告"],
        },
      }}
      pendingCount={2}
      online
      onRespond={() => {
        setOpen(false);
        return true;
      }}
    />}
  </WorkbenchOverlay>;
}

function FeedbackSurface() {
  const [showError, setShowError] = useState(true);

  return <WorkbenchOverlay>
    <div
      className="banner transition-status-overlay"
      role="status"
      aria-label="正在同步会话…"
    >
      正在同步会话…
    </div>
    <div className="toast-stack">
      <div className="toast notice-toast warning" role="status">
        模型目录来自固定视觉样本，请核对后再继续。
      </div>
      {showError && <div className="toast error-toast" role="alert">
        <span>远程模型目录刷新失败（固定视觉样本）。</span>
        <button
          type="button"
          className="toast-close"
          aria-label="关闭错误"
          onClick={() => setShowError(false)}
        >×</button>
      </div>}
    </div>
  </WorkbenchOverlay>;
}

function ContextTooltipSurface() {
  return <WorkbenchOverlay />;
}

function CommitmentExpandedSurface() {
  return <WorkbenchOverlay commitmentReason={LONG_COMMITMENT_REASON} />;
}

function ComposerStatesSurface() {
  return <WorkbenchOverlay showComposerStates />;
}

function SetupSurface() {
  const [cwd, setCwd] = useState(FIXTURE_CWD);
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  const focusRef = useModalFocus<HTMLElement>(open, "secondary-setup", close);

  return <WorkbenchOverlay>
    {open && <div
      className="modal-backdrop workspace-setup-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={focusRef}
        className="workspace-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="开启工作区"
        tabIndex={-1}
      >
        <button
          type="button"
          className="workspace-setup-close"
          aria-label="关闭开启工作区"
          onClick={close}
        >×</button>
        <Setup
          cwd={cwd}
          online
          pickingDirectory={false}
          onCwdChange={setCwd}
          onPickDirectory={noOp}
          onStart={noOp}
        />
      </section>
    </div>}
  </WorkbenchOverlay>;
}

function FixtureError(): never {
  throw new Error("Secondary surface fixture render failure");
}

function renderSurface(surface: string): ReactNode {
  switch (surface) {
    case "drawer":
      return <DrawerSurface />;
    case "drawer-appearance":
      return <DrawerSurface page="appearance" />;
    case "drawer-model-connections":
      return <DrawerSurface page="model-connections" />;
    case "role-manager":
      return <RoleManagerSurface />;
    case "role-switch":
      return <RoleSwitchSurface />;
    case "directory":
      return <DirectorySurface />;
    case "auth":
      return <AuthSurface />;
    case "extension":
      return <ExtensionSurface />;
    case "feedback":
      return <FeedbackSurface />;
    case "context-tooltip":
      return <ContextTooltipSurface />;
    case "activity-expanded":
    case "jump-latest":
    case "jump-latest-focus":
      return <WorkbenchOverlay />;
    case "commitment-expanded":
      return <CommitmentExpandedSurface />;
    case "composer-states":
      return <ComposerStatesSurface />;
    case "setup":
      return <SetupSurface />;
    case "role-selection":
      return <RoleSelectionPage
        roles={roles}
        onStart={noOp}
        onManageRole={noOp}
        onAddRole={noOp}
        onSettings={noOp}
      />;
    case "empty":
      return <WorkspacePlaceholder
        cwd=""
        unavailable={false}
        onOpen={noOp}
        onClose={noOp}
        onRetry={noOp}
      />;
    case "opening":
      return <WorkspacePlaceholder
        cwd={FIXTURE_CWD}
        unavailable={false}
        onOpen={noOp}
        onClose={noOp}
        onRetry={noOp}
      />;
    case "unavailable":
      return <WorkspacePlaceholder
        cwd={FIXTURE_CWD}
        unavailable
        onOpen={noOp}
        onClose={noOp}
        onRetry={noOp}
      />;
    case "error-boundary":
      return <ErrorBoundary><FixtureError /></ErrorBoundary>;
    default:
      return <main className="setup-shell">
        <section className="setup-card" role="alert">
          <div className="logo">π</div>
          <h1>未知的次级界面样本</h1>
          <p>
            请通过 <code>?fixture=secondary&amp;surface=&lt;name&gt;</code> 选择已支持的界面。
          </p>
          <pre>{surface || "(missing surface)"}</pre>
        </section>
      </main>;
  }
}

export function SecondarySurfaceFixture() {
  const surface = new URLSearchParams(window.location.search).get("surface") ?? "";
  const group = GROUP_A_SURFACES.includes(surface)
    ? "A"
    : GROUP_B_SURFACES.includes(surface)
      ? "B"
      : undefined;

  return <div
    data-visual-fixture="secondary-surfaces"
    data-visual-group={group}
    data-visual-surface={surface}
  >
    {renderSurface(surface)}
  </div>;
}
