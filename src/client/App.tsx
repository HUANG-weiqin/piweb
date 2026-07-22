import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  MAX_PROMPT_CHARACTERS,
  PROTOCOL_VERSION,
  type AcknowledgedSettingOperation,
  type AuthRequest,
  type ClientCommand,
  type ConversationRoleSnapshot,
  type ConversationSummary,
  type DirectoryListing,
  type PublicState,
  type ProjectActivitySummary,
  type RoleTemplate,
  type ServerEvent,
  type ThinkingLevel,
} from "../shared/protocol";
import { chatReducer, initialChatState } from "./chat/reducer";
import { AuthDialog } from "./components/AuthDialog";
import { Chat } from "./components/Chat";
import { ConnectionDrawer } from "./components/ConnectionDrawer";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { DirectoryBrowserDialog } from "./components/DirectoryBrowserDialog";
import {
  ExtensionDialog,
  type PendingExtensionUI,
} from "./components/ExtensionDialog";
import { Setup } from "./components/Setup";
import {
  RoleManagerDialog,
  type PendingRoleOperation,
  type RoleDraft,
  type RoleOperationResult,
} from "./components/RoleManagerDialog";
import { RoleSelectionPage } from "./components/RoleSelectionPage";
import {
  WorkspaceRail,
  workspaceKey,
} from "./components/WorkspaceRail";
import { WorkspacePlaceholder } from "./components/WorkspacePlaceholder";
import { PiSocket } from "./lib/socket";
import { readStoredString, writeStoredString } from "./lib/storage";
import { useModalFocus } from "./lib/use-modal-focus";

const CWD_KEY = "piweb.lastCwd";
const WORKSPACES_KEY = "piweb.workspaces";
const MAX_WORKSPACES = 30;
const MAX_QUEUED_PROMPTS = 20;
const RESUME_REFRESH_DELAY_MS = 16;

interface InitialWorkspaceState {
  workspaces: string[];
  activeCwd: string;
}

function loadInitialWorkspaceState(): InitialWorkspaceState {
  const legacyCwd = readStoredString(CWD_KEY).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readStoredString(WORKSPACES_KEY) || "[]");
  } catch {
    parsed = [];
  }
  const workspaces: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(parsed)) {
    for (const value of parsed) {
      if (typeof value !== "string" || !value.trim()) continue;
      const cwd = value.trim();
      const key = workspaceKey(cwd);
      if (seen.has(key)) continue;
      seen.add(key);
      workspaces.push(cwd);
      if (workspaces.length === MAX_WORKSPACES) break;
    }
  }
  if (legacyCwd && !seen.has(workspaceKey(legacyCwd))) {
    workspaces.unshift(legacyCwd);
    if (workspaces.length > MAX_WORKSPACES) workspaces.pop();
  }
  const activeCwd = workspaces.find(
    (cwd) => workspaceKey(cwd) === workspaceKey(legacyCwd),
  ) ?? workspaces[0] ?? "";
  return { workspaces, activeCwd };
}

interface PendingPrompt extends ActiveFocus {
  workspaceKey: string;
  runId: string;
  text: string;
  queueIds?: string[];
}

interface PendingGuidance extends ActiveFocus {
  workspaceKey: string;
  commandId: string;
  runId: string;
  queueIds: string[];
}

interface QueuedPrompt {
  id: string;
  text: string;
  status: "queued" | "attention";
}

interface PendingConversationDeletion {
  commandId: string;
  workspaceKey: string;
  projectId: string;
  conversationId: string;
}

interface PendingConversationTruncation {
  commandId: string;
  conversationId: string;
  messageId: string;
}

interface PendingCompactionThreshold {
  commandId: string;
}

interface PendingContextCompaction extends ActiveFocus {
  commandId: string;
  workspaceKey: string;
}

interface PendingConversationRoleSwitch {
  commandId: string;
  roleId: string;
}

interface DirectoryBrowserState {
  commandId: string;
  listing?: DirectoryListing;
  error: string;
}

interface ActiveFocus {
  sessionId: string;
  projectId: string;
  conversationId: string;
  focusId: string;
}

function conversationScopeKey(
  workspace: string,
  projectId: string,
  conversationId: string,
): string {
  return `${workspace}\u0000${projectId}\u0000${conversationId}`;
}

const UNCONFIRMED_PROMPT_NOTICE =
  "发送状态未确认。内容已保留；请先查看恢复后的对话，确认没有出现后再重试。";

interface PendingFocus {
  commandId: string;
  operation: "initialize" | "focus_conversation" | "create_conversation";
  sourceFocus?: ActiveFocus;
  sourceReady?: boolean;
}

interface ConversationOperation {
  commandId: string;
  workspaceKey: string;
  projectId: string;
  conversationId: string;
}

class ConversationOperationRegistry<T extends ConversationOperation> {
  private readonly byConversation = new Map<string, T>();

  private keyOf(
    focus: Pick<ConversationOperation, "workspaceKey" | "projectId" | "conversationId">,
  ): string {
    return conversationScopeKey(
      focus.workspaceKey,
      focus.projectId,
      focus.conversationId,
    );
  }

  set(operation: T): void {
    this.byConversation.set(this.keyOf(operation), operation);
  }

  get(
    focus: Pick<ConversationOperation, "workspaceKey" | "projectId" | "conversationId">,
  ): T | undefined {
    return this.byConversation.get(this.keyOf(focus));
  }

  find(commandId: string): T | undefined {
    return [...this.byConversation.values()].find(
      (operation) => operation.commandId === commandId,
    );
  }

  delete(operation: T): boolean {
    const key = this.keyOf(operation);
    if (this.byConversation.get(key)?.commandId !== operation.commandId) {
      return false;
    }
    return this.byConversation.delete(key);
  }

  clear(): void {
    this.byConversation.clear();
  }

  values(): T[] {
    return [...this.byConversation.values()];
  }
}

type RoleCommandInput =
  | { type: "create_role"; role: RoleDraft }
  | {
      type: "update_role";
      roleId: string;
      expectedRevision: number;
      role: RoleDraft;
    }
  | {
      type: "delete_role";
      roleId: string;
      expectedRevision: number;
    };

