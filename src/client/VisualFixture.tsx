import { useState } from "react";
import type {
  ConversationRoleSnapshot,
  ConversationSummary,
  ProjectActivitySummary,
} from "../shared/protocol";
import type { ChatState } from "./chat/reducer";
import { Chat } from "./components/Chat";
import { createConversationTitleLookup } from "./lib/conversation-display";
import { usePhoneViewport } from "./lib/use-phone-viewport";
import {
  ConversationSidebar,
  conversationDisplayOrdinal,
} from "./components/ConversationSidebar";
import { WorkspaceRail, workspaceKey } from "./components/WorkspaceRail";

const ACTIVE_CWD = "E:\\workspaces\\piweb";
const ACTIVE_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE_TIMESTAMP = "2026-09-03T18:30:00.000Z";
const WORKSPACES = [
  ACTIVE_CWD,
  "E:\\workspaces\\runtime-lab",
  "E:\\workspaces\\interface-studio",
  "E:\\workspaces\\product-notes",
];

const role: ConversationRoleSnapshot = {
  id: "tech-lead",
  revision: 4,
  name: "Tech Lead",
  description: "负责边界、集成与最终判断",
  systemPrompt: "Visual fixture role snapshot.",
  model: { provider: "openai-codex", id: "gpt-5.6-luna" },
  compactionModel: null,
  defaultThinkingLevel: "high",
  defaultServiceTier: "priority",
  toolMode: "full_access",
  canManageSessions: true,
};

const conversationRole: NonNullable<ConversationSummary["role"]> = {
  id: role.id,
  revision: role.revision,
  name: role.name,
  description: role.description,
  model: role.model,
  compactionModel: role.compactionModel,
  defaultThinkingLevel: role.defaultThinkingLevel,
  defaultServiceTier: role.defaultServiceTier,
  toolMode: role.toolMode,
  canManageSessions: role.canManageSessions,
};

function conversation(
  id: string,
  name: string,
  preview: string,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    name,
    preview,
    createdAt: "2026-09-03T12:00:00.000Z",
    updatedAt: FIXTURE_TIMESTAMP,
    messageCount: 12,
    role: conversationRole,
    activity: { kind: "idle" },
    createdBy: { kind: "user" },
    ...overrides,
  };
}

const conversations: ConversationSummary[] = [
  conversation(
    ACTIVE_CONVERSATION_ID,
    "建立稳定的视觉验证基线",
    "正在捕获完整工作台状态",
    {
      activity: { kind: "running", runId: "run-visual-fixture" },
      messageCount: 18,
    },
  ),
  conversation(
    "22222222-2222-4222-8222-222222222222",
    "审查布局与滚动契约",
    "等待主会话提交固定截图",
    {
      rootConversationId: ACTIVE_CONVERSATION_ID,
      role: { ...conversationRole, id: "reviewer", name: "Reviewer" },
      activity: {
        kind: "waiting",
        runId: "run-layout-review",
        targetConversationId: ACTIVE_CONVERSATION_ID,
        targetRunId: "run-visual-fixture",
      },
      attention: true,
      createdBy: {
        kind: "conversation",
        conversationId: ACTIVE_CONVERSATION_ID,
      },
    },
  ),
  conversation(
    "33333333-3333-4333-8333-333333333333",
    "核对组件状态覆盖",
    "已确认 Tasks 与工具卡片状态",
    {
      rootConversationId: ACTIVE_CONVERSATION_ID,
      role: { ...conversationRole, id: "explorer", name: "Explorer" },
      updatedAt: "2026-09-03T18:22:00.000Z",
      createdBy: {
        kind: "conversation",
        conversationId: ACTIVE_CONVERSATION_ID,
      },
    },
  ),
  conversation(
    "44444444-4444-4444-8444-444444444444",
    "运行桌面尺寸截图",
    "浏览器正在检查 1920 × 1080",
    {
      rootConversationId: ACTIVE_CONVERSATION_ID,
      role: { ...conversationRole, id: "executor", name: "Executor" },
      activity: { kind: "queued", runId: "run-capture" },
      temporary: true,
      createdBy: {
        kind: "conversation",
        conversationId: ACTIVE_CONVERSATION_ID,
      },
    },
  ),
  conversation(
    "55555555-5555-4555-8555-555555555555",
    "移动端溢出核对",
    "390 × 844 保持现有验证路径",
    { updatedAt: "2026-09-03T17:58:00.000Z", unread: true },
  ),
  conversation(
    "66666666-6666-4666-8666-666666666666",
    "模型与角色目录",
    "等待同伴确认生产配置",
    {
      updatedAt: "2026-09-03T16:35:00.000Z",
      activity: {
        kind: "waiting",
        runId: "run-model-review",
        targetCount: 1,
      },
    },
  ),
  conversation(
    "77777777-7777-4777-8777-777777777777",
    "历史验证记录",
    "默认 Setup smoke flow 保持不变",
    { updatedAt: "2026-09-02T15:10:00.000Z" },
  ),
];

