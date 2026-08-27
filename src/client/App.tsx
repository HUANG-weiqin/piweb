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
  type ConversationWindowCoverage,
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
import { createCompletionSound, type CompletionSound } from "./lib/completion-sound";
import { PiSocket } from "./lib/socket";
import { readStoredString, writeStoredString } from "./lib/storage";
import { createTransitionTimingOwner } from "./lib/transition-timing";
import { useLatestCallback } from "./lib/use-latest-callback";
import { useModalFocus } from "./lib/use-modal-focus";

const CWD_KEY = "piweb.lastCwd";
const WORKSPACES_KEY = "piweb.workspaces";
const MAX_WORKSPACES = 30;
export const MAX_CACHED_WORKSPACES = 4;
export const MAX_CACHED_CONVERSATION_PRESENTATIONS = 8;
const MAX_SUPERSEDED_FOCUS_COMMANDS = 64;
const RESUME_REFRESH_DELAY_MS = 16;
const EMPTY_CONVERSATION_WINDOW: ConversationWindowCoverage = {
  omittedBefore: false,
  startsMidTurn: false,
  contentTruncated: false,
};

interface InitialWorkspaceState {
  workspaces: string[];
  activeCwd: string;
}

export function rememberWorkspaceProjection<T>(
  cache: Map<string, T>,
  key: string,
  projection: T,
  limit = MAX_CACHED_WORKSPACES,
): void {
  cache.delete(key);
  cache.set(key, projection);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function forgetWorkspaceProjection<T>(
  cache: Map<string, T>,
  key: string,
): void {
  cache.delete(key);
}

export function getWorkspaceProjection<T>(
  cache: Map<string, T>,
  key: string,
): T | undefined {
  const projection = cache.get(key);
  if (projection === undefined) return undefined;
  cache.delete(key);
  cache.set(key, projection);
  return projection;
}

export function rememberConversationPresentation<T>(
  cache: Map<string, T>,
  key: string,
  presentation: T,
  limit = MAX_CACHED_CONVERSATION_PRESENTATIONS,
): void {
  cache.delete(key);
  cache.set(key, presentation);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function forgetConversationPresentation<T>(
  cache: Map<string, T>,
  key: string,
): void {
  cache.delete(key);
}

export function getConversationPresentation<T>(
  cache: Map<string, T>,
  key: string,
): T | undefined {
  const presentation = cache.get(key);
  if (presentation === undefined) return undefined;
  cache.delete(key);
  cache.set(key, presentation);
  return presentation;
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

interface DirectPendingPrompt extends ActiveFocus {
  workspaceKey: string;
  runId: string;
  promptId?: string;
  text: string;
}

/** busy 时已接受、尚未投递的浏览器 prompt（服务端内存态）。 */
interface PendingAdmission {
  promptId: string;
  text: string;
}

interface UnconfirmedPrompt {
  submittedText: string;
  retainedDraft: string;
  edited: boolean;
  promptId?: string;
  notice?: string;
}

interface PendingConversationDeletion {
  commandId: string;
  sessionId: string;
  workspaceKey: string;
  projectId: string;
  conversationId: string;
  focusId?: string;
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

interface CachedWorkspaceProjection {
  projectId: string;
  conversationId: string;
  state: PublicState;
  conversations: ConversationSummary[];
  roles: RoleTemplate[];
  conversationRole?: ConversationRoleSnapshot;
  conversationIndexTruncated: boolean;
  historyWindow: ConversationWindowCoverage;
  chat: typeof initialChatState;
}

interface CachedConversationPresentation {
  authority: "preview" | "snapshot";
  workspaceKey: string;
  projectId: string;
  conversationId: string;
  state: PublicState;
  conversationRole?: ConversationRoleSnapshot;
  historyWindow: ConversationWindowCoverage;
  chat: typeof initialChatState;
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
  workspaceKey: string;
  sourceFocus?: ActiveFocus;
  sourceReady?: boolean;
  cachedProjectId?: string;
  targetProjectId?: string;
  targetConversationId?: string;
  initializeConversationKind?: "recent" | "new" | "open";
}

interface SupersededFocusCommand {
  commandId: string;
  sessionId: string;
  workspaceKey: string;
  targetProjectId?: string;
  targetConversationId: string;
}

type ConversationSnapshotEvent = Extract<
  ServerEvent,
  { type: "conversation_snapshot" }
>;

interface DeferredFocusAuthority {
  focus: ActiveFocus;
  state?: PublicState;
  snapshot?: ConversationSnapshotEvent;
}

function sameFocus(
  left: ActiveFocus,
  right: ActiveFocus,
): boolean {
  return left.sessionId === right.sessionId
    && left.projectId === right.projectId
    && left.conversationId === right.conversationId
    && left.focusId === right.focusId;
}

function stateMatchesFocus(
  state: PublicState,
  focus: ActiveFocus,
): boolean {
  return state.sessionId === focus.sessionId
    && state.projectId === focus.projectId
    && state.conversationId === focus.conversationId
    && state.focusId === focus.focusId;
}

function snapshotMatchesFocus(
  snapshot: ConversationSnapshotEvent,
  focus: ActiveFocus,
): boolean {
  return snapshot.sessionId === focus.sessionId
    && snapshot.conversationId === focus.conversationId
    && snapshot.focusId === focus.focusId;
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
      expectedSystemPrompt: string;
      role: RoleDraft;
    }
  | {
      type: "delete_role";
      roleId: string;
      expectedRevision: number;
    };

export function App() {
  const [initialWorkspaces] = useState(loadInitialWorkspaceState);
  const [transitionTiming] = useState(createTransitionTimingOwner);
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
  const supersededFocusCommandsRef = useRef(
    new Map<string, SupersededFocusCommand>(),
  );
  const deferredFocusAuthorityRef = useRef<DeferredFocusAuthority | undefined>(
    undefined,
  );
  const authFlowIdRef = useRef("");
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const draftRevisionRef = useRef(0);
  const updateDraft = (text: string) => {
    draftRevisionRef.current += 1;
    draftRef.current = text;
    setDraft(text);
  };
  const [pendingPrompt, setPendingPrompt] = useState<DirectPendingPrompt>();
  const pendingPromptRef = useRef<DirectPendingPrompt | undefined>(undefined);
  const unconfirmedPromptByConversationRef =
    useRef(new Map<string, UnconfirmedPrompt>());
  const [pendingAdmissions, setPendingAdmissions] = useState<PendingAdmission[]>([]);
  const pendingAdmissionsRef = useRef<PendingAdmission[]>([]);
  const replacePendingAdmissions = (admissions: PendingAdmission[]) => {
    pendingAdmissionsRef.current = admissions;
    setPendingAdmissions(admissions);
  };
  const addPendingAdmission = (admission: PendingAdmission) => {
    if (pendingAdmissionsRef.current.some((a) => a.promptId === admission.promptId)) return;
    replacePendingAdmissions([...pendingAdmissionsRef.current, admission]);
  };
  const removePendingAdmission = (promptId: string) => {
    if (!pendingAdmissionsRef.current.some((a) => a.promptId === promptId)) return;
    replacePendingAdmissions(
      pendingAdmissionsRef.current.filter((a) => a.promptId !== promptId),
    );
  };
  const clearPendingAdmissions = () => replacePendingAdmissions([]);
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
  const authoritativeProjectMembershipRef = useRef(
    new Map<string, ReadonlySet<string>>(),
  );
  const [historyWindow, setHistoryWindow] = useState<ConversationWindowCoverage>(
    EMPTY_CONVERSATION_WINDOW,
  );
  const [conversationReady, setConversationReady] = useState(false);
  const conversationReadyRef = useRef(false);
  const workspaceProjectionCacheRef = useRef(
    new Map<string, CachedWorkspaceProjection>(),
  );
  const cachedWorkspacePresentationKeyRef = useRef("");
  const [cachedWorkspacePresentation, setCachedWorkspacePresentation] =
    useState<CachedWorkspaceProjection>();
  const conversationPresentationCacheRef = useRef(
    new Map<string, CachedConversationPresentation>(),
  );
  const cachedConversationPresentationKeyRef = useRef("");
  const [cachedConversationPresentation, setCachedConversationPresentation] =
    useState<CachedConversationPresentation>();
  const [workspaceSyncing, setWorkspaceSyncing] = useState(false);
  const workspaceSyncingRef = useRef(false);
  const [conversationSyncing, setConversationSyncing] = useState(false);
  const conversationSyncingRef = useRef(false);
  const updateWorkspaceSyncing = (syncing: boolean) => {
    workspaceSyncingRef.current = syncing;
    setWorkspaceSyncing(syncing);
  };
  const updateConversationSyncing = (syncing: boolean) => {
    conversationSyncingRef.current = syncing;
    setConversationSyncing(syncing);
  };
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
  const completionSoundRef = useRef<CompletionSound | undefined>(undefined);
  const socketEpochRef = useRef(0);
  const autoOpened = useRef(false);

  const updateOutstandingRunId = (runId: string) => {
    outstandingRunIdRef.current = runId;
    setOutstandingRunId(runId);
  };
  const updatePendingPrompt = (prompt: DirectPendingPrompt | undefined) => {
    pendingPromptRef.current = prompt;
    setPendingPrompt(prompt);
  };
  const currentWorkspaceKey = () => workspaceKey(activeCwdRef.current);
  const focusedConversationNeedsSnapshot = () =>
    Boolean(focusRef.current) && !conversationReadyRef.current;
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
  const conversationIsConfirmedMissing = (
    projectId: string,
    conversationId: string,
  ): boolean => {
    const membership = authoritativeProjectMembershipRef.current.get(projectId);
    return membership !== undefined && !membership.has(conversationId);
  };
  const cacheCurrentWorkspaceProjection = () => {
    const focus = focusRef.current;
    if (
      !conversationReadyRef.current
      || !focus
      || !state
      || state.projectId !== focus.projectId
      || state.conversationId !== focus.conversationId
      || conversationIsConfirmedMissing(focus.projectId, focus.conversationId)
    ) return;
    rememberWorkspaceProjection(
      workspaceProjectionCacheRef.current,
      currentWorkspaceKey(),
      {
        projectId: focus.projectId,
        conversationId: focus.conversationId,
        state: { ...state },
        conversations: [...conversations],
        roles: [...roles],
        conversationRole,
        conversationIndexTruncated,
        historyWindow,
        chat,
      },
    );
  };
  const cacheCurrentConversationPresentation = () => {
    const focus = focusRef.current;
    if (
      !conversationReadyRef.current
      || !focus
      || !state
      || state.sessionId !== focus.sessionId
      || state.projectId !== focus.projectId
      || state.conversationId !== focus.conversationId
      || state.focusId !== focus.focusId
      || !chat.focus
      || chat.focus.sessionId !== focus.sessionId
      || chat.focus.conversationId !== focus.conversationId
      || chat.focus.focusId !== focus.focusId
      || conversationIsConfirmedMissing(focus.projectId, focus.conversationId)
    ) return;
    const key = conversationScopeKey(
      currentWorkspaceKey(),
      focus.projectId,
      focus.conversationId,
    );
    rememberConversationPresentation(
      conversationPresentationCacheRef.current,
      key,
      {
        authority: "snapshot",
        workspaceKey: currentWorkspaceKey(),
        projectId: focus.projectId,
        conversationId: focus.conversationId,
        state: { ...state },
        conversationRole,
        historyWindow,
        // Keep the reducer-produced object by reference; this cache is display-only.
        chat,
      },
    );
  };
  const clearTemporaryWorkspacePresentation = () => {
    cachedWorkspacePresentationKeyRef.current = "";
    setCachedWorkspacePresentation(undefined);
  };
  const forgetWorkspaceConversationProjection = (
    workspaceKeyValue: string,
    projectId: string,
    conversationId: string,
  ) => {
    const cached = workspaceProjectionCacheRef.current.get(workspaceKeyValue);
    if (
      cached?.projectId !== projectId
      || cached.conversationId !== conversationId
    ) return;
    forgetWorkspaceProjection(
      workspaceProjectionCacheRef.current,
      workspaceKeyValue,
    );
    if (cachedWorkspacePresentationKeyRef.current === workspaceKeyValue) {
      clearTemporaryWorkspacePresentation();
    }
  };
  const clearTemporaryConversationPresentation = () => {
    cachedConversationPresentationKeyRef.current = "";
    setCachedConversationPresentation(undefined);
  };
  const discardCachedWorkspacePresentation = () => {
    const key = cachedWorkspacePresentationKeyRef.current;
    if (key) forgetWorkspaceProjection(workspaceProjectionCacheRef.current, key);
    clearTemporaryWorkspacePresentation();
    setState(undefined);
    authoritativeProjectMembershipRef.current.clear();
    setConversations([]);
    setRoles([]);
    setConversationRole(undefined);
    setConversationIndexTruncated(false);
    setHistoryWindow(EMPTY_CONVERSATION_WINDOW);
    dispatch({ type: "reset" });
  };
  const showCachedWorkspacePresentation = (
    cached: CachedWorkspaceProjection,
    sessionId: string,
  ) => {
    cachedWorkspacePresentationKeyRef.current = currentWorkspaceKey();
    setCachedWorkspacePresentation(cached);
    setState({
      ...cached.state,
      sessionId,
      focusId: undefined,
      busy: false,
      compacting: false,
      activeRun: undefined,
    });
    setConversations(cached.conversations);
    setRoles(cached.roles);
    setConversationRole(cached.conversationRole);
    setConversationIndexTruncated(cached.conversationIndexTruncated);
    setHistoryWindow(cached.historyWindow);
  };
  const showCachedConversationPresentation = (
    cached: CachedConversationPresentation,
    cacheKey: string,
  ) => {
    cachedConversationPresentationKeyRef.current = cacheKey;
    setCachedConversationPresentation(cached);
  };
  const discardCachedWorkspacePresentationIfProjectMismatch = (projectId: string) => {
    const pending = pendingFocusRef.current;
    if (
      !pending?.cachedProjectId
      || pending.cachedProjectId === projectId
    ) return;
    discardCachedWorkspacePresentation();
    updateWorkspaceSyncing(false);
  };
  const showUnconfirmedPrompt = (focus: ActiveFocus | undefined) => {
    if (!focus) return;
    const unconfirmed = unconfirmedPromptByConversationRef.current.get(
      unconfirmedPromptKey(focus),
    );
    if (!unconfirmed) return;
    updateDraft(unconfirmed.retainedDraft);
    setPromptNotice(unconfirmed.notice ?? UNCONFIRMED_PROMPT_NOTICE);
  };
  const rememberUnconfirmedPrompt = (pending: DirectPendingPrompt) => {
    unconfirmedPromptByConversationRef.current.set(
      pendingConversationKey(pending),
      {
        submittedText: pending.text,
        retainedDraft: pending.text,
        edited: false,
      },
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
    if (
      currentFocus
      && currentFocus.projectId === pending.projectId
      && currentFocus.conversationId === pending.conversationId
      && currentWorkspaceKey() === pending.workspaceKey
    ) {
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
    if (
      currentFocus
      && currentFocus.projectId === pending.projectId
      && currentFocus.conversationId === pending.conversationId
      && currentWorkspaceKey() === pending.workspaceKey
    ) {
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
  const clearFocusReplacementAuthority = () => {
    supersededFocusCommandsRef.current.clear();
    deferredFocusAuthorityRef.current = undefined;
  };
  const rememberSupersededFocusCommand = (pending: PendingFocus) => {
    if (
      pending.operation !== "focus_conversation"
      || !pending.targetConversationId
    ) return;
    const command: SupersededFocusCommand = {
      commandId: pending.commandId,
      sessionId: sessionIdRef.current,
      workspaceKey: pending.workspaceKey,
      targetConversationId: pending.targetConversationId,
      ...(pending.targetProjectId
        ? { targetProjectId: pending.targetProjectId }
        : {}),
    };
    const commands = supersededFocusCommandsRef.current;
    commands.delete(command.commandId);
    commands.set(command.commandId, command);
    while (commands.size > MAX_SUPERSEDED_FOCUS_COMMANDS) {
      const oldestCommandId = commands.keys().next().value;
      if (oldestCommandId === undefined) break;
      commands.delete(oldestCommandId);
    }
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
    preservePresentation = false,
  ) => {
    updatePendingCompactionThreshold(undefined);
    updatePendingConversationTruncation(undefined);
    const previousProjectId = projectIdRef.current;
    projectIdRef.current = projectId;
    if (!conversationId || !focusId) {
      focusRef.current = undefined;
      conversationIdRef.current = "";
      clearPendingAdmissions();
      showPendingContextCompaction(undefined);
      setConversationRole(undefined);
      setHistoryWindow(EMPTY_CONVERSATION_WINDOW);
      updateConversationReady(false);
      setSelectingRole(true);
      dispatch({ type: "reset" });
      return;
    }
    const changedConversation = previousProjectId !== projectId
      || conversationIdRef.current !== conversationId;
    clearPendingAdmissions();
    const focus = { sessionId, projectId, conversationId, focusId };
    focusRef.current = focus;
    conversationIdRef.current = conversationId;
    if (!preservePresentation) {
      setConversationRole(undefined);
      setHistoryWindow(EMPTY_CONVERSATION_WINDOW);
      dispatch({ type: "focus_changed", ...focus });
    }
    updateConversationReady(false);
    setSelectingRole(false);
    if (changedConversation) {
      updateDraft("");
      setPromptNotice("");
      updatePendingPrompt(undefined);
      showPendingContextCompaction(focus);
      showUnconfirmedPrompt(focus);
    }
    updateOutstandingRunId("");
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
    forgetUnconfirmedPrompt(pending);
    updateDraft("");
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
    rememberUnconfirmedPrompt(pending);
    if (pendingIsCurrent) {
      updateDraft(pending.text);
      setPromptNotice(UNCONFIRMED_PROMPT_NOTICE);
    }
  };
  const updateConversationReady = (ready: boolean) => {
    conversationReadyRef.current = ready;
    setConversationReady(ready);
  };
  const clearSessionProjection = () => {
    clearFocusReplacementAuthority();
    clearTemporaryWorkspacePresentation();
    clearTemporaryConversationPresentation();
    updateConversationSyncing(false);
    setState(undefined);
    authoritativeProjectMembershipRef.current.clear();
    setConversations([]);
    setRoles([]);
    setConversationRole(undefined);
    setConversationIndexTruncated(false);
    setHistoryWindow(EMPTY_CONVERSATION_WINDOW);
    setExtensionUI([]);
    setNotification(undefined);
    setSettingResult(undefined);
    updatePendingCompactionThreshold(undefined);
    clearAllPendingContextCompactions();
    updatePendingConversationRoleSwitch(undefined);
    updatePendingConversationTruncation(undefined);
    updatePendingConversationDeletion(undefined);
    clearPendingAdmissions();
    setRoleOperationResult(undefined);
    updatePendingRoleOperation(undefined);
    setSettingsDialogOpen(false);
    setRoleManagerOpen(false);
    setSelectingRole(false);
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
  const applyAttachedPublicState = (
    focus: ActiveFocus,
    pendingState?: PublicState,
  ) => {
    if (pendingState && stateMatchesFocus(pendingState, focus)) {
      applyPublicState(pendingState);
      return;
    }
    setState((current) => current
      ? {
          ...current,
          projectId: focus.projectId,
          conversationId: focus.conversationId,
          focusId: focus.focusId,
          conversationName: undefined,
          selectedModel: undefined,
          activeRun: undefined,
          busy: false,
          compacting: false,
          sessionTokenUsage: undefined,
          contextUsage: undefined,
        }
      : current);
  };
  const applyConversationSnapshot = (
    event: ConversationSnapshotEvent,
    settleReadiness = true,
  ) => {
    if (settleReadiness) {
      transitionTiming.ready({
        sessionId: event.sessionId,
        conversationId: event.conversationId,
        focusId: event.focusId,
      });
    }
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
    setHistoryWindow(event.window);
    if (event.pendingPrompts !== undefined) {
      replacePendingAdmissions(
        event.pendingPrompts.map(({ promptId, text }) => ({ promptId, text })),
      );
    }
    if (settleReadiness && !pendingFocusRef.current) updateConversationReady(true);
    const snapshotPresentationKey = conversationScopeKey(
      currentWorkspaceKey(),
      projectIdRef.current,
      event.conversationId,
    );
    if (
      cachedConversationPresentationKeyRef.current
      === snapshotPresentationKey
    ) {
      clearTemporaryConversationPresentation();
    }
    if (
      settleReadiness
      && (workspaceSyncingRef.current || conversationSyncingRef.current)
    ) {
      if (workspaceSyncingRef.current) clearTemporaryWorkspacePresentation();
      updateWorkspaceSyncing(false);
      updateConversationSyncing(false);
    }
  };
  const activateDeferredFocusAuthority = (
    deferred: DeferredFocusAuthority,
  ) => {
    attachFocus(
      deferred.focus.sessionId,
      deferred.focus.projectId,
      deferred.focus.conversationId,
      deferred.focus.focusId,
    );
    applyAttachedPublicState(deferred.focus, deferred.state);
    if (deferred.snapshot) applyConversationSnapshot(deferred.snapshot, false);
    updateConversationReady(false);
    updateConversationSyncing(true);
  };

  useEffect(() => {
    cacheCurrentWorkspaceProjection();
    cacheCurrentConversationPresentation();
  }, [
    chat,
    conversationIndexTruncated,
    conversationReady,
    conversationRole,
    conversations,
    historyWindow,
    roles,
    state,
  ]);

  useEffect(() => {
    const sound = createCompletionSound();
    completionSoundRef.current = sound;
    const unlock = () => {
      void sound.unlock();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      sound.dispose();
      if (completionSoundRef.current === sound) {
        completionSoundRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    const epoch = ++socketEpochRef.current;
    const isCurrentSocket = () => socketEpochRef.current === epoch;
    const socket = new PiSocket((event: ServerEvent) => {
      if (!isCurrentSocket()) return;
      if (event.type === "hello") {
        if (event.protocolVersion !== PROTOCOL_VERSION) {
          const message = `协议版本不兼容：服务端 ${event.protocolVersion}，客户端 ${PROTOCOL_VERSION}`;
          transitionTiming.cancel();
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
          cachedWorkspacePresentationKeyRef.current = "";
          cachedConversationPresentationKeyRef.current = "";
          updateWorkspaceSyncing(false);
          updateConversationSyncing(false);
          clearTemporaryWorkspacePresentation();
          clearTemporaryConversationPresentation();
          updateDirectoryBrowser(undefined);
          markPendingPromptUnconfirmed();
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
          const previousConversationId = conversationIdRef.current;
          const cached = getWorkspaceProjection(
            workspaceProjectionCacheRef.current,
            currentWorkspaceKey(),
          );
          let conversation: Extract<
            ClientCommand,
            { type: "initialize" }
          >["conversation"];
          if (cached) {
            conversation = {
              kind: "open",
              conversationId: cached.conversationId,
            };
          } else if (previousConversationId) {
            conversation = {
              kind: "open",
              conversationId: previousConversationId,
            };
          } else {
            conversation = { kind: "recent" };
          }
          const sessionId = crypto.randomUUID();
          const commandId = crypto.randomUUID();
          const timingIntent = {
            kind: "workspace" as const,
            sessionId,
            commandId,
          };
          transitionTiming.begin(timingIntent);
          sessionIdRef.current = sessionId;
          authFlowIdRef.current = "";
          projectIdRef.current = "";
          focusRef.current = undefined;
          conversationIdRef.current = conversation.kind === "open"
            ? conversation.conversationId
            : "";
          updateOutstandingRunId("");
          setAuth({});
          dispatch({ type: "reset" });
          clearSessionProjection();
          updateWorkspaceSyncing(Boolean(cached));
          if (cached) showCachedWorkspacePresentation(cached, sessionId);
          updatePendingFocus({
            commandId,
            operation: "initialize",
            workspaceKey: currentWorkspaceKey(),
            initializeConversationKind: conversation.kind,
            ...(conversation.kind === "open"
              ? { targetConversationId: conversation.conversationId }
              : {}),
            ...(cached ? { cachedProjectId: cached.projectId } : {}),
          });
          const sent = socket.send({
            type: "initialize",
            commandId,
            sessionId,
            cwd: activeCwdRef.current,
            conversation,
          });
          if (!sent) transitionTiming.cancel(timingIntent);
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
        discardCachedWorkspacePresentationIfProjectMismatch(event.state.projectId);
        const currentFocus = focusRef.current;
        const pendingFocusState = pendingFocusRef.current;
        if (
          pendingFocusState?.operation === "focus_conversation"
          && currentFocus
          && stateMatchesFocus(event.state, currentFocus)
        ) {
          const deferred = deferredFocusAuthorityRef.current;
          if (deferred && sameFocus(deferred.focus, currentFocus)) {
            deferred.state = event.state;
          }
          return;
        }
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
          const pending = pendingFocusRef.current;
          if (pending) pendingFocusedStateRef.current = event.state;
          return;
        }
        applyPublicState(event.state);
      } else if (event.type === "conversation_preview") {
        const pending = pendingFocusRef.current;
        if (
          event.sessionId !== sessionIdRef.current
          || !pending
          || pending.commandId !== event.commandId
          || (pending.operation !== "initialize"
            && pending.operation !== "focus_conversation")
          || pending.workspaceKey !== currentWorkspaceKey()
          || workspaceKey(event.cwd) !== pending.workspaceKey
        ) return;
        const expectedProjectId = pending.targetProjectId
          ?? pending.cachedProjectId
          ?? projectIdRef.current;
        if (expectedProjectId && event.projectId !== expectedProjectId) return;
        if (pending.operation === "focus_conversation") {
          if (pending.targetConversationId !== event.conversationId) return;
        } else if (
          pending.initializeConversationKind !== "recent"
          && (
            pending.initializeConversationKind !== "open"
            || pending.targetConversationId !== event.conversationId
          )
        ) return;
        if (conversationIsConfirmedMissing(event.projectId, event.conversationId)) return;

        const previewThinkingLevel = event.role?.defaultThinkingLevel ?? "off";
        const previewChat = chatReducer(initialChatState, {
          type: "hydrate",
          sessionId: event.sessionId,
          conversationId: event.conversationId,
          focusId: `preview:${event.commandId}`,
          items: event.items,
        });
        const preview: CachedConversationPresentation = {
          authority: "preview",
          workspaceKey: pending.workspaceKey,
          projectId: event.projectId,
          conversationId: event.conversationId,
          state: {
            sessionId: event.sessionId,
            projectId: event.projectId,
            conversationId: event.conversationId,
            cwd: event.cwd,
            busy: false,
            compacting: false,
            thinkingLevel: previewThinkingLevel,
            toolMode: event.toolMode,
            availableThinkingLevels: [previewThinkingLevel],
            providers: [],
          },
          conversationRole: event.role,
          historyWindow: event.window,
          chat: previewChat,
        };
        const cacheKey = conversationScopeKey(
          pending.workspaceKey,
          event.projectId,
          event.conversationId,
        );
        rememberConversationPresentation(
          conversationPresentationCacheRef.current,
          cacheKey,
          preview,
        );
        showCachedConversationPresentation(preview, cacheKey);
        if (pending.operation === "initialize") updateWorkspaceSyncing(true);
      } else if (event.type === "focus_attached") {
        if (event.sessionId !== sessionIdRef.current) return;
        const pending = pendingFocusRef.current;
        const superseded = supersededFocusCommandsRef.current.get(event.commandId);
        if (
          pending?.operation === "focus_conversation"
          && event.operation === "focus_conversation"
          && event.conversationId !== undefined
          && event.focusId !== undefined
          && superseded
          && superseded.sessionId === event.sessionId
          && superseded.workspaceKey === currentWorkspaceKey()
          && pending.workspaceKey === currentWorkspaceKey()
          && superseded.targetConversationId === event.conversationId
          && (superseded.targetProjectId === undefined
            || superseded.targetProjectId === event.projectId)
          && (pending.targetProjectId === undefined
            || pending.targetProjectId === event.projectId)
        ) {
          supersededFocusCommandsRef.current.delete(event.commandId);
          const fallbackFocus: ActiveFocus = {
            sessionId: event.sessionId,
            projectId: event.projectId,
            conversationId: event.conversationId,
            focusId: event.focusId,
          };
          const deferred: DeferredFocusAuthority = { focus: fallbackFocus };
          const pendingState = pendingFocusedStateRef.current;
          if (pendingState && stateMatchesFocus(pendingState, fallbackFocus)) {
            deferred.state = pendingState;
            pendingFocusedStateRef.current = undefined;
          }
          deferredFocusAuthorityRef.current = deferred;
          attachFocus(
            fallbackFocus.sessionId,
            fallbackFocus.projectId,
            fallbackFocus.conversationId,
            fallbackFocus.focusId,
            true,
          );
          const nextPending = {
            ...pending,
            sourceFocus: fallbackFocus,
            sourceReady: false,
          };
          pendingFocusRef.current = nextPending;
          setPendingFocus(nextPending);
          return;
        }
        if (
          !pending
          || pending.commandId !== event.commandId
          || pending.operation !== event.operation
          || pending.workspaceKey !== currentWorkspaceKey()
          || (pending.targetProjectId !== undefined
            && pending.targetProjectId !== event.projectId)
          || (pending.operation === "focus_conversation"
            && (
              pending.targetConversationId !== event.conversationId
              || event.focusId === undefined
            ))
          || (pending.operation === "initialize"
            && pending.initializeConversationKind === "open"
            && (
              pending.targetConversationId !== event.conversationId
              || event.focusId === undefined
            ))
        ) return;
        clearFocusReplacementAuthority();
        const cachedProjectMismatch = Boolean(
          pending.cachedProjectId
          && pending.cachedProjectId !== event.projectId,
        );
        if (cachedProjectMismatch) {
          discardCachedWorkspacePresentation();
          updateWorkspaceSyncing(false);
        }
        const attachedPresentationKey = event.conversationId
          ? conversationScopeKey(
              pending.workspaceKey,
              event.projectId,
              event.conversationId,
            )
          : "";
        if (
          cachedConversationPresentationKeyRef.current
          && cachedConversationPresentationKeyRef.current !== attachedPresentationKey
        ) {
          clearTemporaryConversationPresentation();
        }
        transitionTiming.attach({
          kind: event.operation === "initialize" ? "workspace" : "conversation",
          sessionId: event.sessionId,
          commandId: event.commandId,
          conversationId: event.conversationId,
          focusId: event.focusId,
        });
        updatePendingFocus(undefined);
        updateConversationSyncing(event.operation === "focus_conversation");
        attachFocus(
          event.sessionId,
          event.projectId,
          event.conversationId,
          event.focusId,
          Boolean(pending.cachedProjectId && !cachedProjectMismatch),
        );
        if (
          event.operation === "initialize"
          && event.conversationId === undefined
          && event.focusId === undefined
        ) {
          transitionTiming.ready({ sessionId: event.sessionId });
          clearTemporaryConversationPresentation();
          if (workspaceSyncingRef.current) {
            clearTemporaryWorkspacePresentation();
            updateWorkspaceSyncing(false);
          }
        }
        const pendingState = pendingFocusedStateRef.current;
        pendingFocusedStateRef.current = undefined;
        if (event.conversationId && event.focusId) {
          applyAttachedPublicState({
            sessionId: event.sessionId,
            projectId: event.projectId,
            conversationId: event.conversationId,
            focusId: event.focusId,
          }, pendingState);
        } else {
          setState((current) => current
            ? {
                ...current,
                projectId: event.projectId,
                conversationId: event.conversationId,
                focusId: event.focusId,
                conversationName: undefined,
                selectedModel: undefined,
                activeRun: undefined,
                busy: false,
                compacting: false,
                sessionTokenUsage: undefined,
                contextUsage: undefined,
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
        clearPendingAdmissions();
        clearFocusReplacementAuthority();
        pendingFocusedStateRef.current = undefined;
        const invalidatedWorkspaceKey = currentWorkspaceKey();
        const invalidatedConversationKey = conversationScopeKey(
          invalidatedWorkspaceKey,
          event.projectId,
          event.conversationId,
        );
        forgetWorkspaceConversationProjection(
          invalidatedWorkspaceKey,
          event.projectId,
          event.conversationId,
        );
        forgetConversationPresentation(
          conversationPresentationCacheRef.current,
          invalidatedConversationKey,
        );
        clearTemporaryConversationPresentation();
        updateConversationSyncing(false);
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
        updateDraft("");
        setPromptNotice("");
        updatePendingPrompt(undefined);
        clearPendingAdmissions();
        updateOutstandingRunId("");
        setExtensionUI([]);
      } else if (event.type === "role_catalog_snapshot") {
        if (
          event.sessionId !== sessionIdRef.current
          || (projectIdRef.current && event.projectId !== projectIdRef.current)
        ) return;
        discardCachedWorkspacePresentationIfProjectMismatch(event.projectId);
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
        discardCachedWorkspacePresentationIfProjectMismatch(event.projectId);
        projectIdRef.current = event.projectId;
        const existingConversationIds = new Set(event.conversations.map(({ id }) => id));
        if (!event.truncated) {
          authoritativeProjectMembershipRef.current.set(
            event.projectId,
            existingConversationIds,
          );
          const workspaceKeyValue = currentWorkspaceKey();
          const workspaceProjection = workspaceProjectionCacheRef.current.get(workspaceKeyValue);
          if (
            workspaceProjection
            && workspaceProjection.projectId === event.projectId
            && !existingConversationIds.has(workspaceProjection.conversationId)
          ) {
            forgetWorkspaceProjection(workspaceProjectionCacheRef.current, workspaceKeyValue);
            if (cachedWorkspacePresentationKeyRef.current === workspaceKeyValue) {
              clearTemporaryWorkspacePresentation();
            }
          }
        }
        for (const [cacheKey, presentation] of conversationPresentationCacheRef.current) {
          if (
            !event.truncated
            && presentation.workspaceKey === currentWorkspaceKey()
            && presentation.projectId === event.projectId
            && !existingConversationIds.has(presentation.conversationId)
          ) {
            forgetConversationPresentation(conversationPresentationCacheRef.current, cacheKey);
            if (cachedConversationPresentationKeyRef.current === cacheKey) {
              clearTemporaryConversationPresentation();
            }
          }
        }
        setConversations(event.conversations);
        setConversationIndexTruncated(event.truncated);
      } else if (event.type === "conversation_run_settled") {
        if (
          event.sessionId !== sessionIdRef.current
          || event.projectId !== projectIdRef.current
          || event.outcome !== "completed"
          || event.createdBy.kind !== "user"
        ) return;
        completionSoundRef.current?.play();
      } else if (event.type === "prompt_admitted") {
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        // busy 路径回执：消息已进 followUp 队列，清草稿并显示为等待中。
        const pending = pendingPromptRef.current;
        if (
          pending
          && pending.promptId === event.promptId
          && pending.sessionId === event.sessionId
          && pending.conversationId === event.conversationId
          && pending.focusId === event.focusId
        ) {
          forgetUnconfirmedPrompt(pending);
          updateDraft("");
          setPromptNotice("");
          updatePendingPrompt(undefined);
        }
        addPendingAdmission({ promptId: event.promptId, text: event.text });
      } else if (event.type === "prompt_delivered") {
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        removePendingAdmission(event.promptId);
      } else if (event.type === "conversation_snapshot") {
        if (pendingFocusRef.current?.operation === "focus_conversation") {
          const deferred = deferredFocusAuthorityRef.current;
          if (deferred && snapshotMatchesFocus(event, deferred.focus)) {
            deferred.snapshot = event;
          }
          return;
        }
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        applyConversationSnapshot(event);
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
        if (
          event.event.type === "run_finished"
          && event.event.outcome === "aborted"
        ) {
          // 停止 = 取消未投递的等待中消息（与服务端 clearQueue 一致）
          clearPendingAdmissions();
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
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.sessionId !== event.sessionId
          ) return;
          updatePendingConversationDeletion(undefined);
          forgetWorkspaceConversationProjection(
            pending.workspaceKey,
            pending.projectId,
            pending.conversationId,
          );
          forgetConversationPresentation(
            conversationPresentationCacheRef.current,
            pendingConversationKey(pending),
          );
          if (cachedConversationPresentationKeyRef.current === pendingConversationKey(pending)) {
            clearTemporaryConversationPresentation();
          }

          unconfirmedPromptByConversationRef.current.delete(
            pendingConversationKey(pending),
          );
          if (
            pending.focusId !== undefined
            && focusRef.current?.sessionId === pending.sessionId
            && focusRef.current.projectId === pending.projectId
            && focusRef.current.conversationId === pending.conversationId
            && focusRef.current.focusId === pending.focusId
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
            updateDraft("");
            setPromptNotice("");
            updatePendingPrompt(undefined);
            const deletedCompaction =
              pendingContextCompactionRegistryRef.current.get(pending);
            if (deletedCompaction) {
              removePendingContextCompaction(deletedCompaction);
            }
            clearPendingAdmissions();
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
        if (event.operation === "steer") return;
        setSettingResult({
          operation: event.operation as AcknowledgedSettingOperation,
          commandId: event.commandId,
          ok: true,
          message: "",
        });
      } else if (event.type === "error") {
        if (event.sessionId && event.sessionId !== sessionIdRef.current) return;
        const supersededFocusError = event.commandId
          && event.operation === "focus_conversation"
          ? supersededFocusCommandsRef.current.get(event.commandId)
          : undefined;
        if (
          supersededFocusError
          && event.scope === "command"
          && event.sessionId === supersededFocusError.sessionId
          && event.focusId === undefined
          && (event.conversationId === undefined
            || event.conversationId === supersededFocusError.targetConversationId)
        ) {
          supersededFocusCommandsRef.current.delete(supersededFocusError.commandId);
          return;
        }
        const pendingCompactionError = event.commandId
          && event.operation === "compact_context"
          ? findPendingContextCompaction(event.commandId)
          : undefined;
        const pendingFocusError = pendingFocusRef.current;
        const settlesPendingFocus = Boolean(
          pendingFocusError
          && event.sessionId === sessionIdRef.current
          && event.commandId === pendingFocusError.commandId
          && event.operation === pendingFocusError.operation
          && event.focusId === undefined
          && (event.conversationId === undefined
            || (
              pendingFocusError.operation === "initialize"
              && pendingFocusError.initializeConversationKind === "recent"
            )
            || pendingFocusError.targetConversationId === event.conversationId),
        );
        const settlesBackgroundOperation = Boolean(
          pendingCompactionError
          && pendingCompactionError.sessionId === event.sessionId
          && pendingCompactionError.conversationId === event.conversationId
          && pendingCompactionError.focusId === event.focusId,
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
          && !settlesPendingFocus
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
            || !settlesPendingFocus
          ) return;
          transitionTiming.cancel({
            kind: pending.operation === "initialize" ? "workspace" : "conversation",
            sessionId: sessionIdRef.current,
            commandId: pending.commandId,
          });
          const deferred = deferredFocusAuthorityRef.current;
          updatePendingFocus(undefined);
          pendingFocusedStateRef.current = undefined;
          clearFocusReplacementAuthority();
          if (event.operation === "focus_conversation") {
            clearTemporaryConversationPresentation();
            updateConversationSyncing(false);
          }
          let fallbackRefreshFailed = false;
          if (
            event.operation === "focus_conversation"
            && deferred
            && focusRef.current
            && sameFocus(focusRef.current, deferred.focus)
          ) {
            activateDeferredFocusAuthority(deferred);
            fallbackRefreshFailed = !socket.send({
              type: "refresh_view",
              sessionId: deferred.focus.sessionId,
              projectId: deferred.focus.projectId,
              conversationId: deferred.focus.conversationId,
              focusId: deferred.focus.focusId,
            });
          } else if (
            pending.sourceReady
            && pending.sourceFocus
            && focusRef.current
            && sameFocus(focusRef.current, pending.sourceFocus)
          ) {
            updateConversationReady(true);
          }
          if (event.operation === "initialize") {
            clearTemporaryConversationPresentation();
            if (pending.cachedProjectId) discardCachedWorkspacePresentation();
            conversationIdRef.current = "";
            updateWorkspaceSyncing(false);
            updateConversationSyncing(false);
          }
          if (event.operation === "initialize" && activeCwdRef.current) {
            markWorkspaceUnavailable(activeCwdRef.current);
          }
          setError(fallbackRefreshFailed
            ? `${event.message}；恢复会话刷新请求发送失败`
            : event.message);
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
            setPromptNotice(
              `消息未被服务端接收：${event.message}。内容已保留，可以修改后重试。`,
            );
          }
        }
        if (
          event.commandId
          && (event.operation === "set_api_key"
            || event.operation === "select_model"
            || event.operation === "refresh_models")
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
        transitionTiming.cancel();
        setProtocolReady(false);
        setProjectActivityByWorkspace(new Map());
        setProjectActivityTruncated(false);
        setSettingResult(undefined);
        updateDirectoryBrowser(undefined);
        markPendingPromptUnconfirmed();
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
        updateWorkspaceSyncing(false);
        updateConversationSyncing(false);
        clearFocusReplacementAuthority();
        pendingFocusedStateRef.current = undefined;
        clearTemporaryWorkspacePresentation();
        clearTemporaryConversationPresentation();
      }
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      transitionTiming.cancel();
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
        || workspaceSyncingRef.current
        || conversationSyncingRef.current
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
    if (
      !chat.projectionGap
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || !transportOnline
      || !protocolReady
    ) return;
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
  }, [chat.projectionGap, protocolReady, state?.compacting, transportOnline]);
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
    cached?: CachedWorkspaceProjection,
  ) => {
    const normalizedCwd = cwd.trim();
    const sessionId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const timingIntent = {
      kind: "workspace" as const,
      sessionId,
      commandId,
    };
    transitionTiming.begin(timingIntent);
    setError("");
    markPendingPromptUnconfirmed();
    updateDraft("");
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
    updateWorkspaceSyncing(Boolean(cached));
    if (cached) showCachedWorkspacePresentation(cached, sessionId);
    dispatch({ type: "reset" });
    updatePendingFocus({
      commandId,
      operation: "initialize",
      workspaceKey: currentWorkspaceKey(),
      initializeConversationKind: conversation?.kind ?? "recent",
      ...(conversation?.kind === "open"
        ? { targetConversationId: conversation.conversationId }
        : {}),
      ...(cached ? { cachedProjectId: cached.projectId } : {}),
    });
    const sent = send({
      type: "initialize",
      commandId,
      sessionId,
      cwd: normalizedCwd,
      conversation,
    });
    if (!sent) transitionTiming.cancel(timingIntent);
    if (!sent && cached) {
      updatePendingFocus(undefined);
      discardCachedWorkspacePresentation();
      updateWorkspaceSyncing(false);
      markWorkspaceUnavailable(normalizedCwd);
    }
  };
  const initializeWorkspace = (cwd: string) => {
    const cached = getWorkspaceProjection(
      workspaceProjectionCacheRef.current,
      workspaceKey(cwd),
    );
    initialize(
      cwd,
      cached
        ? { kind: "open", conversationId: cached.conversationId }
        : { kind: "recent" },
      cached,
    );
  };
  const sendPrompt = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed || !conversationReadyRef.current) return false;
    if (pendingConversationTruncationRef.current) return false;
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    if (!sessionId || !focus || focus.sessionId !== sessionId) return false;
    const runId = crypto.randomUUID();
    const promptId = crypto.randomUUID();
    const pending: DirectPendingPrompt = {
      ...focus,
      workspaceKey: currentWorkspaceKey(),
      runId,
      promptId,
      text: trimmed,
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
      promptId,
      text: trimmed,
    });
    if (!ok) {
      updatePendingPrompt(undefined);
      updateOutstandingRunId("");
      setPromptNotice("消息未发送，内容已保留，可以重试。");
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
    return sendPrompt(trimmed);
  };
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
    const workspaceKeyValue = currentWorkspaceKey();
    const previousPending = pendingFocusRef.current;
    const replacingPendingFocus =
      previousPending?.operation === "focus_conversation"
      && previousPending.workspaceKey === workspaceKeyValue;
    const replacingAttachedFocus =
      previousPending === undefined
      && conversationSyncingRef.current;
    const replacingFocus = replacingPendingFocus || replacingAttachedFocus;
    if (
      !sessionId
      || workspaceSyncingRef.current
      || (conversationSyncingRef.current && !replacingFocus)
      || (previousPending && !replacingPendingFocus)
      || pendingConversationDeletionRef.current
      || pendingConversationTruncationRef.current
      || pendingPromptRef.current
      || pendingConversationRoleSwitchRef.current
    ) return;
    if (
      previousPending?.operation === "focus_conversation"
      && previousPending.targetConversationId === conversationId
    ) return;
    const replacingDifferentPendingTarget = Boolean(
      replacingPendingFocus
      && previousPending.targetConversationId !== conversationId,
    );
    if (
      !replacingDifferentPendingTarget
      && focusRef.current?.conversationId === conversationId
    ) {
      setSelectingRole(false);
      return;
    }
    const commandId = crypto.randomUUID();
    const timingIntent = {
      kind: "conversation" as const,
      sessionId,
      commandId,
    };
    const command = {
      type: "focus_conversation" as const,
      commandId,
      sessionId,
      conversationId,
    };
    setError("");
    if (replacingFocus) {
      if (!send(command)) return;
      if (replacingPendingFocus) {
        rememberSupersededFocusCommand(previousPending);
      }
      transitionTiming.begin(timingIntent);
    } else {
      transitionTiming.begin(timingIntent);
    }
    clearPendingAdmissions();
    cacheCurrentConversationPresentation();
    const sourceFocus = focusRef.current;
    const sourceReady = conversationReadyRef.current || Boolean(
      replacingPendingFocus
      && previousPending.sourceReady
      && previousPending.sourceFocus
      && sourceFocus
      && sameFocus(previousPending.sourceFocus, sourceFocus)
    );
    if (!replacingPendingFocus) {
      clearFocusReplacementAuthority();
      deferredFocusAuthorityRef.current = sourceFocus && !sourceReady
        ? { focus: sourceFocus }
        : undefined;
    } else if (
      !deferredFocusAuthorityRef.current
      && sourceFocus
      && !sourceReady
    ) {
      deferredFocusAuthorityRef.current = { focus: sourceFocus };
    }
    const targetProjectId = projectIdRef.current;
    const targetCacheKey = targetProjectId
      ? conversationScopeKey(workspaceKeyValue, targetProjectId, conversationId)
      : "";
    const targetPresentation = targetCacheKey
      ? getConversationPresentation(
          conversationPresentationCacheRef.current,
          targetCacheKey,
        )
      : undefined;
    if (targetPresentation) {
      showCachedConversationPresentation(targetPresentation, targetCacheKey);
    } else {
      clearTemporaryConversationPresentation();
    }
    updateConversationSyncing(true);
    updateConversationReady(false);
    updatePendingFocus({
      commandId,
      operation: "focus_conversation",
      workspaceKey: workspaceKeyValue,
      ...(targetProjectId ? { targetProjectId } : {}),
      targetConversationId: conversationId,
      ...(sourceFocus ? { sourceFocus } : {}),
      sourceReady,
    });
    if (!replacingFocus && !send(command)) {
      transitionTiming.cancel(timingIntent);
      updatePendingFocus(undefined);
      clearFocusReplacementAuthority();
      clearTemporaryConversationPresentation();
      updateConversationSyncing(false);
      if (sourceReady && focusRef.current === sourceFocus) {
        updateConversationReady(true);
      }
    }
  };
  const createConversation = (roleId: string) => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || pendingFocusRef.current
      || pendingConversationDeletionRef.current
      || pendingConversationTruncationRef.current
      || pendingPromptRef.current
      || pendingConversationRoleSwitchRef.current
      || focusedConversationNeedsSnapshot()
    ) return;
    const commandId = crypto.randomUUID();
    const timingIntent = {
      kind: "conversation" as const,
      sessionId,
      commandId,
    };
    transitionTiming.begin(timingIntent);
    updatePendingFocus({
      commandId,
      operation: "create_conversation",
      workspaceKey: currentWorkspaceKey(),
    });
    setError("");
    if (!send({
      type: "create_conversation",
      commandId,
      sessionId,
      roleId,
    })) {
      transitionTiming.cancel(timingIntent);
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
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || focusedConversationNeedsSnapshot()
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
      sessionId,
      workspaceKey: currentWorkspaceKey(),
      projectId,
      conversationId,
      ...(deletingFocusedConversation && focusRef.current
        ? { focusId: focusRef.current.focusId }
        : {}),
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
    if (
      !sessionId
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || focusedConversationNeedsSnapshot()
    ) return;
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
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || !conversationReadyRef.current
      || Boolean(state?.busy)
      || Boolean(outstandingRunIdRef.current)
      || Boolean(pendingPromptRef.current)
      || pendingAdmissionsRef.current.length > 0
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
      updateDraft(text);
      setPromptNotice("");
      return true;
    }
    updatePendingConversationTruncation(undefined);
    return false;
  };
  const setThinkingLevel = (level: ThinkingLevel) => {
    if (
      !conversationReadyRef.current
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || pendingFocusRef.current
    ) return;
    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "set_thinking", sessionId, level });
  };
  const setCompactionThreshold = (percent: number): boolean => {
    const focus = focusRef.current;
    if (
      !focus
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
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
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
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
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || !conversationReadyRef.current
      || Boolean(state?.busy)
      || Boolean(outstandingRunIdRef.current)
      || Boolean(pendingPromptRef.current)
      || pendingAdmissionsRef.current.length > 0
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
    if (
      !sessionId
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || pendingRoleOperationRef.current
    ) return;
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
    cacheCurrentWorkspaceProjection();
    cacheCurrentConversationPresentation();
    initializeWorkspace(cwd);
  };
  const removeWorkspace = (cwd: string) => {
    const key = workspaceKey(cwd);
    forgetWorkspaceProjection(workspaceProjectionCacheRef.current, key);
    if (cachedWorkspacePresentationKeyRef.current === key) {
      clearTemporaryWorkspacePresentation();
    }
    for (const [cacheKey, presentation] of conversationPresentationCacheRef.current) {
      if (presentation.workspaceKey === key) {
        forgetConversationPresentation(conversationPresentationCacheRef.current, cacheKey);
      }
    }
    if (cachedConversationPresentation?.workspaceKey === key) {
      clearTemporaryConversationPresentation();
    }
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
      initializeWorkspace(fallback);
      return;
    }

    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "close_session", sessionId });
    transitionTiming.cancel();
    activeCwdRef.current = "";
    sessionIdRef.current = "";
    conversationIdRef.current = "";
    focusRef.current = undefined;
    writeStoredString(CWD_KEY, "");
    setActiveCwd("");
    setSetupCwd("");
    setError("");
    updateWorkspaceSyncing(false);
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
  const handleWorkspaceSelect = useLatestCallback(switchWorkspace);
  const handleWorkspaceAdd = useLatestCallback(openWorkspaceDialog);
  const handleSidebarCollapsedChange = useLatestCallback(
    (collapsed: boolean) => setSidebarCollapsed(collapsed),
  );
  const handleConversationSelect = useLatestCallback(focusConversation);
  const handleConversationCreate = useLatestCallback(() => {
    if (
      !workspaceSyncingRef.current
      && !conversationSyncingRef.current
      && !focusedConversationNeedsSnapshot()
    ) {
      setSelectingRole(true);
    }
  });
  const handleConversationRename = useLatestCallback(renameConversation);
  const handleConversationDelete = useLatestCallback(deleteConversation);
  const handleChatDraftChange = useLatestCallback((text: string) => {
    updateDraft(text);
    const focus = focusRef.current;
    if (focus) {
      const key = unconfirmedPromptKey(focus);
      const unconfirmed = unconfirmedPromptByConversationRef.current.get(key);
      if (unconfirmed) {
        if (text) {
          unconfirmedPromptByConversationRef.current.set(key, {
            ...unconfirmed,
            retainedDraft: text,
            edited: true,
          });
        } else {
          unconfirmedPromptByConversationRef.current.delete(key);
        }
      }
    }
    if (promptNotice) setPromptNotice("");
  });
  const handleChatSend = useLatestCallback(submitPrompt);
  const handleChatAbort = useLatestCallback(abortCurrentRun);
  const handleChatSettings = useLatestCallback(() => {
    if (
      !workspaceSyncingRef.current
      && !conversationSyncingRef.current
      && !focusedConversationNeedsSnapshot()
    ) setDrawer(true);
  });
  const handleChatThinking = useLatestCallback(setThinkingLevel);
  const handleChatCompactionThreshold = useLatestCallback(setCompactionThreshold);
  const handleChatCompact = useLatestCallback(compactContext);
  const handleChatSwitchRole = useLatestCallback(switchConversationRole);
  const handleChatRewind = useLatestCallback(truncateConversation);
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
    onSelect={handleWorkspaceSelect}
    onAdd={handleWorkspaceAdd}
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

  const transitioning = workspaceSyncing || conversationSyncing;
  const activeConversationPresentation =
    cachedConversationPresentationKeyRef.current
      ? cachedConversationPresentation
      : undefined;
  let transitionPresentation:
    | CachedWorkspaceProjection
    | CachedConversationPresentation
    | undefined;
  if (transitioning && activeConversationPresentation) {
    transitionPresentation = activeConversationPresentation;
  } else if (workspaceSyncing) {
    transitionPresentation = cachedWorkspacePresentation;
  }
  const visibleState = transitionPresentation
    ? {
        ...transitionPresentation.state,
        sessionId: sessionIdRef.current,
        focusId: undefined,
        busy: false,
        compacting: false,
        activeRun: undefined,
      }
    : state;
  if (!activeCwd || !visibleState) return <>
    <div className="workbench">
      {workspaceRail}
      <ConversationSidebar
        conversations={[]}
        truncated={false}
        collapsed={sidebarCollapsed}
        navigationEnabled={false}
        actionsEnabled={false}
        onToggleCollapsed={handleSidebarCollapsedChange}
        onSelect={handleConversationSelect}
        onCreate={handleConversationCreate}
        onRename={handleConversationRename}
        onDelete={handleConversationDelete}
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

  const showRoleSelection = selectingRole || !visibleState.conversationId;
  const conversationCompacting =
    visibleState.compacting === true || Boolean(pendingContextCompaction);
  const switchingFocus = pendingFocus?.operation === "focus_conversation"
    || pendingFocus?.operation === "create_conversation";
  const showAttachedConversationProjection =
    conversationSyncing && pendingFocus === undefined;
  let visibleChat = chat;
  if (transitioning) {
    visibleChat = transitionPresentation?.chat
      ?? (showAttachedConversationProjection ? chat : initialChatState);
  } else if (switchingFocus) {
    visibleChat = initialChatState;
  }
  const visibleBusy = transitioning || switchingFocus
    ? false
    : visibleState.busy || Boolean(outstandingRunId);
  const visibleActiveRun = transitioning || switchingFocus
    ? undefined
    : visibleState.activeRun;
  const visibleConversationReady =
    !switchingFocus && !transitioning && conversationReady;
  const focusAwaitingSnapshot = Boolean(focusRef.current) && !conversationReady;
  const settingsEnabled = !transitioning && !focusAwaitingSnapshot;
  const visibleCompacting = transitioning ? false : conversationCompacting;
  const visibleConversationRole = transitioning
    ? transitionPresentation?.conversationRole
      ?? (showAttachedConversationProjection ? conversationRole : undefined)
    : conversationRole;
  const visibleHistoryWindow = transitioning
    ? transitionPresentation?.historyWindow
      ?? (showAttachedConversationProjection
        ? historyWindow
        : EMPTY_CONVERSATION_WINDOW)
    : historyWindow;
  const pendingTargetConversationId = pendingFocus?.operation === "focus_conversation"
    ? pendingFocus.targetConversationId
    : undefined;

  return <>
    <div className="workbench">
      {workspaceRail}
      <ConversationSidebar
        conversations={conversations}
        truncated={conversationIndexTruncated}
        currentConversationId={pendingTargetConversationId
          ?? (showRoleSelection ? undefined : visibleState.conversationId)}
        busyConversationId={
          visibleState.busy || outstandingRunId ? visibleState.conversationId : undefined
        }
        collapsed={sidebarCollapsed}
        navigationEnabled={
          online
          && !workspaceSyncing
          && (
            pendingFocus === undefined
            || pendingFocus.operation === "focus_conversation"
          )
        }
        actionsEnabled={
          online
          && !transitioning
          && !pendingFocus
          && !focusAwaitingSnapshot
        }
        pendingDeletionId={pendingConversationDeletion?.conversationId}
        onToggleCollapsed={handleSidebarCollapsedChange}
        onSelect={handleConversationSelect}
        onCreate={handleConversationCreate}
        onRename={handleConversationRename}
        onDelete={handleConversationDelete}
      />
      <div className="workbench-main">
        {workspaceSyncing && <div
          className="banner"
          role="status"
          aria-label="正在同步工作区…"
        >
          正在同步工作区…
        </div>}
        {conversationSyncing && <div
          className="banner"
          role="status"
          aria-label="正在同步会话…"
        >
          正在同步会话…
        </div>}
        {showRoleSelection
          ? <RoleSelectionPage
              roles={roles}
              pending={creatingConversation || transitioning}
              onStart={createConversation}
              onManageRole={(roleId) => {
                setRoleManagerInitialRoleId(roleId);
                setRoleManagerOpen(true);
              }}
              onAddRole={() => {
                setRoleManagerInitialRoleId(null);
                setRoleManagerOpen(true);
              }}
              onSettings={() => {
                if (!focusedConversationNeedsSnapshot()) setDrawer(true);
              }}
            />
          : <Chat
              chat={visibleChat}
              busy={visibleBusy}
              activeRun={visibleActiveRun}
              sessionTokenUsage={visibleState.sessionTokenUsage}
              contextTokenCount={visibleState.contextUsage?.tokens}
              contextWindow={visibleState.contextUsage?.contextWindow}
              contextPercent={visibleState.contextUsage?.percent}
              contextSource={visibleState.contextUsage?.source}
              model={visibleState.selectedModel}
              role={visibleConversationRole}
              roles={roles}
              roleSwitchDisabled={
                transitioning
                || visibleState.busy
                || Boolean(outstandingRunId)
                || Boolean(pendingPrompt)
                || pendingAdmissions.length > 0
                || Boolean(pendingConversationTruncation)
                || Boolean(pendingConversationDeletion)
                || conversationCompacting
              }
              roleSwitching={Boolean(pendingConversationRoleSwitch)}
              thinkingLevel={visibleState.thinkingLevel}
              availableThinkingLevels={visibleState.availableThinkingLevels}
              compactionThresholdPercent={
                visibleState.compactionThresholdPercent
                ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT
              }
              compactionThresholdBusy={Boolean(pendingCompactionThreshold)}
              compacting={visibleCompacting}
              cwd={visibleState.cwd}
              online={online}
              interactive={settingsEnabled}
              conversationReady={visibleConversationReady}
              historyWindow={visibleHistoryWindow}
              draft={draft}
              submitting={Boolean(pendingPrompt)}
              pendingAdmissions={pendingAdmissions}
              promptNotice={promptNotice || undefined}
              onDraftChange={handleChatDraftChange}
              onSend={handleChatSend}
              onAbort={handleChatAbort}
              onSettings={handleChatSettings}
              onThinking={handleChatThinking}
              onCompactionThreshold={handleChatCompactionThreshold}
              onCompact={handleChatCompact}
              onSwitchRole={handleChatSwitchRole}
              onChangeCwd={handleWorkspaceAdd}
              onOpenConversation={handleConversationSelect}
              onRewind={handleChatRewind}
              rewindingMessageId={pendingConversationTruncation?.messageId}
            />}
      </div>
    </div>
    <ConnectionDrawer
      state={visibleState}
      open={drawer && !blockingModalVisible && !transitioning}
      online={online && settingsEnabled}
      settingResult={settingResult}
      onClose={() => setDrawer(false)}
      onKey={(provider, key) => {
        const commandId = crypto.randomUUID();
        const sessionId = sessionIdRef.current;
        if (!sessionId || focusedConversationNeedsSnapshot()) return undefined;
        setSettingResult(undefined);
        return send({ type: "set_api_key", commandId, sessionId, provider, key })
          ? commandId
          : undefined;
      }}
      onOAuth={(provider) => {
        if (focusedConversationNeedsSnapshot()) return;
        const authFlowId = crypto.randomUUID();
        authFlowIdRef.current = authFlowId;
        setAuth({ progress: "正在启动登录…" });
        if (!send({ type: "login_oauth", authFlowId, provider })) {
          authFlowIdRef.current = "";
          setAuth({});
        }
      }}
      onLogout={(provider) => (
        focusedConversationNeedsSnapshot()
          ? false
          : send({ type: "logout", provider })
      )}
      onRefresh={() => {
         const commandId = crypto.randomUUID();
         const sessionId = sessionIdRef.current;
         if (!sessionId || focusedConversationNeedsSnapshot()) return undefined;
         setSettingResult(undefined);
         return send({ type: "refresh_models", commandId, sessionId })
           ? commandId
           : undefined;
       }}
      onClearSettingResult={clearSettingResult}
      onKeyDialogChange={setSettingsDialogOpen}
    />
    <RoleManagerDialog
      open={roleManagerOpen && !blockingModalVisible && !transitioning}
      roles={roles}
      providers={visibleState.providers}
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
      onUpdate={(roleId, expectedRevision, expectedSystemPrompt, role: RoleDraft) =>
        beginRoleOperation("update_role", {
          type: "update_role",
          roleId,
          expectedRevision,
          expectedSystemPrompt,
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