export function App() {
  const [initialWorkspaces] = useState(loadInitialWorkspaceState);
  const [transportOnline, setTransportOnline] = useState(false);
  const [protocolReady, setProtocolReady] = useState(false);
  const [protocolError, setProtocolError] = useState("");
  const [workspaces, setWorkspaces] = useState(initialWorkspaces.workspaces);
  const workspacesRef = useRef(initialWorkspaces.workspaces);
  const [projectActivityByWorkspace, setProjectActivityByWorkspace] =
    useState<Map<string, ProjectActivitySummary>>(new Map());
  const [projectActivityTruncated, setProjectActivityTruncated] =
    useState(false);
  const [unavailableWorkspaceKeys, setUnavailableWorkspaceKeys] =
    useState<Set<string>>(new Set());
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupCwd, setSetupCwd] = useState(initialWorkspaces.activeCwd);
  const [activeCwd, setActiveCwd] = useState(initialWorkspaces.activeCwd);
  const activeCwdRef = useRef(initialWorkspaces.activeCwd);
  const sessionIdRef = useRef("");
  const projectIdRef = useRef("");
  const conversationIdRef = useRef("");
  const focusRef = useRef<ActiveFocus | undefined>(undefined);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>();
  const pendingFocusRef = useRef<PendingFocus | undefined>(undefined);
  const pendingFocusedStateRef = useRef<PublicState | undefined>(undefined);
  const authFlowIdRef = useRef("");
  const [draft, setDraft] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt>();
  const pendingPromptRef = useRef<PendingPrompt | undefined>(undefined);
  const unconfirmedPromptByConversationRef = useRef(new Map<string, string>());
  const [pendingGuidance, setPendingGuidance] = useState<PendingGuidance>();
  const pendingGuidanceRef =
    useRef<PendingGuidance | undefined>(undefined);
  const pendingGuidanceRegistryRef =
    useRef(new ConversationOperationRegistry<PendingGuidance>());
  const [queuedPrompts, setQueuedPromptsState] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const queuedPromptsByConversationRef =
    useRef(new Map<string, QueuedPrompt[]>());
  const [pendingConversationDeletion, setPendingConversationDeletionState] =
    useState<PendingConversationDeletion>();
  const pendingConversationDeletionRef =
    useRef<PendingConversationDeletion | undefined>(undefined);
  const [pendingConversationTruncation, setPendingConversationTruncationState] =
    useState<PendingConversationTruncation>();
  const pendingConversationTruncationRef =
    useRef<PendingConversationTruncation | undefined>(undefined);
  const [pendingCompactionThreshold, setPendingCompactionThresholdState] =
    useState<PendingCompactionThreshold>();
  const pendingCompactionThresholdRef =
    useRef<PendingCompactionThreshold | undefined>(undefined);
  const [pendingContextCompaction, setPendingContextCompactionState] =
    useState<PendingContextCompaction>();
  const pendingContextCompactionRef =
    useRef<PendingContextCompaction | undefined>(undefined);
  const pendingContextCompactionRegistryRef =
    useRef(new ConversationOperationRegistry<PendingContextCompaction>());
  const [pendingConversationRoleSwitch, setPendingConversationRoleSwitchState] =
    useState<PendingConversationRoleSwitch>();
  const pendingConversationRoleSwitchRef =
    useRef<PendingConversationRoleSwitch | undefined>(undefined);
  const [directoryBrowser, setDirectoryBrowserState] = useState<DirectoryBrowserState>();
  const directoryBrowserRef = useRef<DirectoryBrowserState | undefined>(undefined);
  const [promptNotice, setPromptNotice] = useState("");
  const [outstandingRunId, setOutstandingRunId] = useState("");
  const outstandingRunIdRef = useRef("");
  const [state, setState] = useState<PublicState>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [conversationRole, setConversationRole] =
    useState<ConversationRoleSnapshot>();
  const [conversationIndexTruncated, setConversationIndexTruncated] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [conversationReady, setConversationReady] = useState(false);
  const conversationReadyRef = useRef(false);
  const [drawer, setDrawer] = useState(false);
  const [roleManagerOpen, setRoleManagerOpen] = useState(false);
  const [roleManagerInitialRoleId, setRoleManagerInitialRoleId] =
    useState<string | null>();
  const [selectingRole, setSelectingRole] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pendingRoleOperation, setPendingRoleOperation] =
    useState<PendingRoleOperation>();
  const pendingRoleOperationRef = useRef<PendingRoleOperation | undefined>(undefined);
  const [roleOperationResult, setRoleOperationResult] =
    useState<RoleOperationResult>();
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [settingResult, setSettingResult] = useState<{
    operation: AcknowledgedSettingOperation;
    commandId: string;
    ok: boolean;
    message: string;
  }>();
  const [auth, setAuth] = useState<{ requestId?: string; request?: AuthRequest; progress?: string }>({});
  const [extensionUI, setExtensionUI] = useState<PendingExtensionUI[]>([]);
  const [notification, setNotification] = useState<{
    id: number;
    level: "info" | "warning" | "error";
    message: string;
  }>();
  const notificationIdRef = useRef(0);
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const socketRef = useRef<PiSocket | undefined>(undefined);
  const socketEpochRef = useRef(0);
  const autoOpened = useRef(false);

  const updateOutstandingRunId = (runId: string) => {
    outstandingRunIdRef.current = runId;
    setOutstandingRunId(runId);
  };
  const updatePendingPrompt = (prompt: PendingPrompt | undefined) => {
    pendingPromptRef.current = prompt;
    setPendingPrompt(prompt);
  };
  const currentWorkspaceKey = () => workspaceKey(activeCwdRef.current);
  const conversationKey = (
    focus: Pick<ActiveFocus, "projectId" | "conversationId">,
  ) => conversationScopeKey(
    currentWorkspaceKey(),
    focus.projectId,
    focus.conversationId,
  );
  const pendingConversationKey = (
    focus: Pick<ActiveFocus, "projectId" | "conversationId"> & { workspaceKey: string },
  ) => conversationScopeKey(
    focus.workspaceKey,
    focus.projectId,
    focus.conversationId,
  );
  const unconfirmedPromptKey = (focus: Pick<ActiveFocus, "projectId" | "conversationId">) =>
    conversationKey(focus);
  const showUnconfirmedPrompt = (focus: ActiveFocus | undefined) => {
    if (!focus) return;
    const text = unconfirmedPromptByConversationRef.current.get(
      unconfirmedPromptKey(focus),
    );
    if (!text) return;
    setDraft(text);
    setPromptNotice(UNCONFIRMED_PROMPT_NOTICE);
  };
  const rememberUnconfirmedPrompt = (pending: PendingPrompt) => {
    if (pending.queueIds) return;
    unconfirmedPromptByConversationRef.current.set(
      pendingConversationKey(pending),
      pending.text,
    );
  };
  const forgetUnconfirmedPrompt = (
    focus: Pick<ActiveFocus, "projectId" | "conversationId"> & { workspaceKey?: string },
  ) => {
    unconfirmedPromptByConversationRef.current.delete(
      focus.workspaceKey
        ? pendingConversationKey({
            ...focus,
            workspaceKey: focus.workspaceKey,
          })
        : unconfirmedPromptKey(focus),
    );
  };
  const rememberWorkspace = (cwd: string) => {
    const current = workspacesRef.current;
    const key = workspaceKey(cwd);
    const existingIndex = current.findIndex(
      (candidate) => workspaceKey(candidate) === key,
    );
    const next = existingIndex === -1
      ? [...current, cwd].slice(-MAX_WORKSPACES)
      : current.map((candidate, index) =>
          index === existingIndex ? cwd : candidate
        );
    workspacesRef.current = next;
    setWorkspaces(next);
    writeStoredString(WORKSPACES_KEY, JSON.stringify(next));
  };
  const markWorkspaceAvailable = (cwd: string) => {
    const key = workspaceKey(cwd);
    setUnavailableWorkspaceKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };
  const markWorkspaceUnavailable = (cwd: string) => {
    const key = workspaceKey(cwd);
    setUnavailableWorkspaceKeys((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  };
  const updatePendingGuidanceProjection = (
    guidance: PendingGuidance | undefined,
  ) => {
    pendingGuidanceRef.current = guidance;
    setPendingGuidance(guidance);
  };
  const showPendingGuidance = (focus: ActiveFocus | undefined) => {
    updatePendingGuidanceProjection(focus
      ? pendingGuidanceRegistryRef.current.get({
          ...focus,
          workspaceKey: currentWorkspaceKey(),
        })
      : undefined);
  };
  const addPendingGuidance = (guidance: PendingGuidance) => {
    pendingGuidanceRegistryRef.current.set(guidance);
    const currentFocus = focusRef.current;
    if (currentFocus && queuedPromptKey(currentFocus) === queuedPromptKey(guidance)) {
      updatePendingGuidanceProjection(guidance);
    }
  };
  const removePendingGuidance = (guidance: PendingGuidance) => {
    if (!pendingGuidanceRegistryRef.current.delete(guidance)) return false;
    const currentFocus = focusRef.current;
    if (currentFocus && queuedPromptKey(currentFocus) === queuedPromptKey(guidance)) {
      updatePendingGuidanceProjection(undefined);
    }
    return true;
  };
  const clearAllPendingGuidance = () => {
    pendingGuidanceRegistryRef.current.clear();
    updatePendingGuidanceProjection(undefined);
  };
  const findPendingGuidance = (commandId: string) =>
    pendingGuidanceRegistryRef.current.find(commandId);
  const queuedPromptKey = (
    focus: Pick<ActiveFocus, "projectId" | "conversationId"> & { workspaceKey?: string },
  ) => focus.workspaceKey
    ? pendingConversationKey({
        ...focus,
        workspaceKey: focus.workspaceKey,
      })
    : conversationKey(focus);
  const updateQueuedPromptsForConversation = (
    focus: Pick<ActiveFocus, "projectId" | "conversationId"> & { workspaceKey?: string },
    update: QueuedPrompt[] | ((current: QueuedPrompt[]) => QueuedPrompt[]),
  ) => {
    const key = queuedPromptKey(focus);
    const current = queuedPromptsByConversationRef.current.get(key) ?? [];
    const next = typeof update === "function" ? update(current) : update;
    if (next.length === 0) {
      queuedPromptsByConversationRef.current.delete(key);
    } else {
      queuedPromptsByConversationRef.current.set(key, next);
    }
    const currentFocus = focusRef.current;
    if (currentFocus && queuedPromptKey(currentFocus) === key) {
      queuedPromptsRef.current = next;
      setQueuedPromptsState(next);
    }
  };
  const updateQueuedPrompts = (
    update: QueuedPrompt[] | ((current: QueuedPrompt[]) => QueuedPrompt[]),
  ) => {
    const focus = focusRef.current;
    if (!focus) return;
    updateQueuedPromptsForConversation(focus, update);
  };
  const showQueuedPrompts = (
    focus:
      | (Pick<ActiveFocus, "projectId" | "conversationId"> & { workspaceKey?: string })
      | undefined,
  ) => {
    const next = focus
      ? queuedPromptsByConversationRef.current.get(queuedPromptKey(focus)) ?? []
      : [];
    queuedPromptsRef.current = next;
    setQueuedPromptsState(next);
  };
  const clearQueuedPromptsForConversation = (
    focus: Pick<ActiveFocus, "projectId" | "conversationId"> & { workspaceKey?: string },
  ) => {
    const key = queuedPromptKey(focus);
    queuedPromptsByConversationRef.current.delete(key);
    const currentFocus = focusRef.current;
    if (currentFocus && queuedPromptKey(currentFocus) === key) {
      queuedPromptsRef.current = [];
      setQueuedPromptsState([]);
    }
  };
  const updatePendingConversationDeletion = (
    pending: PendingConversationDeletion | undefined,
  ) => {
    pendingConversationDeletionRef.current = pending;
    setPendingConversationDeletionState(pending);
  };
  const updatePendingConversationTruncation = (
    pending: PendingConversationTruncation | undefined,
  ) => {
    pendingConversationTruncationRef.current = pending;
    setPendingConversationTruncationState(pending);
  };
  const updatePendingCompactionThreshold = (
    pending: PendingCompactionThreshold | undefined,
  ) => {
    pendingCompactionThresholdRef.current = pending;
    setPendingCompactionThresholdState(pending);
  };
  const updatePendingContextCompaction = (
    pending: PendingContextCompaction | undefined,
  ) => {
    pendingContextCompactionRef.current = pending;
    setPendingContextCompactionState(pending);
  };
  const showPendingContextCompaction = (focus: ActiveFocus | undefined) => {
    updatePendingContextCompaction(focus
      ? pendingContextCompactionRegistryRef.current.get({
          ...focus,
          workspaceKey: currentWorkspaceKey(),
        })
      : undefined);
  };
  const addPendingContextCompaction = (
    pending: PendingContextCompaction,
  ) => {
    pendingContextCompactionRegistryRef.current.set(pending);
    const currentFocus = focusRef.current;
    if (currentFocus && queuedPromptKey(currentFocus) === queuedPromptKey(pending)) {
      updatePendingContextCompaction(pending);
    }
  };
  const removePendingContextCompaction = (
    pending: PendingContextCompaction,
  ) => {
    if (!pendingContextCompactionRegistryRef.current.delete(pending)) {
      return false;
    }
    const currentFocus = focusRef.current;
    if (currentFocus && queuedPromptKey(currentFocus) === queuedPromptKey(pending)) {
      updatePendingContextCompaction(undefined);
    }
    return true;
  };
  const clearAllPendingContextCompactions = () => {
    pendingContextCompactionRegistryRef.current.clear();
    updatePendingContextCompaction(undefined);
  };
  const findPendingContextCompaction = (commandId: string) =>
    pendingContextCompactionRegistryRef.current.find(commandId);
  const updatePendingConversationRoleSwitch = (
    pending: PendingConversationRoleSwitch | undefined,
  ) => {
    pendingConversationRoleSwitchRef.current = pending;
    setPendingConversationRoleSwitchState(pending);
  };
  const updateDirectoryBrowser = (next: DirectoryBrowserState | undefined) => {
    directoryBrowserRef.current = next;
    setDirectoryBrowserState(next);
  };
  const updatePendingFocus = (pending: PendingFocus | undefined) => {
    if (pending) pendingFocusedStateRef.current = undefined;
    pendingFocusRef.current = pending;
    setPendingFocus(pending);
    setCreatingConversation(pending?.operation === "create_conversation");
  };
  const updatePendingRoleOperation = (
    pending: PendingRoleOperation | undefined,
  ) => {
    pendingRoleOperationRef.current = pending;
    setPendingRoleOperation(pending);
  };
  const matchesFocus = (
    sessionId: string,
    conversationId: string | undefined,
    focusId: string | undefined,
  ) => {
    const focus = focusRef.current;
    if (!focus) {
      return sessionId === sessionIdRef.current
        && conversationId === conversationIdRef.current
        && focusId === undefined;
    }
    return sessionId === focus.sessionId
      && conversationId === focus.conversationId
      && focusId === focus.focusId;
  };
  const attachFocus = (
    sessionId: string,
    projectId: string,
    conversationId: string | undefined,
    focusId: string | undefined,
  ) => {
    updatePendingCompactionThreshold(undefined);
    updatePendingConversationTruncation(undefined);
    const previousProjectId = projectIdRef.current;
    projectIdRef.current = projectId;
    if (!conversationId || !focusId) {
      focusRef.current = undefined;
      conversationIdRef.current = "";
      showQueuedPrompts(undefined);
      showPendingGuidance(undefined);
      showPendingContextCompaction(undefined);
      setConversationRole(undefined);
      setHistoryTruncated(false);
      updateConversationReady(false);
      setSelectingRole(true);
      dispatch({ type: "reset" });
      return;
    }
    const changedConversation = previousProjectId !== projectId
      || conversationIdRef.current !== conversationId;
    const focus = { sessionId, projectId, conversationId, focusId };
    focusRef.current = focus;
    conversationIdRef.current = conversationId;
    setConversationRole(undefined);
    setHistoryTruncated(false);
    updateConversationReady(false);
    setSelectingRole(false);
    if (changedConversation) {
      setDraft("");
      setPromptNotice("");
      updatePendingPrompt(undefined);
      showPendingGuidance(focus);
      showPendingContextCompaction(focus);
      showQueuedPrompts(focus);
      showUnconfirmedPrompt(focus);
    }
    updateOutstandingRunId("");
    dispatch({ type: "focus_changed", ...focus });
  };
  const acceptPendingPrompt = (sessionId: string, runId: string) => {
    const pending = pendingPromptRef.current;
    if (
      !pending
      || pending.sessionId !== sessionId
      || pending.runId !== runId
      || pending.projectId !== focusRef.current?.projectId
      || pending.conversationId !== focusRef.current?.conversationId
      || pending.focusId !== focusRef.current?.focusId
    ) return;
    dispatch({
      type: "prompt_accepted",
      runId,
      text: pending.text,
      ...(focusRef.current ?? {}),
    });
    if (pending.queueIds) {
      const acceptedIds = new Set(pending.queueIds);
      updateQueuedPrompts((current) =>
        current.filter(({ id }) => !acceptedIds.has(id))
      );
    } else {
      forgetUnconfirmedPrompt(pending);
      setDraft("");
    }
    setPromptNotice("");
    updatePendingPrompt(undefined);
  };
  const markPendingPromptUnconfirmed = () => {
    const pending = pendingPromptRef.current;
    if (!pending) return;
    updatePendingPrompt(undefined);
    const currentFocus = focusRef.current;
    const pendingIsCurrent = currentFocus?.projectId === pending.projectId
      && currentFocus.conversationId === pending.conversationId
      && currentFocus.focusId === pending.focusId;
    if (pending.queueIds) {
      const uncertainIds = new Set(pending.queueIds);
      updateQueuedPromptsForConversation(pending, (current) => current.map((queued) =>
        uncertainIds.has(queued.id)
          ? { ...queued, status: "attention" }
          : queued
      ));
      if (pendingIsCurrent) {
        setPromptNotice(
          "一批排队消息的发送状态未确认。请先检查恢复后的对话，再选择重试或移除。",
        );
      }
      return;
    }
    rememberUnconfirmedPrompt(pending);
    if (pendingIsCurrent) {
      setDraft(pending.text);
      setPromptNotice(UNCONFIRMED_PROMPT_NOTICE);
    }
  };
  const markPendingGuidanceUnconfirmed = () => {
    const pendingOperations = pendingGuidanceRegistryRef.current.values();
    if (pendingOperations.length === 0) return;
    for (const pending of pendingOperations) {
      const uncertainIds = new Set(pending.queueIds);
      updateQueuedPromptsForConversation(
        pending,
        (current) => current.map((queued) =>
          uncertainIds.has(queued.id)
            ? { ...queued, status: "attention" }
            : queued
        ),
      );
    }
    clearAllPendingGuidance();
    const currentFocus = focusRef.current;
    if (pendingOperations.some((pending) => (
      currentFocus?.projectId === pending.projectId
      && currentFocus.conversationId === pending.conversationId
    ))) {
      setPromptNotice(
        "一批引导消息的接收状态未确认。请先检查恢复后的对话，再选择重试或移除。",
      );
    }
  };
  const updateConversationReady = (ready: boolean) => {
    conversationReadyRef.current = ready;
    setConversationReady(ready);
  };
  const clearSessionProjection = () => {
    setState(undefined);
    setConversations([]);
    setRoles([]);
    setConversationRole(undefined);
    setConversationIndexTruncated(false);
    setHistoryTruncated(false);
    setExtensionUI([]);
    setNotification(undefined);
    setSettingResult(undefined);
    updatePendingCompactionThreshold(undefined);
    clearAllPendingContextCompactions();
    updatePendingConversationRoleSwitch(undefined);
    updatePendingConversationTruncation(undefined);
    updatePendingConversationDeletion(undefined);
    clearAllPendingGuidance();
    setRoleOperationResult(undefined);
    updatePendingRoleOperation(undefined);
    setSettingsDialogOpen(false);
    setRoleManagerOpen(false);
    setSelectingRole(false);
    showQueuedPrompts(undefined);
    updatePendingFocus(undefined);
    pendingFocusedStateRef.current = undefined;
    focusRef.current = undefined;
    projectIdRef.current = "";
    updateConversationReady(false);
  };
  const applyPublicState = (nextState: PublicState) => {
    const currentFocus = focusRef.current;
    if (nextState.conversationId !== conversationIdRef.current) {
      updateConversationReady(false);
    }
    setState(nextState);
    projectIdRef.current = nextState.projectId;
    if (!currentFocus) {
      conversationIdRef.current = nextState.conversationId ?? "";
      setSelectingRole(!nextState.conversationId);
    }
    if (nextState.activeRun?.id === outstandingRunIdRef.current) {
      updateOutstandingRunId("");
    }
    setActiveCwd(nextState.cwd);
    activeCwdRef.current = nextState.cwd;
    setSetupCwd(nextState.cwd);
    rememberWorkspace(nextState.cwd);
    markWorkspaceAvailable(nextState.cwd);
    writeStoredString(CWD_KEY, nextState.cwd);
    setError(nextState.registryError ?? "");
    if (
      nextState.conversationId
      && !nextState.selectedModel
      && !autoOpened.current
    ) {
      autoOpened.current = true;
      setDrawer(true);
    }
  };

  useEffect(() => {
    const epoch = ++socketEpochRef.current;
    const isCurrentSocket = () => socketEpochRef.current === epoch;
    const socket = new PiSocket((event: ServerEvent) => {
      if (!isCurrentSocket()) return;
      if (event.type === "hello") {
        if (event.protocolVersion !== PROTOCOL_VERSION) {
          const message = `协议版本不兼容：服务端 ${event.protocolVersion}，客户端 ${PROTOCOL_VERSION}`;
          setProtocolReady(false);
          setTransportOnline(false);
          setProjectActivityByWorkspace(new Map());
          setProjectActivityTruncated(false);
          setProtocolError(message);
          sessionIdRef.current = "";
          projectIdRef.current = "";
          conversationIdRef.current = "";
          focusRef.current = undefined;
          authFlowIdRef.current = "";
          updateDirectoryBrowser(undefined);
          markPendingPromptUnconfirmed();
          markPendingGuidanceUnconfirmed();
          updatePendingConversationDeletion(undefined);
          updatePendingConversationTruncation(undefined);
          updateOutstandingRunId("");
          setAuth({});
          clearSessionProjection();
          dispatch({ type: "reset" });
          setError(message);
          socket.close();
          return;
        }
        setProtocolError("");
        setProtocolReady(true);
        setSetupCwd((current) => current || event.startupCwd);
        if (activeCwdRef.current) {
          const sessionId = crypto.randomUUID();
          const commandId = crypto.randomUUID();
          sessionIdRef.current = sessionId;
          authFlowIdRef.current = "";
          updateOutstandingRunId("");
          setAuth({});
          dispatch({ type: "reset" });
          clearSessionProjection();
          updatePendingFocus({ commandId, operation: "initialize" });
          socket.send({
            type: "initialize",
            commandId,
            sessionId,
            cwd: activeCwdRef.current,
            conversation: conversationIdRef.current
              ? { kind: "open", conversationId: conversationIdRef.current }
              : { kind: "recent" },
          });
        }
      } else if (event.type === "directory_listing") {
        const current = directoryBrowserRef.current;
        if (!current || event.commandId !== current.commandId) return;
        updateDirectoryBrowser({
          commandId: "",
          error: "",
          listing: {
            path: event.path,
            parentPath: event.parentPath,
            directories: event.directories,
            truncated: event.truncated,
          },
        });
      } else if (event.type === "state") {
        if (!sessionIdRef.current || event.state.sessionId !== sessionIdRef.current) return;
        const currentFocus = focusRef.current;
        if (
          currentFocus
          && (
            event.state.conversationId !== currentFocus.conversationId
            || event.state.focusId !== currentFocus.focusId
          )
        ) {
          if (pendingFocusRef.current && event.state.conversationId && event.state.focusId) {
            pendingFocusedStateRef.current = event.state;
          }
          return;
        }
        if (
          !currentFocus
          && event.state.focusId
          && event.state.conversationId
        ) {
          if (pendingFocusRef.current) pendingFocusedStateRef.current = event.state;
          return;
        }
        applyPublicState(event.state);
      } else if (event.type === "focus_attached") {
        if (event.sessionId !== sessionIdRef.current) return;
        const pending = pendingFocusRef.current;
        if (
          !pending
          || pending.commandId !== event.commandId
          || pending.operation !== event.operation
        ) return;
        updatePendingFocus(undefined);
        attachFocus(
          event.sessionId,
          event.projectId,
          event.conversationId,
          event.focusId,
        );
        const pendingState = pendingFocusedStateRef.current;
        pendingFocusedStateRef.current = undefined;
        if (
          pendingState
          && pendingState.sessionId === event.sessionId
          && pendingState.projectId === event.projectId
          && pendingState.conversationId === event.conversationId
          && pendingState.focusId === event.focusId
        ) {
          applyPublicState(pendingState);
        } else {
          setState((current) => current
            ? {
                ...current,
                projectId: event.projectId,
                ...(event.conversationId && event.focusId
                  ? {
                      conversationId: event.conversationId,
                      focusId: event.focusId,
                    }
                  : {
                      conversationId: undefined,
                      focusId: undefined,
                      conversationName: undefined,
                      selectedModel: undefined,
                      activeRun: undefined,
                      busy: false,
                    }),
              }
            : current);
        }
      } else if (event.type === "focus_invalidated") {
        const focus = focusRef.current;
        if (
          !focus
          || event.sessionId !== sessionIdRef.current
          || event.sessionId !== focus.sessionId
          || event.projectId !== focus.projectId
          || event.conversationId !== focus.conversationId
          || event.focusId !== focus.focusId
        ) return;
        clearQueuedPromptsForConversation(event);
        unconfirmedPromptByConversationRef.current.delete(
          conversationScopeKey(
            currentWorkspaceKey(),
            event.projectId,
            event.conversationId,
          ),
        );
        attachFocus(
          event.sessionId,
          event.projectId,
          undefined,
          undefined,
        );
        setState((current) => current
          ? {
              ...current,
              conversationId: undefined,
              focusId: undefined,
              conversationName: undefined,
              selectedModel: undefined,
              activeRun: undefined,
              busy: false,
            }
          : current);
        setDraft("");
        setPromptNotice("");
        updatePendingPrompt(undefined);
        const deletedConversation = {
          workspaceKey: currentWorkspaceKey(),
          projectId: event.projectId,
          conversationId: event.conversationId,
        };
        const invalidatedGuidance = pendingGuidanceRegistryRef.current.get(
          deletedConversation,
        );
        if (invalidatedGuidance) removePendingGuidance(invalidatedGuidance);
        const invalidatedCompaction =
          pendingContextCompactionRegistryRef.current.get(
            deletedConversation,
          );
        if (invalidatedCompaction) {
          removePendingContextCompaction(invalidatedCompaction);
        }
        showQueuedPrompts(undefined);
        updateOutstandingRunId("");
        setExtensionUI([]);
      } else if (event.type === "role_catalog_snapshot") {
        if (
          event.sessionId !== sessionIdRef.current
          || (projectIdRef.current && event.projectId !== projectIdRef.current)
        ) return;
        projectIdRef.current = event.projectId;
        setRoles(event.roles);
      } else if (event.type === "project_activity_snapshot") {
        setProjectActivityByWorkspace(new Map(
          event.projects.map((project) => [workspaceKey(project.cwd), project]),
        ));
        setProjectActivityTruncated(event.truncated);
      } else if (event.type === "project_snapshot") {
        if (
          event.sessionId !== sessionIdRef.current
          || (projectIdRef.current && event.projectId !== projectIdRef.current)
        ) return;
        projectIdRef.current = event.projectId;
        setConversations(event.conversations);
        setConversationIndexTruncated(event.truncated);
      } else if (event.type === "conversation_snapshot") {
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        const focus = focusRef.current;
        if (focus) {
          dispatch({
            type: "hydrate",
            sessionId: focus.sessionId,
            conversationId: focus.conversationId,
            focusId: focus.focusId,
            items: event.items
              ?? (event.messages ?? []).map((message) => ({
                kind: "message" as const,
                ...message,
              })),
            projectionSeq: event.projectionSeq,
          });
        } else {
          dispatch({
            type: "hydrate",
            messages: event.messages ?? [],
            projectionSeq: event.projectionSeq,
          });
        }
        setConversationRole(event.role);
        setHistoryTruncated(event.truncated);
        if (!pendingFocusRef.current) updateConversationReady(true);
      } else if (event.type === "session_event") {
        if (!matchesFocus(
          event.sessionId,
          event.conversationId,
          event.focusId,
        )) return;
        if (event.event.type === "run_queued") {
          acceptPendingPrompt(event.sessionId, event.runId);
        }
        if (event.event.type === "run_finished" && event.runId === outstandingRunIdRef.current) {
          updateOutstandingRunId("");
        }
        dispatch({
          type: "session",
          runId: event.runId,
          event: event.event,
          projectionSeq: event.projectionSeq,
          ...(focusRef.current ?? {}),
        });
      } else if (event.type === "conversation_item") {
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        const focus = focusRef.current;
        if (!focus) return;
        dispatch({
          type: "conversation_item",
          sessionId: focus.sessionId,
          conversationId: focus.conversationId,
          focusId: focus.focusId,
          projectionSeq: event.projectionSeq,
          item: event.item,
        });
      } else if (event.type === "extension_ui_request") {
        if (event.sessionId !== sessionIdRef.current) return;
        setExtensionUI((current) => (
          current.some(({ requestId }) => requestId === event.requestId)
            ? current
            : [...current, { requestId: event.requestId, request: event.request }]
        ));
      } else if (event.type === "extension_ui_closed") {
        if (event.sessionId !== sessionIdRef.current) return;
        setExtensionUI((current) => current.filter(
          ({ requestId }) => requestId !== event.requestId,
        ));
      } else if (event.type === "extension_ui_notification") {
        if (event.sessionId !== sessionIdRef.current) return;
        setNotification({
          id: ++notificationIdRef.current,
          level: event.level,
          message: event.message,
        });
      } else if (event.type === "auth_request") {
        if (event.authFlowId !== authFlowIdRef.current) return;
        setAuth((current) => ({ ...current, requestId: event.requestId, request: event.request }));
      } else if (event.type === "auth_progress") {
        if (event.authFlowId !== authFlowIdRef.current) return;
        setAuth((current) => ({ ...current, progress: event.message }));
      } else if (event.type === "auth_complete") {
        if (event.authFlowId !== authFlowIdRef.current) return;
        authFlowIdRef.current = "";
        setAuth({});
      } else if (event.type === "command_complete") {
        if (event.sessionId !== sessionIdRef.current) return;
        if (event.operation === "steer") {
          const pending = findPendingGuidance(event.commandId);
          if (!pending || pending.sessionId !== event.sessionId) return;
          const acceptedIds = new Set(pending.queueIds);
          removePendingGuidance(pending);
          updateQueuedPromptsForConversation(
            pending,
            (current) => current.filter(({ id }) => !acceptedIds.has(id)),
          );
          if (
            focusRef.current?.projectId === pending.projectId
            && focusRef.current.conversationId === pending.conversationId
          ) {
            setPromptNotice("");
          }
          return;
        }
        if (event.operation === "set_compaction_threshold") {
          const pending = pendingCompactionThresholdRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingCompactionThreshold(undefined);
          return;
        }
        if (event.operation === "compact_context") {
          const pending = findPendingContextCompaction(event.commandId);
          if (!pending || pending.sessionId !== event.sessionId) return;
          removePendingContextCompaction(pending);
          if (conversationIdRef.current === pending.conversationId) {
            setNotification({
              id: ++notificationIdRef.current,
              level: "info",
              message: "上下文已压缩",
            });
          }
          return;
        }
        if (event.operation === "switch_conversation_role") {
          const pending = pendingConversationRoleSwitchRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationRoleSwitch(undefined);
          setNotification({
            id: ++notificationIdRef.current,
            level: "info",
            message: "会话角色已更换",
          });
          return;
        }
        if (event.operation === "delete_conversation") {
          const pending = pendingConversationDeletionRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationDeletion(undefined);
          clearQueuedPromptsForConversation(pending);
          unconfirmedPromptByConversationRef.current.delete(
            pendingConversationKey(pending),
          );
          if (
            focusRef.current?.projectId === pending.projectId
            && focusRef.current.conversationId === pending.conversationId
          ) {
            attachFocus(
              event.sessionId,
              projectIdRef.current,
              undefined,
              undefined,
            );
            setState((current) => current
              ? {
                  ...current,
                  conversationId: undefined,
                  focusId: undefined,
                  conversationName: undefined,
                  selectedModel: undefined,
                  activeRun: undefined,
                  busy: false,
                }
              : current);
            setDraft("");
            setPromptNotice("");
            updatePendingPrompt(undefined);
            const deletedGuidance =
              pendingGuidanceRegistryRef.current.get(pending);
            if (deletedGuidance) removePendingGuidance(deletedGuidance);
            const deletedCompaction =
              pendingContextCompactionRegistryRef.current.get(pending);
            if (deletedCompaction) {
              removePendingContextCompaction(deletedCompaction);
            }
            showQueuedPrompts(undefined);
            setExtensionUI([]);
          }
          setNotification({
            id: ++notificationIdRef.current,
            level: "info",
            message: "对话已删除",
          });
          return;
        }
        if (event.operation === "truncate_conversation") {
          const pending = pendingConversationTruncationRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationTruncation(undefined);
          setNotification({
            id: ++notificationIdRef.current,
            level: "info",
            message: "已回到所选消息之前",
          });
          return;
        }
        if (
          event.operation === "create_role"
          || event.operation === "update_role"
          || event.operation === "delete_role"
        ) {
          const pending = pendingRoleOperationRef.current;
          if (
            !pending
            || pending.operation !== event.operation
            || pending.commandId !== event.commandId
          ) return;
          pendingRoleOperationRef.current = undefined;
          setRoleOperationResult({
            ...pending,
            ok: true,
            message: event.operation === "delete_role"
              ? "角色已删除"
              : "角色已保存",
          });
          return;
        }
        setSettingResult({
          operation: event.operation,
          commandId: event.commandId,
          ok: true,
          message: "",
        });
      } else if (event.type === "error") {
        if (event.sessionId && event.sessionId !== sessionIdRef.current) return;
        const pendingGuidanceError = event.commandId
          && event.operation === "steer"
          ? findPendingGuidance(event.commandId)
          : undefined;
        const pendingCompactionError = event.commandId
          && event.operation === "compact_context"
          ? findPendingContextCompaction(event.commandId)
          : undefined;
        const settlesBackgroundOperation = Boolean(
          (
            pendingGuidanceError
            && pendingGuidanceError.sessionId === event.sessionId
            && pendingGuidanceError.conversationId === event.conversationId
            && pendingGuidanceError.focusId === event.focusId
            && pendingGuidanceError.runId === event.runId
          )
          || (
            pendingCompactionError
            && pendingCompactionError.sessionId === event.sessionId
            && pendingCompactionError.conversationId === event.conversationId
            && pendingCompactionError.focusId === event.focusId
          ),
        );
        if (
          (event.conversationId !== undefined || event.focusId !== undefined)
          && (
            event.sessionId === undefined
            || !matchesFocus(
              event.sessionId,
              event.conversationId,
              event.focusId,
            )
          )
          && !settlesBackgroundOperation
        ) return;
        if (event.authFlowId && event.authFlowId !== authFlowIdRef.current) return;
        if (event.operation === "browse_directory") {
          const current = directoryBrowserRef.current;
          if (!current || event.commandId !== current.commandId) return;
          updateDirectoryBrowser({
            ...current,
            commandId: "",
            error: event.message,
          });
          return;
        }
        if (
          event.operation === "set_compaction_threshold"
          && event.commandId
        ) {
          const pending = pendingCompactionThresholdRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingCompactionThreshold(undefined);
          setError(`修改自动压缩阈值失败：${event.message}`);
          return;
        }
        if (event.operation === "compact_context" && event.commandId) {
          const pending = findPendingContextCompaction(event.commandId);
          if (
            !pending
            || pending.sessionId !== event.sessionId
            || pending.conversationId !== event.conversationId
            || pending.focusId !== event.focusId
          ) return;
          removePendingContextCompaction(pending);
          if (conversationIdRef.current === pending.conversationId) {
            setError(`手动压缩上下文失败：${event.message}`);
          }
          return;
        }
        if (
          event.operation === "switch_conversation_role"
          && event.commandId
        ) {
          const pending = pendingConversationRoleSwitchRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationRoleSwitch(undefined);
          setError(`更换会话角色失败：${event.message}`);
          return;
        }
        if (
          event.operation === "delete_conversation"
          && event.commandId
        ) {
          const pending = pendingConversationDeletionRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationDeletion(undefined);
          setError(`删除对话失败：${event.message}`);
          return;
        }
        if (
          event.operation === "truncate_conversation"
          && event.commandId
        ) {
          const pending = pendingConversationTruncationRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationTruncation(undefined);
          setError(`回到此处失败：${event.message}`);
          return;
        }
        if (
          (event.operation === "initialize"
            || event.operation === "focus_conversation"
            || event.operation === "create_conversation")
          && event.commandId
        ) {
          const pending = pendingFocusRef.current;
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.operation !== event.operation
          ) return;
          updatePendingFocus(undefined);
          if (
            pending.sourceReady
            && pending.sourceFocus
            && focusRef.current?.sessionId === pending.sourceFocus.sessionId
            && focusRef.current.conversationId
              === pending.sourceFocus.conversationId
            && focusRef.current.focusId === pending.sourceFocus.focusId
          ) {
            updateConversationReady(true);
          }
          if (event.operation === "initialize" && activeCwdRef.current) {
            markWorkspaceUnavailable(activeCwdRef.current);
          }
          setError(event.message);
          return;
        }
        if (
          (event.operation === "create_role"
            || event.operation === "update_role"
            || event.operation === "delete_role")
          && event.commandId
        ) {
          const pending = pendingRoleOperationRef.current;
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.operation !== event.operation
          ) return;
          pendingRoleOperationRef.current = undefined;
          setRoleOperationResult({
            ...pending,
            ok: false,
            message: event.message,
          });
          return;
        }
        if (
          event.scope === "command"
          && event.operation === "steer"
          && event.commandId
        ) {
          const pending = findPendingGuidance(event.commandId);
          if (
            !pending
            || pending.sessionId !== event.sessionId
            || pending.conversationId !== event.conversationId
            || pending.focusId !== event.focusId
            || pending.runId !== event.runId
          ) return;
          const rejectedIds = new Set(pending.queueIds);
          removePendingGuidance(pending);
          updateQueuedPromptsForConversation(
            pending,
            (current) => current.map((queued) =>
              rejectedIds.has(queued.id)
                ? { ...queued, status: "attention" }
                : queued
            ),
          );
          if (
            focusRef.current?.projectId === pending.projectId
            && focusRef.current.conversationId === pending.conversationId
          ) {
            setPromptNotice(
              `引导消息未被当前任务接收：${event.message}。请重试或移除。`,
            );
          }
          return;
        }
        let promptRejectedBeforeAcceptance = false;
        if (
          event.scope === "command"
          && event.operation === "prompt"
          && event.runId
        ) {
          const pending = pendingPromptRef.current;
          if (
            pending
            && pending.sessionId === sessionIdRef.current
            && pending.runId === event.runId
            && pending.conversationId === event.conversationId
            && pending.focusId === event.focusId
          ) {
            promptRejectedBeforeAcceptance = true;
            updatePendingPrompt(undefined);
            if (pending.queueIds) {
              const queueIds = new Set(pending.queueIds);
              updateQueuedPromptsForConversation(
                pending,
                (current) => current.map((queued) =>
                  queueIds.has(queued.id)
                    ? { ...queued, status: "attention" }
                    : queued
                ),
              );
              setPromptNotice(
                `排队消息未被服务端接收：${event.message}。请重试或移除。`,
              );
            } else {
              setPromptNotice(
                `消息未被服务端接收：${event.message}。内容已保留，可以修改后重试。`,
              );
            }
          }
        }
        if (
          event.commandId
          && (event.operation === "set_api_key" || event.operation === "select_model")
        ) {
          if (!event.sessionId) {
            setError("设置命令响应缺少会话标识");
            return;
          }
          setSettingResult({
            operation: event.operation,
            commandId: event.commandId,
            ok: false,
            message: event.message,
          });
        } else {
          setError(event.message);
        }
        if (event.operation === "login_oauth" && event.authFlowId === authFlowIdRef.current) {
          authFlowIdRef.current = "";
          setAuth({});
        }
        if (event.scope === "command" && event.operation === "prompt" && activeCwdRef.current) {
          if (event.runId === outstandingRunIdRef.current) updateOutstandingRunId("");
          if (
            event.runId
            && event.sessionId
            && event.conversationId
            && event.focusId
            && !promptRejectedBeforeAcceptance
          ) {
            dispatch({
              type: "error",
              runId: event.runId,
              message: event.message,
              sessionId: event.sessionId,
              conversationId: event.conversationId,
              focusId: event.focusId,
            });
          }
        }
      }
    }, (connected) => {
      if (!isCurrentSocket()) return;
      setTransportOnline(connected);
      if (!connected) {
        setProtocolReady(false);
        setProjectActivityByWorkspace(new Map());
        setProjectActivityTruncated(false);
        setSettingResult(undefined);
        updateDirectoryBrowser(undefined);
        markPendingPromptUnconfirmed();
        markPendingGuidanceUnconfirmed();
        if (pendingConversationDeletionRef.current) {
          updatePendingConversationDeletion(undefined);
          setError("删除状态未确认，请检查项目对话列表后重试。");
        }
        if (pendingConversationTruncationRef.current) {
          updatePendingConversationTruncation(undefined);
          setError("回到此处的状态未确认，请检查恢复后的对话再重试。");
        }
        if (pendingConversationRoleSwitchRef.current) {
          updatePendingConversationRoleSwitch(undefined);
          setError("角色更换状态未确认，请检查恢复后的会话角色再重试。");
        }
        updateOutstandingRunId("");
        authFlowIdRef.current = "";
        setAuth({});
        setExtensionUI([]);
        setNotification(undefined);
        updateConversationReady(false);
      }
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      if (socketEpochRef.current === epoch) socketEpochRef.current++;
      socket.close();
    };
  }, []);

  useEffect(() => {
    let refreshTimer: number | undefined;
    const flush = () => {
      refreshTimer = undefined;
      if (
        !transportOnline
        || !protocolReady
        || document.visibilityState === "hidden"
        || pendingFocusRef.current
        || pendingPromptRef.current
        || outstandingRunIdRef.current
      ) {
        return;
      }
      const sessionId = sessionIdRef.current;
      const projectId = projectIdRef.current;
      if (!sessionId || !projectId) return;
      const focus = focusRef.current;
      socketRef.current?.send({
        type: "refresh_view",
        sessionId,
        projectId,
        ...(focus === undefined
          ? {}
          : {
              conversationId: focus.conversationId,
              focusId: focus.focusId,
            }),
      });
    };
    const schedule = () => {
      if (
        document.visibilityState === "hidden"
        || refreshTimer !== undefined
      ) return;
      refreshTimer = window.setTimeout(flush, RESUME_REFRESH_DELAY_MS);
    };
    window.addEventListener("focus", schedule);
    window.addEventListener("pageshow", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("pageshow", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [protocolReady, transportOnline]);

  useEffect(() => {
    if (!notification) return;
    const timer = window.setTimeout(() => {
      setNotification((current) => current?.id === notification.id ? undefined : current);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [notification]);

  const send = (command: ClientCommand): boolean => {
    if (!protocolReady) {
      setError("本地服务尚未完成协议握手");
      return false;
    }
    const ok = socketRef.current?.send(command) ?? false;
    if (!ok) setError("本地服务未连接");
    return ok;
  };
  useEffect(() => {
    if (!chat.projectionGap || !transportOnline || !protocolReady) return;
    const sessionId = sessionIdRef.current;
    const projectId = projectIdRef.current;
    const focus = focusRef.current;
    if (!sessionId || !projectId || !focus) return;
    updateConversationReady(false);
    socketRef.current?.send({
      type: "refresh_view",
      sessionId,
      projectId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
    });
  }, [chat.projectionGap, protocolReady, transportOnline]);
  const clearSettingResult = useCallback(() => setSettingResult(undefined), []);
  const browseDirectory = (path?: string) => {
    const current = directoryBrowserRef.current;
    const commandId = crypto.randomUUID();
    const next: DirectoryBrowserState = {
      commandId,
      listing: current?.listing,
      error: "",
    };
    updateDirectoryBrowser(next);
    setError("");
    if (!send({
      type: "browse_directory",
      commandId,
      ...(path ? { path } : {}),
    })) {
      updateDirectoryBrowser({
        ...next,
        commandId: "",
        error: "本地服务未连接",
      });
    }
  };
  const openDirectoryBrowser = () => {
    const path = setupCwd.trim();
    browseDirectory(path || undefined);
  };
  const initialize = (
    cwd: string,
    conversation: Extract<ClientCommand, { type: "initialize" }>["conversation"] = {
      kind: "recent",
    },
  ) => {
    const normalizedCwd = cwd.trim();
    const sessionId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    setError("");
    markPendingPromptUnconfirmed();
    markPendingGuidanceUnconfirmed();
    setDraft("");
    setPromptNotice("");
    clearSessionProjection();
    setSetupOpen(false);
    rememberWorkspace(normalizedCwd);
    writeStoredString(CWD_KEY, normalizedCwd);
    setActiveCwd(normalizedCwd);
    activeCwdRef.current = normalizedCwd;
    sessionIdRef.current = sessionId;
    projectIdRef.current = "";
    focusRef.current = undefined;
    conversationIdRef.current = conversation?.kind === "open"
      ? conversation.conversationId
      : "";
    authFlowIdRef.current = "";
    updateOutstandingRunId("");
    setAuth({});
    autoOpened.current = false;
    dispatch({ type: "reset" });
    updatePendingFocus({ commandId, operation: "initialize" });
    send({
      type: "initialize",
      commandId,
      sessionId,
      cwd: normalizedCwd,
      conversation,
    });
  };
  const sendPrompt = (text: string, queueIds?: string[]): boolean => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (!conversationReadyRef.current) return false;
    if (pendingConversationTruncationRef.current) return false;
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    if (!sessionId || !focus) return false;
    if (focus && focus.sessionId !== sessionId) return false;
    const runId = crypto.randomUUID();
    const pending: PendingPrompt = {
      ...focus,
      workspaceKey: currentWorkspaceKey(),
      runId,
      text: trimmed,
      ...(queueIds === undefined ? {} : { queueIds }),
    };
    setPromptNotice("");
    updatePendingPrompt(pending);
    updateOutstandingRunId(runId);
    const ok = send({
      type: "prompt",
      sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      runId,
      text: trimmed,
    });
    if (!ok) {
      updatePendingPrompt(undefined);
      updateOutstandingRunId("");
      if (queueIds) {
        const rejectedIds = new Set(queueIds);
        updateQueuedPrompts((current) => current.map((queued) =>
          rejectedIds.has(queued.id)
            ? { ...queued, status: "attention" }
            : queued
        ));
        setPromptNotice("排队消息未发送，内容已保留，请重试或移除。");
      } else {
        setPromptNotice("消息未发送，内容已保留，可以重试。");
      }
    }
    return ok;
  };
  const sendGuidance = (
    runId: string,
    text: string,
    queueIds: string[],
  ): boolean => {
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    if (
      !sessionId
      || !focus
      || focus.sessionId !== sessionId
      || pendingGuidanceRef.current
    ) return false;
    const pending: PendingGuidance = {
      ...focus,
      workspaceKey: currentWorkspaceKey(),
      commandId: crypto.randomUUID(),
      runId,
      queueIds,
    };
    addPendingGuidance(pending);
    setPromptNotice("");
    const ok = send({
      type: "steer",
      commandId: pending.commandId,
      sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      runId,
      text,
    });
    if (!ok) {
      const rejectedIds = new Set(queueIds);
      removePendingGuidance(pending);
      updateQueuedPrompts((current) => current.map((queued) =>
        rejectedIds.has(queued.id)
          ? { ...queued, status: "attention" }
          : queued
      ));
      setPromptNotice("引导消息未发送，内容已保留，请重试或移除。");
    }
    return ok;
  };
  const submitPrompt = (text: string): boolean => {
    const trimmed = text.trim();
    if (
      !trimmed
      || !conversationReadyRef.current
      || pendingConversationRoleSwitchRef.current
    ) return false;
    if (trimmed.length > MAX_PROMPT_CHARACTERS) {
      setPromptNotice(`单条消息最多 ${MAX_PROMPT_CHARACTERS.toLocaleString()} 个字符。`);
      return false;
    }
    const shouldQueue = (
      Boolean(state?.busy)
      || Boolean(outstandingRunIdRef.current)
      || Boolean(pendingPromptRef.current)
      || Boolean(pendingGuidanceRef.current)
      || queuedPromptsRef.current.length > 0
    );
    if (!shouldQueue) return sendPrompt(trimmed);
    if (queuedPromptsRef.current.length >= MAX_QUEUED_PROMPTS) {
      setPromptNotice(`待发送消息最多保留 ${MAX_QUEUED_PROMPTS} 条。`);
      return false;
    }
    updateQueuedPrompts((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        text: trimmed,
        status: "queued",
      },
    ]);
    setDraft("");
    setPromptNotice("");
    return true;
  };
  const removeQueuedPrompt = (queueId: string) => {
    if (
      pendingPromptRef.current?.queueIds?.includes(queueId)
      || pendingGuidanceRef.current?.queueIds.includes(queueId)
    ) return;
    updateQueuedPrompts((current) =>
      current.filter(({ id }) => id !== queueId)
    );
  };
  const retryQueuedPrompt = (queueId: string) => {
    updateQueuedPrompts((current) => current.map((queued) =>
      queued.id === queueId
        ? { ...queued, status: "queued" }
        : queued
    ));
    setPromptNotice("");
  };
  useEffect(() => {
    const batch: QueuedPrompt[] = [];
    let batchCharacters = 0;
    for (const queued of queuedPrompts) {
      if (queued.status !== "queued") break;
      const separatorCharacters = batch.length === 0 ? 0 : 2;
      if (
        batchCharacters + separatorCharacters + queued.text.length
        > MAX_PROMPT_CHARACTERS
      ) break;
      batch.push(queued);
      batchCharacters += separatorCharacters + queued.text.length;
    }
    const activeRun = state?.activeRun;
    if (
      batch.length === 0
      || !transportOnline
      || !protocolReady
      || !conversationReady
      || Boolean(pendingPrompt)
      || Boolean(pendingGuidance)
      || Boolean(pendingConversationTruncation)
      || Boolean(pendingConversationDeletion)
      || Boolean(pendingConversationRoleSwitch)
      || Boolean(pendingFocusRef.current)
    ) {
      return;
    }
    const text = batch.map(({ text }) => text).join("\n\n");
    const queueIds = batch.map(({ id }) => id);
    if (
      activeRun
      && (activeRun.phase === "running" || activeRun.phase === "waiting")
    ) {
      sendGuidance(activeRun.id, text, queueIds);
      return;
    }
    if (state?.busy || Boolean(outstandingRunId)) return;
    sendPrompt(text, queueIds);
  }, [
    conversationReady,
    outstandingRunId,
    pendingConversationDeletion,
    pendingConversationRoleSwitch,
    pendingConversationTruncation,
    pendingGuidance,
    pendingPrompt,
    protocolReady,
    queuedPrompts,
    state?.activeRun,
    state?.busy,
    transportOnline,
  ]);
  const abortCurrentRun = () => {
    if (!conversationReadyRef.current || pendingFocusRef.current) return;
    const runId = outstandingRunIdRef.current || state?.activeRun?.id;
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    if (sessionId && runId && focus) {
      send({
        type: "abort",
        sessionId,
        conversationId: focus.conversationId,
        focusId: focus.focusId,
        runId,
      });
    }
  };
  const focusConversation = (conversationId: string) => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId
      || pendingFocusRef.current
      || pendingConversationTruncationRef.current
      || pendingPromptRef.current
      || pendingConversationRoleSwitchRef.current
    ) return;
    if (focusRef.current?.conversationId === conversationId) {
      setSelectingRole(false);
      return;
    }
    const commandId = crypto.randomUUID();
    const sourceFocus = focusRef.current;
    const sourceReady = conversationReadyRef.current;
    updateConversationReady(false);
    updatePendingFocus({
      commandId,
      operation: "focus_conversation",
      ...(sourceFocus ? { sourceFocus } : {}),
      sourceReady,
    });
    setError("");
    if (!send({
      type: "focus_conversation",
      commandId,
      sessionId,
      conversationId,
    })) {
      updatePendingFocus(undefined);
      if (sourceReady && focusRef.current === sourceFocus) {
        updateConversationReady(true);
      }
    }
  };
  const createConversation = (roleId: string) => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId
      || pendingFocusRef.current
      || pendingConversationTruncationRef.current
      || pendingPromptRef.current
      || pendingGuidanceRef.current
      || pendingConversationRoleSwitchRef.current
    ) return;
    const commandId = crypto.randomUUID();
    updatePendingFocus({ commandId, operation: "create_conversation" });
    setError("");
    if (!send({
      type: "create_conversation",
      commandId,
      sessionId,
      roleId,
    })) {
      updatePendingFocus(undefined);
    }
  };
  const deleteConversation = (conversationId: string): boolean => {
    const sessionId = sessionIdRef.current;
    const conversation = conversations.find(({ id }) => id === conversationId);
    const projectId = projectIdRef.current;
    const deletingFocusedConversation =
      focusRef.current?.projectId === projectId
      && focusRef.current?.conversationId === conversationId;
    if (
      !sessionId
      || !projectId
      || !conversation
      || (conversation.activity?.kind ?? "idle") !== "idle"
      || (
        deletingFocusedConversation
        && (Boolean(state?.busy) || Boolean(outstandingRunIdRef.current))
      )
      || Boolean(
        pendingContextCompactionRegistryRef.current.get({
          workspaceKey: currentWorkspaceKey(),
          projectId,
          conversationId,
        }),
      )
      || pendingConversationDeletionRef.current
      || pendingConversationTruncationRef.current
      || pendingConversationRoleSwitchRef.current
      || pendingFocusRef.current
    ) {
      return false;
    }
    const commandId = crypto.randomUUID();
    const pending = {
      commandId,
      workspaceKey: currentWorkspaceKey(),
      projectId,
      conversationId,
    };
    updatePendingConversationDeletion(pending);
    setError("");
    if (send({
      type: "delete_conversation",
      commandId,
      sessionId,
      conversationId,
    })) {
      return true;
    }
    updatePendingConversationDeletion(undefined);
    return false;
  };
  const renameConversation = (conversationId: string, name: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    send({
      type: "rename_conversation",
      sessionId,
      conversationId,
      name,
    });
  };
  const truncateConversation = (messageId: string, text: string): boolean => {
    const focus = focusRef.current;
    if (
      !focus
      || !conversationReadyRef.current
      || Boolean(state?.busy)
      || Boolean(outstandingRunIdRef.current)
      || Boolean(pendingPromptRef.current)
      || Boolean(pendingGuidanceRef.current)
      || queuedPromptsRef.current.length > 0
      || Boolean(pendingConversationTruncationRef.current)
      || Boolean(pendingConversationDeletionRef.current)
    ) {
      return false;
    }
    const commandId = crypto.randomUUID();
    const pending = {
      commandId,
      conversationId: focus.conversationId,
      messageId,
    };
    updatePendingConversationTruncation(pending);
    setError("");
    if (send({
      type: "truncate_conversation",
      commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      messageId,
    })) {
      setDraft(text);
      setPromptNotice("");
      return true;
    }
    updatePendingConversationTruncation(undefined);
    return false;
  };
  const setThinkingLevel = (level: ThinkingLevel) => {
    if (!conversationReadyRef.current || pendingFocusRef.current) return;
    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "set_thinking", sessionId, level });
  };
  const setCompactionThreshold = (percent: number): boolean => {
    const focus = focusRef.current;
    if (
      !focus
      || !conversationReadyRef.current
      || pendingFocusRef.current
      || pendingCompactionThresholdRef.current
    ) return false;
    const commandId = crypto.randomUUID();
    updatePendingCompactionThreshold({
      commandId,
    });
    if (send({
      type: "set_compaction_threshold",
      commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      percent,
    })) return true;
    updatePendingCompactionThreshold(undefined);
    return false;
  };
  const compactContext = (): boolean => {
    const focus = focusRef.current;
    if (
      !focus
      || !conversationReadyRef.current
      || pendingContextCompactionRef.current
    ) return false;
    const pending = {
      ...focus,
      commandId: crypto.randomUUID(),
      workspaceKey: currentWorkspaceKey(),
    };
    addPendingContextCompaction(pending);
    if (send({
      type: "compact_context",
      commandId: pending.commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
    })) return true;
    removePendingContextCompaction(pending);
    return false;
  };
  const switchConversationRole = (roleId: string): boolean => {
    const focus = focusRef.current;
    if (
      !focus
      || !conversationReadyRef.current
      || Boolean(state?.busy)
      || Boolean(outstandingRunIdRef.current)
      || Boolean(pendingPromptRef.current)
      || Boolean(pendingGuidanceRef.current)
      || queuedPromptsRef.current.length > 0
      || Boolean(pendingConversationRoleSwitchRef.current)
      || Boolean(pendingConversationTruncationRef.current)
      || Boolean(pendingConversationDeletionRef.current)
    ) {
      return false;
    }
    const pending = {
      commandId: crypto.randomUUID(),
      roleId,
    };
    updatePendingConversationRoleSwitch(pending);
    setError("");
    if (send({
      type: "switch_conversation_role",
      commandId: pending.commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      roleId,
    })) return true;
    updatePendingConversationRoleSwitch(undefined);
    return false;
  };
  const beginRoleOperation = (
    operation: PendingRoleOperation["operation"],
    command: RoleCommandInput,
  ) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || pendingRoleOperationRef.current) return;
    const commandId = crypto.randomUUID();
    const pending = { operation, commandId };
    updatePendingRoleOperation(pending);
    setRoleOperationResult(undefined);
    setError("");
    if (!send({ ...command, commandId, sessionId } as ClientCommand)) {
      updatePendingRoleOperation(undefined);
    }
  };
  const switchWorkspace = (cwd: string) => {
    if (
      workspaceKey(cwd) === workspaceKey(activeCwdRef.current)
      && state
    ) {
      setSetupOpen(false);
      updateDirectoryBrowser(undefined);
      return;
    }
    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "close_session", sessionId });
    initialize(cwd);
  };
  const removeWorkspace = (cwd: string) => {
    const key = workspaceKey(cwd);
    const next = workspacesRef.current.filter(
      (candidate) => workspaceKey(candidate) !== key,
    );
    workspacesRef.current = next;
    setWorkspaces(next);
    writeStoredString(WORKSPACES_KEY, JSON.stringify(next));
    setUnavailableWorkspaceKeys((current) => {
      if (!current.has(key)) return current;
      const updated = new Set(current);
      updated.delete(key);
      return updated;
    });
    if (workspaceKey(activeCwdRef.current) !== key) return;

    const fallback = next.at(-1);
    if (fallback) {
      switchWorkspace(fallback);
      return;
    }

    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "close_session", sessionId });
    activeCwdRef.current = "";
    sessionIdRef.current = "";
    conversationIdRef.current = "";
    focusRef.current = undefined;
    writeStoredString(CWD_KEY, "");
    setActiveCwd("");
    setSetupCwd("");
    setError("");
    clearSessionProjection();
    dispatch({ type: "reset" });
  };
  const openWorkspaceDialog = () => {
    setSetupCwd(activeCwdRef.current || setupCwd);
    setSetupOpen(true);
    setDrawer(false);
    setRoleManagerOpen(false);
    if (!protocolError) setError("");
  };
  const closeWorkspaceDialog = () => {
    setSetupOpen(false);
    updateDirectoryBrowser(undefined);
  };
  const workspaceSetupFocusRef = useModalFocus<HTMLElement>(
    setupOpen && !directoryBrowser,
    setupOpen ? "workspace-setup" : "",
    closeWorkspaceDialog,
  );
  const online = transportOnline && protocolReady;
  const authModalVisible = Boolean(auth.request || auth.progress);
  const extensionPending = online
    && !authModalVisible
    && !settingsDialogOpen
    ? extensionUI[0]
    : undefined;
  const blockingModalVisible = Boolean(
    authModalVisible
    || extensionPending
    || setupOpen
  );
  const extensionDialog = <ExtensionDialog
    pending={extensionUI[0]}
    pendingCount={extensionUI.length}
    online={online}
    visible={Boolean(extensionPending)}
    onRespond={(requestId, response) => {
      const sessionId = sessionIdRef.current;
      return Boolean(
        sessionId
        && send({
          type: "extension_ui_response",
          sessionId,
          requestId,
          response,
        }),
      );
    }}
  />;
  const feedback = (notification || error) && <div className="toast-stack">
    {notification && <div
      className={`toast notice-toast ${notification.level}`}
      role="status"
    >
      {notification.message}
    </div>}
    {error && <div className="toast error-toast" role="alert">
      <span>{error}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭错误"
        onClick={() => setError("")}
      >×</button>
    </div>}
  </div>;

  const workspaceRail = <WorkspaceRail
    workspaces={workspaces}
    activeCwd={activeCwd}
    unavailable={unavailableWorkspaceKeys}
    activityByWorkspace={projectActivityByWorkspace}
    activityCatalogTruncated={projectActivityTruncated}
    onSelect={switchWorkspace}
    onAdd={openWorkspaceDialog}
  />;
  const workspaceSetupDialog = setupOpen && <div
    className="modal-backdrop workspace-setup-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeWorkspaceDialog();
    }}
  >
    <section
      ref={workspaceSetupFocusRef}
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
        onClick={closeWorkspaceDialog}
      >×</button>
      <Setup
        cwd={setupCwd}
        online={online}
        pickingDirectory={Boolean(directoryBrowser)}
        unavailableLabel={protocolError ? "协议不兼容" : undefined}
        onCwdChange={setSetupCwd}
        onPickDirectory={openDirectoryBrowser}
        onStart={switchWorkspace}
      />
    </section>
  </div>;
  const directoryBrowserDialog = directoryBrowser && <DirectoryBrowserDialog
    listing={directoryBrowser.listing}
    loading={Boolean(directoryBrowser.commandId)}
    error={directoryBrowser.error || undefined}
    online={online}
    onNavigate={browseDirectory}
    onOpenStartup={() => browseDirectory()}
    onSelect={(path) => {
      setSetupCwd(path);
      updateDirectoryBrowser(undefined);
    }}
    onClose={() => updateDirectoryBrowser(undefined)}
  />;

  if (!activeCwd || !state) return <>
    <div className="workbench">
      {workspaceRail}
      <ConversationSidebar
        conversations={[]}
        truncated={false}
        collapsed={sidebarCollapsed}
        online={false}
        onToggleCollapsed={setSidebarCollapsed}
        onSelect={() => undefined}
        onCreate={() => undefined}
        onRename={() => undefined}
        onDelete={() => false}
      />
      <WorkspacePlaceholder
        cwd={activeCwd}
        unavailable={unavailableWorkspaceKeys.has(workspaceKey(activeCwd))}
        onOpen={openWorkspaceDialog}
        onRemove={() => removeWorkspace(activeCwd)}
        onRetry={() => switchWorkspace(activeCwd)}
      />
    </div>
    {workspaceSetupDialog}
    {directoryBrowserDialog}
    {extensionDialog}
    {feedback}
  </>;

  const showRoleSelection = selectingRole || !state.conversationId;
  const conversationCompacting =
    state.compacting === true || Boolean(pendingContextCompaction);
  const switchingFocus = pendingFocus?.operation === "focus_conversation"
    || pendingFocus?.operation === "create_conversation";
  const visibleChat = switchingFocus ? initialChatState : chat;
  const visibleBusy = state.busy || Boolean(outstandingRunId);
  const visibleActiveRun = state.activeRun;
  const visibleConversationReady = switchingFocus ? false : conversationReady;

  return <>
    <div className="workbench">
      {workspaceRail}
      <ConversationSidebar
        conversations={conversations}
        truncated={conversationIndexTruncated}
        currentConversationId={showRoleSelection
          ? undefined
          : state.conversationId}
        busyConversationId={
          state.busy || outstandingRunId ? state.conversationId : undefined
        }
        collapsed={sidebarCollapsed}
        online={online}
        pendingDeletionId={pendingConversationDeletion?.conversationId}
        onToggleCollapsed={setSidebarCollapsed}
        onSelect={focusConversation}
        onCreate={() => setSelectingRole(true)}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />
      <div className="workbench-main">
        {showRoleSelection
          ? <RoleSelectionPage
              roles={roles}
              pending={creatingConversation}
              onStart={createConversation}
              onManageRole={(roleId) => {
                setRoleManagerInitialRoleId(roleId);
                setRoleManagerOpen(true);
              }}
              onAddRole={() => {
                setRoleManagerInitialRoleId(null);
                setRoleManagerOpen(true);
              }}
              onSettings={() => setDrawer(true)}
            />
          : <Chat
              chat={visibleChat}
              historyTruncated={historyTruncated}
              busy={visibleBusy}
              activeRun={visibleActiveRun}
              sessionTokenUsage={state.sessionTokenUsage}
              contextTokenCount={state.contextUsage?.tokens}
              contextWindow={state.contextUsage?.contextWindow}
              contextPercent={state.contextUsage?.percent}
              contextSource={state.contextUsage?.source}
              model={state.selectedModel}
              role={conversationRole}
              roles={roles}
              roleSwitchDisabled={
                state.busy
                || Boolean(outstandingRunId)
                || Boolean(pendingPrompt)
                || Boolean(pendingGuidance)
                || queuedPrompts.length > 0
                || Boolean(pendingConversationTruncation)
                || Boolean(pendingConversationDeletion)
                || conversationCompacting
              }
              roleSwitching={Boolean(pendingConversationRoleSwitch)}
              thinkingLevel={state.thinkingLevel}
              availableThinkingLevels={state.availableThinkingLevels}
              compactionThresholdPercent={
                state.compactionThresholdPercent
                ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT
              }
              compactionThresholdBusy={Boolean(pendingCompactionThreshold)}
              compacting={conversationCompacting}
              cwd={state.cwd}
              online={online}
              conversationReady={visibleConversationReady}
              draft={draft}
              submitting={Boolean(pendingPrompt && !pendingPrompt.queueIds)}
              queuedPrompts={queuedPrompts.map((queued) => ({
                ...queued,
                status: (
                  pendingPrompt?.queueIds?.includes(queued.id)
                  || pendingGuidance?.queueIds.includes(queued.id)
                )
                  ? "submitting"
                  : queued.status,
              }))}
              promptNotice={promptNotice || undefined}
              onDraftChange={(text) => {
                setDraft(text);
                const focus = focusRef.current;
                if (focus) {
                  const key = unconfirmedPromptKey(focus);
                  if (unconfirmedPromptByConversationRef.current.has(key)) {
                    if (text) {
                      unconfirmedPromptByConversationRef.current.set(key, text);
                    } else {
                      unconfirmedPromptByConversationRef.current.delete(key);
                    }
                  }
                }
                if (promptNotice) setPromptNotice("");
              }}
              onSend={submitPrompt}
              onRemoveQueuedPrompt={removeQueuedPrompt}
              onRetryQueuedPrompt={retryQueuedPrompt}
              onAbort={abortCurrentRun}
              onSettings={() => setDrawer(true)}
              onThinking={setThinkingLevel}
              onCompactionThreshold={setCompactionThreshold}
              onCompact={compactContext}
              onSwitchRole={switchConversationRole}
              onChangeCwd={openWorkspaceDialog}
              onOpenConversation={focusConversation}
              onRewind={truncateConversation}
              rewindingMessageId={pendingConversationTruncation?.messageId}
            />}
      </div>
    </div>
    <ConnectionDrawer
      state={state}
      open={drawer && !blockingModalVisible}
      online={online}
      settingResult={settingResult}
      onClose={() => setDrawer(false)}
      onKey={(provider, key) => {
        const commandId = crypto.randomUUID();
        const sessionId = sessionIdRef.current;
        if (!sessionId) return undefined;
        setSettingResult(undefined);
        return send({ type: "set_api_key", commandId, sessionId, provider, key })
          ? commandId
          : undefined;
      }}
      onOAuth={(provider) => {
        const authFlowId = crypto.randomUUID();
        authFlowIdRef.current = authFlowId;
        setAuth({ progress: "正在启动登录…" });
        if (!send({ type: "login_oauth", authFlowId, provider })) {
          authFlowIdRef.current = "";
          setAuth({});
        }
      }}
      onLogout={(provider) => send({ type: "logout", provider })}
      onRefresh={() => send({ type: "refresh_models" })}
      onClearSettingResult={clearSettingResult}
      onKeyDialogChange={setSettingsDialogOpen}
    />
    <RoleManagerDialog
      open={roleManagerOpen && !blockingModalVisible}
      roles={roles}
      providers={state.providers}
      initialRoleId={roleManagerInitialRoleId}
      pending={pendingRoleOperation}
      result={roleOperationResult}
      onClose={() => {
        setRoleManagerOpen(false);
        updatePendingRoleOperation(undefined);
        setRoleOperationResult(undefined);
      }}
      onCreate={(role: RoleDraft) => beginRoleOperation(
        "create_role",
        { type: "create_role", role },
      )}
      onUpdate={(roleId, expectedRevision, role: RoleDraft) =>
        beginRoleOperation("update_role", {
          type: "update_role",
          roleId,
          expectedRevision,
          role,
        })}
      onDelete={(roleId, expectedRevision) =>
        beginRoleOperation("delete_role", {
          type: "delete_role",
          roleId,
          expectedRevision,
        })}
    />
    <AuthDialog {...auth} visible={authModalVisible} onRespond={(requestId, response) => {
      const authFlowId = authFlowIdRef.current;
      if (authFlowId) send({ type: "auth_response", authFlowId, requestId, ...response });
    }} onCancel={() => {
      const authFlowId = authFlowIdRef.current;
      if (authFlowId) send({ type: "cancel_auth", authFlowId });
      authFlowIdRef.current = "";
      setAuth({});
    }} />
    {workspaceSetupDialog}
    {directoryBrowserDialog}
    {extensionDialog}
    {feedback}
  </>;
}