const activityByWorkspace = new Map<string, ProjectActivitySummary>([
  [workspaceKey(WORKSPACES[0]!), {
    projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    cwd: WORKSPACES[0]!,
    busyConversationCount: 3,
    attentionConversationCount: 1,
  }],
  [workspaceKey(WORKSPACES[1]!), {
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    cwd: WORKSPACES[1]!,
    busyConversationCount: 1,
    attentionConversationCount: 0,
  }],
  [workspaceKey(WORKSPACES[2]!), {
    projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    cwd: WORKSPACES[2]!,
    busyConversationCount: 0,
    attentionConversationCount: 2,
  }],
]);

const DEFAULT_COMMITMENT_REASON = "只添加开发 fixture、截图入口与对应验证。";
const LONG_TOOL_OUTPUT = Array.from(
  { length: 28 },
  (_, index) => `${String(index + 1).padStart(2, "0")} | visual-ledger-check | ${index % 3 === 0 ? "PASS" : "STABLE"}`,
).join("\n");

function createChat(commitmentReason: string): ChatState {
  return {
  focus: {
    sessionId: "session-visual-fixture",
    conversationId: ACTIVE_CONVERSATION_ID,
    focusId: "focus-visual-fixture",
  },
  lastProjectionSeq: 42,
  items: [{
    kind: "compaction",
    id: "compaction-fixture",
    timestamp: "2026-09-03T18:10:00.000Z",
    tokensBefore: 326_400,
  }, {
    kind: "message",
    id: "message-follow-up",
    runId: "run-follow-up",
    role: "user",
    text: "继续：固定丰富状态，并生成两张桌面截图。",
    thinking: "",
    tools: [],
  }, {
    kind: "message",
    id: "message-active",
    runId: "run-visual-fixture",
    role: "assistant",
    text: "生产 DOM 与 CSS 边界已就位。\n\n编辑范围已经锁定，现在运行视觉验证。",
    thinking: "先核对入口、侧栏和 Chat 的真实组合，再锁定最小编辑面。",
    tools: [{
      id: "tool-read",
      name: "read",
      args: { path: "src/client/components/Chat.tsx" },
      result: { details: { lines: 911, truncated: false } },
      status: "done",
    }, {
      id: "tool-budget",
      name: "request_edit_budget",
      args: {
        fileCount: 5,
        reason: commitmentReason,
      },
      result: {
        details: {
          outcome: "edit_budget_granted",
          grantedFiles: 5,
          remainingFiles: 4,
        },
      },
      status: "done",
    }, {
      id: "tool-wait-review",
      name: "wait_for_session",
      args: {
        conversationId: "22222222-2222-4222-8222-222222222222",
        runId: "run-layout-review",
        singleWaitCommitment: "布局审查位于截图验收的关键路径。",
      },
      status: "pending",
    }, {
      id: "tool-ledger-read",
      name: "read",
      args: {
        path: "src/client/components/transcript/visual-ledger/DeeplyNestedOperationLedger.tsx",
        offset: 420,
        limit: 180,
      },
      result: { details: { lines: 180, truncated: false } },
      status: "done",
    }, {
      id: "tool-ledger-grep",
      name: "grep",
      args: { pattern: "assistant-activity-group", path: "src/client" },
      result: { details: { matches: 14, truncated: false } },
      status: "done",
    }, {
      id: "tool-ledger-find",
      name: "find",
      args: { pattern: "src/client/**/*.visual.tsx" },
      result: { details: { message: "Fixture-only pattern intentionally returned no production files." } },
      status: "error",
    }, {
      id: "tool-ledger-ls",
      name: "wait_for_session",
      args: {
        targets: [{
          conversationId: "33333333-3333-4333-8333-333333333333",
          runId: "run-component-audit",
        }, {
          conversationId: "77777777-7777-4777-8777-777777777777",
          runId: "run-history-audit",
        }],
      },
      result: {
        outcome: "settled",
        conversationId: "33333333-3333-4333-8333-333333333333",
        runId: "run-component-audit",
      },
      status: "done",
    }, {
      id: "tool-ledger-output",
      name: "bash",
      args: { command: "npm run test -- --run src/client/components/Message.test.tsx" },
      result: { content: [{ type: "text", text: LONG_TOOL_OUTPUT }] },
      status: "done",
    }, {
      id: "tool-capture",
      name: "bash",
      args: { command: "npm run visual:verify -- --fixture --surfaces A" },
      status: "running",
    }],
    parts: [{
      kind: "thinking",
      text: "先核对入口、侧栏和 Chat 的真实组合，再锁定最小编辑面。",
    }, {
      kind: "tool",
      toolId: "tool-read",
    }, {
      kind: "text",
      text: "生产 DOM 与 CSS 边界已就位。",
    }, {
      kind: "tool",
      toolId: "tool-budget",
    }, {
      kind: "text",
      text: "编辑范围已经锁定，现在运行视觉验证。",
    }, {
      kind: "tool",
      toolId: "tool-wait-review",
    }, {
      kind: "tool",
      toolId: "tool-ledger-read",
    }, {
      kind: "tool",
      toolId: "tool-ledger-grep",
    }, {
      kind: "tool",
      toolId: "tool-ledger-find",
    }, {
      kind: "tool",
      toolId: "tool-ledger-ls",
    }, {
      kind: "tool",
      toolId: "tool-ledger-output",
    }, {
      kind: "tool",
      toolId: "tool-capture",
    }],
    usage: {
      input: 4_120,
      output: 880,
      cacheRead: 24_600,
      cacheWrite: 0,
      total: 29_600,
    },
  }],
  };
}

const chat = createChat(DEFAULT_COMMITMENT_REASON);
const noOp = () => undefined;
const activeConversationOrdinal = conversationDisplayOrdinal(
  conversations,
  ACTIVE_CONVERSATION_ID,
);
const conversationTitleLookup = createConversationTitleLookup(
  conversations,
  false,
);

export function VisualFixture({
  commitmentReason,
  showComposerStates = false,
}: {
  commitmentReason?: string;
  showComposerStates?: boolean;
} = {}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const phoneViewport = usePhoneViewport();
  const [mobileScene, setMobileScene] = useState<"workspaces" | "conversations" | "chat">(
    "conversations",
  );
  const fixtureChat = commitmentReason === undefined
    ? chat
    : createChat(commitmentReason);

  return <div className="workbench" data-visual-fixture="populated-workbench">
    <WorkspaceRail
      workspaces={WORKSPACES}
      activeCwd={ACTIVE_CWD}
      unavailable={new Set([workspaceKey(WORKSPACES[3]!)])}
      activityByWorkspace={activityByWorkspace}
      activityCatalogTruncated={false}
      mobile={phoneViewport ? {
        hidden: mobileScene !== "workspaces",
        canGoBack: true,
        onBack: () => setMobileScene("conversations"),
      } : undefined}
      onSelect={() => setMobileScene("conversations")}
      onClose={noOp}
      onAdd={noOp}
    />
    <ConversationSidebar
      conversations={conversations}
      truncated={false}
      currentConversationId={ACTIVE_CONVERSATION_ID}
      focusedConversationId={ACTIVE_CONVERSATION_ID}
      scopeKey="visual-fixture"
      busyConversationId={ACTIVE_CONVERSATION_ID}
      collapsed={sidebarCollapsed}
      navigationEnabled
      actionsEnabled
      mobile={phoneViewport ? {
        hidden: mobileScene !== "conversations",
        onShowWorkspaces: () => setMobileScene("workspaces"),
        onShowCurrentConversation: () => setMobileScene("chat"),
      } : undefined}
      onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
      onSelect={() => setMobileScene("chat")}
      onCreate={noOp}
      onRename={noOp}
      onDelete={() => true}
    />
    <div
      className="workbench-main"
      hidden={phoneViewport && mobileScene !== "chat"}
    >
      <Chat
        chat={fixtureChat}
        observationSessionId="session-visual-fixture"
        busy
        activeRun={{ id: "run-visual-fixture", phase: "running" }}
        loopList={{
          armed: true,
          items: [{
            id: "task-boundary",
            text: "确认 fixture 不进入生产路径",
            status: "completed",
          }, {
            id: "task-components",
            text: "复用真实工作台组件与状态样式",
            status: "active",
          }, {
            id: "task-capture-wide",
            text: "捕获 1920 × 1080 截图",
            status: "pending",
          }, {
            id: "task-capture-standard",
            text: "捕获 1440 × 900 截图",
            status: "pending",
          }],
        }}
        sessionTokenUsage={{
          input: 98_200,
          output: 16_800,
          cacheRead: 197_000,
          cacheWrite: 0,
          total: 312_000,
        }}
        contextTokenCount={312_000}
        contextWindow={468_000}
        contextPercent={67}
        contextSource="measured"
        model={role.model}
        role={role}
        roles={[]}
        roleSwitchDisabled={false}
        roleSwitching={false}
        thinkingLevel="high"
        availableThinkingLevels={["off", "low", "medium", "high"]}
        serviceTiers={["auto", "priority", "flex"]}
        selectedServiceTier="priority"
        serviceTierBusy={false}
        compactionThresholdPercent={70}
        compactionThresholdBusy={false}
        cwd={ACTIVE_CWD}
        conversationContext={{
          rootTitle: "建立稳定的视觉验证基线",
          ordinal: activeConversationOrdinal,
          agentCount: 4,
        }}
        conversationTitleLookup={conversationTitleLookup}
        mobile={phoneViewport ? {
          title: "建立稳定的视觉验证基线",
          onBack: () => setMobileScene("conversations"),
          onShowConversations: () => setMobileScene("conversations"),
        } : undefined}
        online
        interactive
        conversationReady
        draft="检查两张截图中的层级、密度与状态辨识度。"
        submitting={false}
        pendingAdmissions={showComposerStates
          ? [{
            promptId: "prompt-visual-fixture",
            text: "先核对长路径与失败状态，再继续生成窄屏证据。",
          }]
          : []}
        promptNotice={showComposerStates
          ? "当前运行仍在处理；新指令会进入现有 steering 顺序。"
          : undefined}
        onDraftChange={noOp}
        onSend={noOp}
        onAbort={noOp}
        onSettings={noOp}
        onThinking={noOp}
        onServiceTier={noOp}
        onCompactionThreshold={() => true}
        onCompact={noOp}
        onSwitchRole={noOp}
        onChangeCwd={noOp}
        onOpenConversation={noOp}
        onRewind={noOp}
      />
    </div>
  </div>;
}
