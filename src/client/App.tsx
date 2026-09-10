import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  MAX_MESSAGE_BYTES,
  MAX_PROMPT_CHARACTERS,
  PROTOCOL_VERSION,
  type AuthRequest,
  type ClientCommand,
  type ColorScheme,
  type ConversationImageLocator,
  type ConversationRoleSnapshot,
  type ConversationSummary,
  type DirectoryListing,
  type LoopList,
  type PublicState,
  type ProjectActivitySummary,
  type PromptImage,
  type RoleTemplate,
  type ServerEvent,
  type ServiceTier,
  type ThinkingLevel,
} from "../shared/protocol";
import {
  chatReducer,
  initialChatState,
  type ChatAction,
} from "./chat/reducer";
import { ActivitySpinner } from "./components/ActivitySpinner";
import { AuthDialog } from "./components/AuthDialog";
import { Chat } from "./components/Chat";
import {
  SettingsDrawer,
  type SettingOperationResult,
  type SettingOperationResults,
} from "./components/SettingsDrawer";
import {
  ConversationSidebar,
  conversationDisplayOrdinal,
} from "./components/ConversationSidebar";
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
import {
  conversationDisplayTitle,
  conversationTitleLookupKey,
  createConversationTitleLookup,
} from "./lib/conversation-display";
import {
  decodePhoneHistoryRoute,
  phoneHistoryRouteEquals,
  phoneHistoryRouteParent,
  pushPhoneHistoryRoute,
  readPhoneHistoryRoute,
  replacePhoneHistoryRoute,
  type PhoneHistoryRoute,
} from "./lib/phone-history-route";
import { PiSocket } from "./lib/socket";
import { readStoredString, writeStoredString } from "./lib/storage";
import {
  createTransitionTimingOwner,
  type ClientTransitionObservation,
  type TransitionOrigin,
  type TransitionPresentationSource,
  type TransitionTimingAttempt,
} from "./lib/transition-timing";
import { useLatestCallback } from "./lib/use-latest-callback";
import { useModalFocus } from "./lib/use-modal-focus";
import { usePhoneSceneFocus } from "./lib/use-phone-scene-focus";
import { usePhoneViewport } from "./lib/use-phone-viewport";

const WORKSPACES_KEY = "piweb.workspaces";
const MAX_WORKSPACES = 30;
export const MAX_CACHED_WORKSPACES = 4;
export const MAX_CACHED_CONVERSATION_PRESENTATIONS = 8;
const MAX_SUPERSEDED_FOCUS_COMMANDS = 64;
const RESUME_REFRESH_DELAY_MS = 16;
const MAX_PHONE_HISTORY_ENTRIES = 8;
const EMPTY_SERVICE_TIERS: readonly ServiceTier[] = [];
type MobileScene = "workspaces" | "conversations" | "chat";

function isAffectedByDeletionProjection(
  conversation: ConversationSummary,
  targetConversationId: string,
): boolean {
  return conversation.id === targetConversationId
    || conversation.rootConversationId === targetConversationId;
}

function projectConversationsDuringDeletion(
  conversations: ConversationSummary[],
  targetConversationId?: string,
  affectedFocusConversationId?: string,
): ConversationSummary[] {
  if (!targetConversationId && !affectedFocusConversationId) {
    return conversations;
  }
  return conversations.filter((conversation) => (
    conversation.id !== affectedFocusConversationId
    && (
      !targetConversationId
      || !isAffectedByDeletionProjection(conversation, targetConversationId)
    )
  ));
}

interface InitialWorkspaceState {
  workspaces: string[];
  activeCwd: string;
}

interface InitialPhoneNavigation {
  route?: PhoneHistoryRoute;
}

function loadInitialPhoneNavigation(phoneViewport: boolean): InitialPhoneNavigation {
  if (!phoneViewport) return {};
  const route = readPhoneHistoryRoute();
  return route ? { route } : {};
}

function rememberProjection<T>(
  cache: Map<string, T>,
  key: string,
  projection: T,
  limit: number,
): void {
  cache.delete(key);
  cache.set(key, projection);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function getProjection<T>(
  cache: Map<string, T>,
  key: string,
): T | undefined {
  const projection = cache.get(key);
  if (projection === undefined) return undefined;
  cache.delete(key);
  cache.set(key, projection);
  return projection;
}

export function rememberWorkspaceProjection<T>(
  cache: Map<string, T>,
  key: string,
  projection: T,
  limit = MAX_CACHED_WORKSPACES,
): void {
  rememberProjection(cache, key, projection, limit);
}

export const getWorkspaceProjection = getProjection;

export function rememberConversationPresentation<T>(
  cache: Map<string, T>,
  key: string,
  presentation: T,
  limit = MAX_CACHED_CONVERSATION_PRESENTATIONS,
): void {
  rememberProjection(cache, key, presentation, limit);
}

export const getConversationPresentation = getProjection;


function loadInitialWorkspaceState(
  phoneRoute?: PhoneHistoryRoute,
): InitialWorkspaceState {
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
  const routeCwd = phoneRoute?.screen === "workspaces"
    ? undefined
    : phoneRoute?.cwd;
  if (routeCwd && !seen.has(workspaceKey(routeCwd))) {
    workspaces.unshift(routeCwd);
    seen.add(workspaceKey(routeCwd));
    if (workspaces.length > MAX_WORKSPACES) workspaces.pop();
  }
  const activeCwd = routeCwd ?? workspaces[0] ?? "";
  return { workspaces, activeCwd };
}

interface DirectPendingPrompt extends ActiveFocus {
  workspaceKey: string;
  runId: string;
  promptId: string;
  text: string;
  images: PromptImage[];
}

interface PendingImageOpen extends ActiveFocus {
  commandId: string;
  messageId: string;
  imageOrdinal: number;
  target: Window;
}

interface ConversationComposerDraft {
  text: string;
  images: PromptImage[];
  status: "editing" | "unconfirmed";
}

/** busy 时已接受、尚未投递的浏览器 prompt（服务端内存态）。 */
interface PendingAdmission {
  promptId: string;
  text: string;
}

interface PendingConversationDeletion {
  commandId: string;
  sessionId: string;
  workspaceKey: string;
  projectId: string;
  conversationId: string;
  affectedFocus?: {
    conversationId: string;
    focusId: string;
  };
}

interface PendingConversationTruncation {
  commandId: string;
  messageId: string;
}

interface PendingCompactionThreshold {
  commandId: string;
}

interface PendingServiceTier extends ActiveFocus {
  commandId: string;
}

interface PendingContextCompaction extends ActiveFocus {
  commandId: string;
  workspaceKey: string;
}

interface PendingConversationRoleSwitch extends ActiveFocus {
  commandId: string;
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

type ConversationPresentationState = Pick<
  PublicState,
  | "conversationName"
  | "cwd"
  | "selectedModel"
  | "selectedServiceTier"
  | "thinkingLevel"
  | "toolMode"
  | "availableThinkingLevels"
  | "providers"
  | "registryError"
  | "sessionTokenUsage"
  | "contextUsage"
  | "compactionThresholdPercent"
>;

function presentationFromState(
  state: PublicState,
): ConversationPresentationState {
  return {
    conversationName: state.conversationName,
    cwd: state.cwd,
    selectedModel: state.selectedModel,
    selectedServiceTier: state.selectedServiceTier,
    thinkingLevel: state.thinkingLevel,
    toolMode: state.toolMode,
    availableThinkingLevels: state.availableThinkingLevels,
    providers: state.providers,
    registryError: state.registryError,
    sessionTokenUsage: state.sessionTokenUsage,
    contextUsage: state.contextUsage,
    compactionThresholdPercent: state.compactionThresholdPercent,
  };
}

interface CachedWorkspaceProjection {
  projectId: string;
  conversationId: string;
  presentation: ConversationPresentationState;
  conversations: ConversationSummary[];
  roles: RoleTemplate[];
  conversationRole?: ConversationRoleSnapshot;
  conversationIndexTruncated: boolean;
  chat: typeof initialChatState;
}

interface CachedConversationPresentation {
  authority: "preview" | "snapshot";
  workspaceKey: string;
  projectId: string;
  conversationId: string;
  presentation: ConversationPresentationState;
  conversationRole?: ConversationRoleSnapshot;
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
  transitionOrigin?: TransitionOrigin;
  reconnectDraftOwner?: {
    workspaceKey: string;
    projectId: string;
    conversationId: string;
  };
}

interface SupersededFocusCommand {
  commandId: string;
  sessionId: string;
  workspaceKey: string;
  targetProjectId?: string;
  targetConversationId: string;
}

interface PendingColorScheme {
  commandId: string;
  colorScheme: ColorScheme;
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

interface TimingFrameRequest {
  attempt: TransitionTimingAttempt;
  source: TransitionPresentationSource;
  revision: number;
  interactive?: ClientTransitionObservation;
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

function activeFocusKey(focus: ActiveFocus): string {
  return `${focus.sessionId}\u0000${focus.projectId}\u0000${focus.conversationId}\u0000${focus.focusId}`;
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
  const phoneViewport = usePhoneViewport();
  const [initialPhoneNavigation] = useState(() =>
    loadInitialPhoneNavigation(phoneViewport));
  const [initialWorkspaces] = useState(() =>
    loadInitialWorkspaceState(initialPhoneNavigation.route));
  const [mobileScene, setMobileScene] = useState<MobileScene>(() => {
    const route = initialPhoneNavigation.route;
    if (route) return route.screen;
    return initialWorkspaces.activeCwd ? "conversations" : "workspaces";
  });
  const mobileSceneRef = useRef(mobileScene);
  const setPhoneScene = (scene: MobileScene) => {
    mobileSceneRef.current = scene;
    setMobileScene(scene);
  };
  const phoneRouteRef = useRef<PhoneHistoryRoute | undefined>(
    initialPhoneNavigation.route,
  );
  const phoneHistoryActiveRef = useRef(phoneViewport);
  const phoneHistoryEntriesRef = useRef<{
    entries: PhoneHistoryRoute[];
    index: number;
  }>({ entries: [], index: -1 });
  const deferredPhoneRouteRef = useRef<PhoneHistoryRoute | undefined>(undefined);
  const phoneRouteHandlerRef = useRef<(route: PhoneHistoryRoute) => void>(
    () => undefined,
  );
  const phoneRouteFailureHandlerRef = useRef<(pending: PendingFocus) => void>(
    () => undefined,
  );
  const phoneRouteDowngradeChatRef = useRef<(conversationId: string) => void>(
    () => undefined,
  );
  const phoneCreateRouteHandlerRef = useRef<(conversationId: string) => void>(
    () => undefined,
  );
  const phoneWorkbenchRef = useRef<HTMLDivElement>(null);
  const [transitionTiming] = useState(createTransitionTimingOwner);
  const [timingFrameRequest, setTimingFrameRequest] = useState<TimingFrameRequest>();
  const timingFrameRevisionRef = useRef(0);
  const transitionEventBufferRef = useRef<ServerEvent[] | undefined>(undefined);
  const socketEventHandlerRef = useRef<(event: ServerEvent) => void>(() => undefined);
  const hasCompletedInitialHandshakeRef = useRef(false);
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
  const conversationIdRef = useRef(
    initialPhoneNavigation.route?.screen === "chat"
      ? initialPhoneNavigation.route.conversationId
      : "",
  );
  const focusRef = useRef<ActiveFocus | undefined>(undefined);
  const pendingImageOpensRef = useRef(new Map<string, PendingImageOpen>());
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
  const updateDraft = (text: string) => setDraft(text);
  const [draftImages, setDraftImages] = useState<PromptImage[]>([]);
  const updateDraftImages = (images: PromptImage[]) => setDraftImages(images);
  const conversationDraftByScopeRef = useRef(
    new Map<string, ConversationComposerDraft>(),
  );
  const clearDraftProjection = () => {
    updateDraft("");
    updateDraftImages([]);
  };
  const [pendingPrompt, setPendingPrompt] = useState<DirectPendingPrompt>();
  const pendingPromptRef = useRef<DirectPendingPrompt | undefined>(undefined);
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
  const [pendingServiceTier, setPendingServiceTierState] =
    useState<PendingServiceTier>();
  const pendingServiceTierRef =
    useRef<PendingServiceTier | undefined>(undefined);
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
  const [loopList, setLoopList] = useState<LoopList>({ items: [], armed: false });
  const [conversationIndexTruncated, setConversationIndexTruncated] = useState(false);
  const authoritativeProjectMembershipRef = useRef(
    new Map<string, ReadonlySet<string>>(),
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
  const drawerReturnFocusRef = useRef<(() => HTMLElement | null) | null>(null);
  const [committedColorScheme, setCommittedColorSchemeState] =
    useState<ColorScheme>("quiet-rebel");
  const committedColorSchemeRef = useRef<ColorScheme>("quiet-rebel");
  const [unsavedColorScheme, setUnsavedColorSchemeState] =
    useState<ColorScheme>();
  const unsavedColorSchemeRef = useRef<ColorScheme | undefined>(undefined);
  const [pendingColorScheme, setPendingColorSchemeState] =
    useState<PendingColorScheme>();
  const pendingColorSchemeRef = useRef<PendingColorScheme | undefined>(undefined);
  const [colorSchemeSaveError, setColorSchemeSaveError] = useState("");
  const updateCommittedColorScheme = (colorScheme: ColorScheme) => {
    committedColorSchemeRef.current = colorScheme;
    setCommittedColorSchemeState(colorScheme);
  };
  const updateUnsavedColorScheme = (colorScheme: ColorScheme | undefined) => {
    unsavedColorSchemeRef.current = colorScheme;
    setUnsavedColorSchemeState(colorScheme);
  };
  const updatePendingColorScheme = (pending: PendingColorScheme | undefined) => {
    pendingColorSchemeRef.current = pending;
    setPendingColorSchemeState(pending);
  };
  const visibleColorScheme = unsavedColorScheme ?? committedColorScheme;
  useLayoutEffect(() => {
    document.documentElement.dataset.colorScheme = visibleColorScheme;
  }, [visibleColorScheme]);
  const [roleManagerOpen, setRoleManagerOpen] = useState(false);
  const [roleManagerInitialRoleId, setRoleManagerInitialRoleId] =
    useState<string | null>();
  const [selectingRole, setSelectingRole] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pendingRoleOperation, setPendingRoleOperation] =
    useState<PendingRoleOperation>();
  const pendingRoleOperationRef = useRef<PendingRoleOperation | undefined>(undefined);
  const [roleOperationResult, setRoleOperationResult] =
    useState<RoleOperationResult>();
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [chatBlockingModal, setChatBlockingModal] = useState(false);
  const [sidebarBlockingModal, setSidebarBlockingModal] = useState(false);
  const [error, setError] = useState("");
  const [settingResults, setSettingResults] = useState<SettingOperationResults>({});
  const pendingSettingCommandsRef = useRef<Partial<Record<
    SettingOperationResult["operation"],
    Pick<SettingOperationResult, "sessionId" | "commandId">
  >>>({});
  const [auth, setAuth] = useState<{ requestId?: string; request?: AuthRequest; progress?: string }>({});
  const [extensionUI, setExtensionUI] = useState<PendingExtensionUI[]>([]);
  const [notification, setNotification] = useState<{
    id: number;
    level: "info" | "warning" | "error";
    message: string;
  }>();
  const notificationIdRef = useRef(0);
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const chatRef = useRef(chat);
  const dispatchChat = (action: ChatAction): boolean => {
    const next = chatReducer(chatRef.current, action);
    if (next === chatRef.current) return false;
    chatRef.current = next;
    dispatch(action);
    return true;
  };
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
        presentation: presentationFromState(state),
        conversations: [...conversations],
        roles: [...roles],
        conversationRole,
        conversationIndexTruncated,
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
        presentation: presentationFromState(state),
        conversationRole,
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
    workspaceProjectionCacheRef.current.delete(workspaceKeyValue);
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
    if (key) workspaceProjectionCacheRef.current.delete(key);
    clearTemporaryWorkspacePresentation();
    setState(undefined);
    authoritativeProjectMembershipRef.current.clear();
    setConversations([]);
    setRoles([]);
    setConversationRole(undefined);
    setLoopList({ items: [], armed: false });
    setConversationIndexTruncated(false);
    dispatchChat({ type: "reset" });
  };
  const showCachedWorkspacePresentation = (
    cached: CachedWorkspaceProjection,
  ) => {
    cachedWorkspacePresentationKeyRef.current = currentWorkspaceKey();
    setCachedWorkspacePresentation(cached);
    setConversations(cached.conversations);
    setRoles(cached.roles);
    setConversationRole(cached.conversationRole);
    setConversationIndexTruncated(cached.conversationIndexTruncated);
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
  const showConversationDraft = (scope: {
    workspaceKey: string;
    projectId: string;
    conversationId: string;
  }) => {
    const key = pendingConversationKey(scope);
    const savedDraft = conversationDraftByScopeRef.current.get(key);
    updateDraft(savedDraft?.text ?? "");
    updateDraftImages(savedDraft?.images ?? []);
    setPromptNotice(
      savedDraft?.status === "unconfirmed" ? UNCONFIRMED_PROMPT_NOTICE : "",
    );
  };
  const updateConversationDraft = (next: Pick<
    ConversationComposerDraft,
    "text" | "images"
  >) => {
    const focus = focusRef.current;
    if (!focus) return;
    const key = conversationKey(focus);
    const savedDraft = conversationDraftByScopeRef.current.get(key);
    if (!next.text && next.images.length === 0) {
      conversationDraftByScopeRef.current.delete(key);
    } else {
      conversationDraftByScopeRef.current.set(key, {
        ...next,
        status: savedDraft?.status ?? "editing",
      });
    }
  };
  const rememberUnconfirmedPrompt = (pending: DirectPendingPrompt) => {
    conversationDraftByScopeRef.current.set(
      pendingConversationKey(pending),
      { text: pending.text, images: pending.images, status: "unconfirmed" },
    );
  };
  const forgetConversationDraft = (
    focus: Pick<DirectPendingPrompt, "workspaceKey" | "projectId" | "conversationId">,
  ) => {
    conversationDraftByScopeRef.current.delete(pendingConversationKey(focus));
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
  const updatePendingServiceTier = (
    pending: PendingServiceTier | undefined,
  ) => {
    pendingServiceTierRef.current = pending;
    setPendingServiceTierState(pending);
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
    if (pending) {
      pendingFocusedStateRef.current = undefined;
      setLoopList({ items: [], armed: false });
    }
    pendingFocusRef.current = pending;
    setPendingFocus(pending);
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
  const closePendingImageOpens = () => {
    for (const pending of pendingImageOpensRef.current.values()) {
      pending.target.close();
    }
    pendingImageOpensRef.current.clear();
  };
  const attachFocus = (
    sessionId: string,
    projectId: string,
    conversationId: string | undefined,
    focusId: string | undefined,
    preservePresentation = false,
    preserveDraft = false,
  ) => {
    closePendingImageOpens();
    updatePendingCompactionThreshold(undefined);
    updatePendingServiceTier(undefined);
    updatePendingConversationTruncation(undefined);
    const previousProjectId = projectIdRef.current;
    projectIdRef.current = projectId;
    if (!conversationId || !focusId) {
      focusRef.current = undefined;
      conversationIdRef.current = "";
      clearPendingAdmissions();
      showPendingContextCompaction(undefined);
      setConversationRole(undefined);
      setLoopList({ items: [], armed: false });
      updateConversationReady(false);
      setSelectingRole(true);
      clearDraftProjection();
      setPromptNotice("");
      dispatchChat({ type: "reset" });
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
      setLoopList({ items: [], armed: false });
      dispatchChat({ type: "focus_changed", ...focus });
    }
    updateConversationReady(false);
    setSelectingRole(false);
    if (changedConversation) {
      updatePendingPrompt(undefined);
      showPendingContextCompaction(focus);
    }
    if (!preserveDraft) {
      showConversationDraft({
        workspaceKey: currentWorkspaceKey(),
        projectId,
        conversationId,
      });
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
    const focus = focusRef.current;
    if (!focus) return;
    dispatchChat({
      type: "prompt_accepted",
      runId,
      text: pending.text || "[图片]",
      ...focus,
    });
    forgetConversationDraft(pending);
    clearDraftProjection();
    setPromptNotice("");
    updatePendingPrompt(undefined);
    updateOutstandingRunId(runId);
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
      updateDraftImages(pending.images);
      setPromptNotice(UNCONFIRMED_PROMPT_NOTICE);
    }
  };
  const updateConversationReady = (ready: boolean) => {
    conversationReadyRef.current = ready;
    setConversationReady(ready);
  };
  const requestTransitionFrame = (
    attempt: TransitionTimingAttempt | undefined,
    source: TransitionPresentationSource,
    interactive?: ClientTransitionObservation,
  ) => {
    if (!attempt) return;
    const revision = ++timingFrameRevisionRef.current;
    setTimingFrameRequest({ attempt, source, revision, interactive });
  };
  useLayoutEffect(() => {
    if (!timingFrameRequest) return;
    const request = timingFrameRequest;
    const frame = window.requestAnimationFrame(() => {
      if (
        timingFrameRevisionRef.current !== request.revision
        || !transitionTiming.isActive(request.attempt)
      ) return;
      const observation = request.interactive;
      if (observation) {
        const focus = focusRef.current;
        const exactFocus = observation.conversationId === undefined
          ? focus === undefined && sessionIdRef.current === observation.sessionId
          : Boolean(
              focus
              && focus.sessionId === observation.sessionId
              && focus.conversationId === observation.conversationId
              && focus.focusId === observation.focusId
              && conversationReadyRef.current,
            );
        if (!exactFocus) return;
      }
      transitionTiming.present(request.attempt, request.source);
      if (observation) transitionTiming.interactive(request.attempt, observation);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [timingFrameRequest, transitionTiming]);
  const sendTransitionCommand = (sendCommand: () => boolean) => {
    const events: ServerEvent[] = [];
    transitionEventBufferRef.current = events;
    try {
      return { sent: sendCommand(), events };
    } catch {
      setError("本地服务未连接");
      return { sent: false, events: [] };
    } finally {
      transitionEventBufferRef.current = undefined;
    }
  };
  const replayTransitionEvents = (events: ServerEvent[]) => {
    for (const event of events) socketEventHandlerRef.current(event);
  };
  const clearSessionProjection = () => {
    closePendingImageOpens();
    clearFocusReplacementAuthority();
    clearTemporaryWorkspacePresentation();
    clearTemporaryConversationPresentation();
    updateConversationSyncing(false);
    setState(undefined);
    authoritativeProjectMembershipRef.current.clear();
    setConversations([]);
    setRoles([]);
    setConversationRole(undefined);
    setLoopList({ items: [], armed: false });
    setConversationIndexTruncated(false);
    setExtensionUI([]);
    setNotification(undefined);
    pendingSettingCommandsRef.current = {};
    setSettingResults({});
    updatePendingCompactionThreshold(undefined);
    updatePendingServiceTier(undefined);
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
    setError(nextState.registryError ?? "");
    if (
      nextState.conversationId
      && !nextState.selectedModel
      && !autoOpened.current
    ) {
      autoOpened.current = true;
      drawerReturnFocusRef.current = null;
      setDrawer(true);
    }
  };
  const applyAttachedPublicState = (
    focus: ActiveFocus,
    pendingState?: PublicState,
  ) => {
    if (pendingState && stateMatchesFocus(pendingState, focus)) {
      applyPublicState(pendingState);
    }
  };
  const applyConversationSnapshot = (
    event: ConversationSnapshotEvent,
    settleReadiness = true,
  ) => {
    const focus = focusRef.current;
    if (!focus) return;
    if (!dispatchChat({
      type: "hydrate",
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      items: event.items,
      projectionSeq: event.projectionSeq,
      historyWindow: event.window,
    })) return;
    const snapshotObservation = {
      sessionId: event.sessionId,
      conversationId: event.conversationId,
      focusId: event.focusId,
    };
    if (settleReadiness && event.transitionDiagnostics) {
      transitionTiming.hostDiagnostics(
        snapshotObservation,
        event.transitionDiagnostics,
      );
    }
    const snapshotAttempt = settleReadiness
      ? transitionTiming.snapshotAccepted(snapshotObservation)
      : undefined;
    setConversationRole(event.role);
    setLoopList(event.loopList ?? { items: [], armed: false });
    if (event.pendingPrompts !== undefined) {
      replacePendingAdmissions(
        event.pendingPrompts.map(({ promptId, text }) => ({ promptId, text })),
      );
    }
    if (settleReadiness && !pendingFocusRef.current) {
      updateConversationReady(true);
      requestTransitionFrame(snapshotAttempt, "snapshot", {
        sessionId: event.sessionId,
        conversationId: event.conversationId,
        focusId: event.focusId,
      });
    }
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
    roles,
    state,
  ]);

  useEffect(() => {
    const initialPhoneMount = phoneHistoryActiveRef.current;
    if (!phoneViewport) {
      phoneHistoryActiveRef.current = false;
      phoneRouteRef.current = undefined;
      phoneHistoryEntriesRef.current = { entries: [], index: -1 };
      deferredPhoneRouteRef.current = undefined;
      return;
    }
    phoneHistoryActiveRef.current = true;
    if (initialPhoneMount) {
      const restored = readPhoneHistoryRoute();
      if (restored) {
        phoneRouteRef.current = restored;
        phoneHistoryEntriesRef.current = { entries: [], index: -1 };
      } else {
        const root: PhoneHistoryRoute = { screen: "workspaces" };
        replacePhoneHistoryRoute(root);
        const route = activeCwdRef.current
          ? { screen: "conversations" as const, cwd: activeCwdRef.current }
          : root;
        if (route.screen === "conversations") pushPhoneHistoryRoute(route);
        phoneRouteRef.current = route;
        phoneHistoryEntriesRef.current = route.screen === "conversations"
          ? { entries: [root, route], index: 1 }
          : { entries: [root], index: 0 };
      }
    } else {
      deferredPhoneRouteRef.current = undefined;
      const route: PhoneHistoryRoute = activeCwdRef.current
        ? mobileSceneRef.current === "chat" && focusRef.current
          ? {
              screen: "chat",
              cwd: activeCwdRef.current,
              conversationId: focusRef.current.conversationId,
            }
          : { screen: "conversations", cwd: activeCwdRef.current }
        : { screen: "workspaces" };
      replacePhoneHistoryRoute(route);
      phoneRouteRef.current = route;
      phoneHistoryEntriesRef.current = { entries: [route], index: 0 };
      const continuingRoleCreation = selectingRole || (
        pendingFocusRef.current?.operation === "create_conversation"
        && pendingFocusRef.current.workspaceKey === currentWorkspaceKey()
      );
      setPhoneScene(continuingRoleCreation ? "chat" : route.screen);
    }
    const onPopState = (event: PopStateEvent) => {
      const next = decodePhoneHistoryRoute(event.state);
      if (!next) {
        const fallback: PhoneHistoryRoute = { screen: "workspaces" };
        replacePhoneHistoryRoute(fallback);
        phoneRouteRef.current = fallback;
        phoneHistoryEntriesRef.current = { entries: [fallback], index: 0 };
        phoneRouteHandlerRef.current(fallback);
        return;
      }
      const owned = phoneHistoryEntriesRef.current;
      const current = owned.entries[owned.index];
      const parent = owned.entries[owned.index - 1];
      if (current && parent
        && phoneHistoryRouteEquals(current, phoneRouteRef.current)
        && phoneHistoryRouteEquals(parent, next)
      ) {
        owned.index -= 1;
      } else {
        phoneHistoryEntriesRef.current = { entries: [], index: -1 };
      }
      phoneRouteRef.current = next;
      phoneRouteHandlerRef.current(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [phoneViewport]);

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
    const handleSocketEvent = (event: ServerEvent) => {
      if (!isCurrentSocket()) return;
      const transitionEvents = transitionEventBufferRef.current;
      if (transitionEvents) {
        transitionEvents.push(event);
        return;
      }
      if (event.type === "hello") {
        if (event.protocolVersion !== PROTOCOL_VERSION) {
          const message = `协议版本不兼容：服务端 ${event.protocolVersion}，客户端 ${PROTOCOL_VERSION}`;
          transitionTiming.cancel("protocol-error");
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
          dispatchChat({ type: "reset" });
          setError(message);
          socket.close();
          return;
        }
        updateCommittedColorScheme(event.uiPreferences.colorScheme);
        if (unsavedColorSchemeRef.current && !pendingColorSchemeRef.current) {
          setColorSchemeSaveError("此配色尚未保存；请重试。");
        }
        setProtocolError("");
        const handshakeOrigin: TransitionOrigin = hasCompletedInitialHandshakeRef.current
          ? "reconnect"
          : "restore";
        hasCompletedInitialHandshakeRef.current = true;
        setProtocolReady(true);
        setSetupCwd((current) => current || event.startupCwd);
        if (activeCwdRef.current) {
          const activeWorkspaceKey = currentWorkspaceKey();
          const reconnectFocus = focusRef.current;
          const replacedPendingFocus = pendingFocusRef.current;
          const previousConversationId = conversationIdRef.current;
          const cached = getWorkspaceProjection(
            workspaceProjectionCacheRef.current,
            activeWorkspaceKey,
          );
          const phoneRoute = phoneHistoryActiveRef.current
            ? phoneRouteRef.current
            : undefined;
          const phoneRouteConversationId = phoneRoute?.screen === "chat"
            && workspaceKey(phoneRoute.cwd) === activeWorkspaceKey
            ? phoneRoute.conversationId
            : undefined;
          let conversation: Extract<
            ClientCommand,
            { type: "initialize" }
          >["conversation"];
          if (phoneRouteConversationId) {
            conversation = {
              kind: "open",
              conversationId: phoneRouteConversationId,
            };
          } else if (cached) {
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
          const inheritedReconnectDraftOwner = replacedPendingFocus?.reconnectDraftOwner;
          const reconnectDraftOwner = reconnectFocus
            ? {
                workspaceKey: activeWorkspaceKey,
                projectId: reconnectFocus.projectId,
                conversationId: reconnectFocus.conversationId,
              }
            : replacedPendingFocus?.operation === "initialize"
              && replacedPendingFocus.workspaceKey === activeWorkspaceKey
              && inheritedReconnectDraftOwner
              && inheritedReconnectDraftOwner.workspaceKey === activeWorkspaceKey
              && conversation.kind === "open"
              && conversation.conversationId === inheritedReconnectDraftOwner.conversationId
              && (!cached || cached.projectId === inheritedReconnectDraftOwner.projectId)
              ? {
                  workspaceKey: inheritedReconnectDraftOwner.workspaceKey,
                  projectId: inheritedReconnectDraftOwner.projectId,
                  conversationId: inheritedReconnectDraftOwner.conversationId,
                }
              : undefined;
          const sessionId = crypto.randomUUID();
          const commandId = crypto.randomUUID();
          const timingAttempt = transitionTiming.candidate({
            kind: "workspace",
            sessionId,
            commandId,
            origin: handshakeOrigin,
            intentViewport: phoneViewport ? "mobile" : "desktop",
            cacheAtIntent: cached ? "hit" : "miss",
          });
          const { sent, events } = sendTransitionCommand(() => socket.send({
            type: "initialize",
            commandId,
            sessionId,
            cwd: activeCwdRef.current,
            conversation,
          }));
          if (!sent) {
            transitionTiming.fail(timingAttempt, "send-failed");
            return;
          }
          transitionTiming.promote(timingAttempt);
          sessionIdRef.current = sessionId;
          authFlowIdRef.current = "";
          projectIdRef.current = "";
          focusRef.current = undefined;
          conversationIdRef.current = conversation.kind === "open"
            ? conversation.conversationId
            : "";
          const targetDraftProjectId = cached?.projectId
            ?? (reconnectDraftOwner?.conversationId === conversationIdRef.current
              ? reconnectDraftOwner.projectId
              : undefined);
          if (conversation.kind === "open" && targetDraftProjectId) {
            showConversationDraft({
              workspaceKey: activeWorkspaceKey,
              projectId: targetDraftProjectId,
              conversationId: conversation.conversationId,
            });
          } else {
            clearDraftProjection();
            setPromptNotice("");
          }
          updateOutstandingRunId("");
          setAuth({});
          dispatchChat({ type: "reset" });
          clearSessionProjection();
          updateWorkspaceSyncing(Boolean(cached));
          if (cached) showCachedWorkspacePresentation(cached);
          updatePendingFocus({
            commandId,
            operation: "initialize",
            workspaceKey: activeWorkspaceKey,
            initializeConversationKind: conversation.kind,
            transitionOrigin: handshakeOrigin,
            ...(conversation.kind === "open"
              ? { targetConversationId: conversation.conversationId }
              : {}),
            ...(cached ? { cachedProjectId: cached.projectId } : {}),
            ...(reconnectDraftOwner ? { reconnectDraftOwner } : {}),
          });
          requestTransitionFrame(timingAttempt, cached ? "cache" : "placeholder");
          replayTransitionEvents(events);
        }
      } else if (event.type === "ui_preferences_changed") {
        updateCommittedColorScheme(event.uiPreferences.colorScheme);
        if (!event.commandId) return;
        const pending = pendingColorSchemeRef.current;
        if (!pending || pending.commandId !== event.commandId) return;
        updatePendingColorScheme(undefined);
        if (
          pending.colorScheme === event.uiPreferences.colorScheme
          && unsavedColorSchemeRef.current === event.uiPreferences.colorScheme
        ) {
          updateUnsavedColorScheme(undefined);
          setColorSchemeSaveError("");
        } else {
          setColorSchemeSaveError("服务端确认的配色与本地预览不同；请重试。");
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
          && !stateMatchesFocus(event.state, currentFocus)
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
          presentation: {
            cwd: event.cwd,
            selectedServiceTier: null,
            thinkingLevel: previewThinkingLevel,
            toolMode: event.toolMode,
            availableThinkingLevels: [previewThinkingLevel],
            providers: [],
          },
          conversationRole: event.role,
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
        requestTransitionFrame(
          transitionTiming.attemptFor({
            kind: pending.operation === "initialize" ? "workspace" : "conversation",
            sessionId: event.sessionId,
            commandId: event.commandId,
          }),
          "preview",
        );
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
        const correlatedReconnectDraftOwner =
          pending?.operation === "initialize"
          && event.operation === "initialize"
          && pending.commandId === event.commandId
          && pending.workspaceKey === currentWorkspaceKey()
            ? pending.reconnectDraftOwner
            : undefined;
        if (
          correlatedReconnectDraftOwner
          && (
            correlatedReconnectDraftOwner.workspaceKey !== currentWorkspaceKey()
            || correlatedReconnectDraftOwner.projectId !== event.projectId
            || correlatedReconnectDraftOwner.conversationId !== event.conversationId
          )
        ) {
          conversationDraftByScopeRef.current.delete(
            pendingConversationKey(correlatedReconnectDraftOwner),
          );
          clearDraftProjection();
          setPromptNotice("");
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
        const attachedTimingAttempt = transitionTiming.attach({
          kind: event.operation === "initialize" ? "workspace" : "conversation",
          sessionId: event.sessionId,
          commandId: event.commandId,
          conversationId: event.conversationId,
          focusId: event.focusId,
        });
        if (event.transitionDiagnostics) {
          transitionTiming.hostDiagnostics({
            sessionId: event.sessionId,
            conversationId: event.conversationId,
            focusId: event.focusId,
          }, event.transitionDiagnostics);
        }
        updatePendingFocus(undefined);
        updateConversationSyncing(
          event.operation === "focus_conversation"
          || event.operation === "create_conversation",
        );
        const preserveReconnectDraft = Boolean(
          correlatedReconnectDraftOwner
          && correlatedReconnectDraftOwner.workspaceKey === pending.workspaceKey
          && correlatedReconnectDraftOwner.projectId === event.projectId
          && correlatedReconnectDraftOwner.conversationId === event.conversationId,
        );
        attachFocus(
          event.sessionId,
          event.projectId,
          event.conversationId,
          event.focusId,
          Boolean(pending.cachedProjectId && !cachedProjectMismatch),
          preserveReconnectDraft,
        );
        if (
          event.operation === "initialize"
          && event.conversationId === undefined
          && event.focusId === undefined
        ) {
          requestTransitionFrame(attachedTimingAttempt, "placeholder", {
            sessionId: event.sessionId,
          });
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
          if (event.operation === "create_conversation") {
            phoneCreateRouteHandlerRef.current(event.conversationId);
          }
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
                compactionAttempt: undefined,
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
        phoneRouteDowngradeChatRef.current(event.conversationId);
        const invalidatedWorkspaceKey = currentWorkspaceKey();
        const deletion = pendingConversationDeletionRef.current;
        if (
          deletion
          && deletion.sessionId === event.sessionId
          && deletion.workspaceKey === invalidatedWorkspaceKey
          && deletion.projectId === event.projectId
          && deletion.affectedFocus === undefined
        ) {
          updatePendingConversationDeletion({
            ...deletion,
            affectedFocus: {
              conversationId: event.conversationId,
              focusId: event.focusId,
            },
          });
        }
        const pendingRoleSwitch = pendingConversationRoleSwitchRef.current;
        if (
          pendingRoleSwitch
          && pendingRoleSwitch.sessionId === event.sessionId
          && pendingRoleSwitch.projectId === event.projectId
          && pendingRoleSwitch.conversationId === event.conversationId
          && pendingRoleSwitch.focusId === event.focusId
        ) {
          updatePendingConversationRoleSwitch(undefined);
        }
        clearFocusReplacementAuthority();
        pendingFocusedStateRef.current = undefined;
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
        conversationPresentationCacheRef.current.delete(invalidatedConversationKey);
        clearTemporaryConversationPresentation();
        updateConversationSyncing(false);
        conversationDraftByScopeRef.current.delete(
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
        clearDraftProjection();
        setPromptNotice("");
        updatePendingPrompt(undefined);
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
        const membershipIsAuthoritative = event.coverage === "complete"
          && !event.truncated;
        if (membershipIsAuthoritative) {
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
            workspaceProjectionCacheRef.current.delete(workspaceKeyValue);
            if (cachedWorkspacePresentationKeyRef.current === workspaceKeyValue) {
              clearTemporaryWorkspacePresentation();
            }
          }
        }
        for (const [cacheKey, presentation] of conversationPresentationCacheRef.current) {
          if (
            membershipIsAuthoritative
            && presentation.workspaceKey === currentWorkspaceKey()
            && presentation.projectId === event.projectId
            && !existingConversationIds.has(presentation.conversationId)
          ) {
            conversationPresentationCacheRef.current.delete(cacheKey);
            if (cachedConversationPresentationKeyRef.current === cacheKey) {
              clearTemporaryConversationPresentation();
            }
          }
        }
        const currentPhoneRoute = phoneRouteRef.current;
        if (
          membershipIsAuthoritative
          && currentPhoneRoute?.screen === "chat"
          && !existingConversationIds.has(currentPhoneRoute.conversationId)
        ) {
          phoneRouteDowngradeChatRef.current(currentPhoneRoute.conversationId);
        }
        setConversations((current) => membershipIsAuthoritative
          ? event.conversations
          : [
              ...event.conversations,
              ...current.filter(({ id }) => !existingConversationIds.has(id)),
            ]);
        setConversationIndexTruncated(
          event.truncated || event.coverage !== "complete",
        );
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
          forgetConversationDraft(pending);
          clearDraftProjection();
          setPromptNotice("");
          updatePendingPrompt(undefined);
          if (outstandingRunIdRef.current === pending.runId) {
            updateOutstandingRunId("");
          }
        }
        addPendingAdmission({ promptId: event.promptId, text: event.text });
      } else if (event.type === "prompt_delivered") {
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        removePendingAdmission(event.promptId);
      } else if (event.type === "conversation_image") {
        const pending = pendingImageOpensRef.current.get(event.commandId);
        if (!pending) return;
        pendingImageOpensRef.current.delete(event.commandId);
        if (
          pending.sessionId !== event.sessionId
          || pending.conversationId !== event.conversationId
          || pending.focusId !== event.focusId
          || pending.messageId !== event.messageId
          || pending.imageOrdinal !== event.imageOrdinal
          || !matchesFocus(event.sessionId, event.conversationId, event.focusId)
        ) {
          pending.target.close();
          return;
        }
        try {
          const binary = window.atob(event.data);
          const bytes = Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], {
            type: event.mimeType,
          }));
          pending.target.location.replace(url);
        } catch {
          pending.target.close();
          setError("无法打开图片");
        }
      } else if (event.type === "loop_list_update") {
        if (pendingFocusRef.current) return;
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        setLoopList(event.loopList);
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
        const focus = focusRef.current;
        if (!focus) return;
        const observedAt = Date.now();
        dispatchChat({
          type: "session",
          runId: event.runId,
          event: event.event,
          observedAt,
          projectionSeq: event.projectionSeq,
          ...focus,
        });
      } else if (event.type === "conversation_item") {
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        const focus = focusRef.current;
        if (!focus) return;
        dispatchChat({
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
        if (event.operation === "set_service_tier") {
          const pending = pendingServiceTierRef.current;
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.sessionId !== event.sessionId
            || !matchesFocus(
              pending.sessionId,
              pending.conversationId,
              pending.focusId,
            )
          ) return;
          updatePendingServiceTier(undefined);
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
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.sessionId !== event.sessionId
          ) return;
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
          const targetKey = pendingConversationKey(pending);
          const affectedFocusKey = pending.affectedFocus
            ? conversationScopeKey(
                pending.workspaceKey,
                pending.projectId,
                pending.affectedFocus.conversationId,
              )
            : undefined;
          setConversations((current) => projectConversationsDuringDeletion(
            current,
            pending.conversationId,
            pending.affectedFocus?.conversationId,
          ));
          updatePendingConversationDeletion(undefined);
          forgetWorkspaceConversationProjection(
            pending.workspaceKey,
            pending.projectId,
            pending.conversationId,
          );
          if (
            pending.affectedFocus
            && pending.affectedFocus.conversationId !== pending.conversationId
          ) {
            forgetWorkspaceConversationProjection(
              pending.workspaceKey,
              pending.projectId,
              pending.affectedFocus.conversationId,
            );
          }
          conversationPresentationCacheRef.current.delete(targetKey);
          if (affectedFocusKey) {
            conversationPresentationCacheRef.current.delete(affectedFocusKey);
          }
          if (
            cachedConversationPresentationKeyRef.current === targetKey
            || cachedConversationPresentationKeyRef.current === affectedFocusKey
          ) {
            clearTemporaryConversationPresentation();
          }

          conversationDraftByScopeRef.current.delete(targetKey);
          if (affectedFocusKey) {
            conversationDraftByScopeRef.current.delete(affectedFocusKey);
          }
          if (
            pending.affectedFocus !== undefined
            && focusRef.current?.sessionId === pending.sessionId
            && focusRef.current.projectId === pending.projectId
            && focusRef.current.conversationId
              === pending.affectedFocus.conversationId
            && focusRef.current.focusId === pending.affectedFocus.focusId
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
            clearDraftProjection();
            setPromptNotice("");
            updatePendingPrompt(undefined);
            const deletedCompaction =
              pendingContextCompactionRegistryRef.current.get({
                workspaceKey: pending.workspaceKey,
                projectId: pending.projectId,
                conversationId: pending.affectedFocus.conversationId,
              });
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
        if (
          event.operation !== "set_api_key"
          && event.operation !== "refresh_models"
        ) return;
        const pending = pendingSettingCommandsRef.current[event.operation];
        if (
          !pending
          || pending.sessionId !== event.sessionId
          || pending.commandId !== event.commandId
        ) return;
        const result: SettingOperationResult = {
          operation: event.operation,
          sessionId: event.sessionId,
          commandId: event.commandId,
          ok: true,
          message: "",
        };
        setSettingResults((current) => ({
          ...current,
          [result.operation]: result,
        }));
      } else if (event.type === "error") {
        const pendingImageOpen = event.operation === "open_image" && event.commandId
          ? pendingImageOpensRef.current.get(event.commandId)
          : undefined;
        if (
          pendingImageOpen
          && pendingImageOpen.sessionId === event.sessionId
          && pendingImageOpen.conversationId === event.conversationId
          && pendingImageOpen.focusId === event.focusId
        ) {
          pendingImageOpensRef.current.delete(pendingImageOpen.commandId);
          pendingImageOpen.target.close();
          if (matchesFocus(
            pendingImageOpen.sessionId,
            pendingImageOpen.conversationId,
            pendingImageOpen.focusId,
          )) {
            setError(`打开图片失败：${event.message}`);
          }
          return;
        }
        if (event.operation === "set_color_scheme" && event.commandId) {
          const pending = pendingColorSchemeRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingColorScheme(undefined);
          setColorSchemeSaveError(`配色未保存：${event.message}`);
          return;
        }
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
        if (event.operation === "set_service_tier" && event.commandId) {
          const pending = pendingServiceTierRef.current;
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.sessionId !== event.sessionId
            || pending.conversationId !== event.conversationId
            || pending.focusId !== event.focusId
          ) return;
          updatePendingServiceTier(undefined);
          setError(`修改服务层级失败：${event.message}`);
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
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.sessionId !== event.sessionId
            || pending.conversationId !== event.conversationId
            || pending.focusId !== event.focusId
          ) return;
          updatePendingConversationRoleSwitch(undefined);
          setError(`更换会话角色失败：${event.message}`);
          return;
        }
        if (
          event.operation === "delete_conversation"
          && event.commandId
        ) {
          const pending = pendingConversationDeletionRef.current;
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.sessionId !== event.sessionId
          ) return;
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
          transitionTiming.failMatching({
            kind: pending.operation === "initialize" ? "workspace" : "conversation",
            sessionId: sessionIdRef.current,
            commandId: pending.commandId,
          }, "server-error");
          const deferred = deferredFocusAuthorityRef.current;
          phoneRouteFailureHandlerRef.current(pending);
          if (
            pending.operation === "initialize"
            && pending.initializeConversationKind === "open"
          ) {
            if (pending.cachedProjectId && pending.targetConversationId) {
              conversationPresentationCacheRef.current.delete(
                conversationScopeKey(
                  pending.workspaceKey,
                  pending.cachedProjectId,
                  pending.targetConversationId,
                ),
              );
              forgetWorkspaceConversationProjection(
                pending.workspaceKey,
                pending.cachedProjectId,
                pending.targetConversationId,
              );
            }
            initialize(
              activeCwdRef.current,
              { kind: "recent" },
              undefined,
              socket,
              pending.transitionOrigin,
            );
            return;
          }
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
            showConversationDraft({
              workspaceKey: pending.workspaceKey,
              projectId: pending.sourceFocus.projectId,
              conversationId: pending.sourceFocus.conversationId,
            });
            updateConversationReady(true);
          }
          if (event.operation === "initialize") {
            clearTemporaryConversationPresentation();
            if (pending.cachedProjectId) discardCachedWorkspacePresentation();
            conversationIdRef.current = "";
            updateWorkspaceSyncing(false);
            updateConversationSyncing(false);
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
            || event.operation === "refresh_models")
        ) {
          if (!event.sessionId) {
            setError("设置命令响应缺少会话标识");
            return;
          }
          const pending = pendingSettingCommandsRef.current[event.operation];
          if (
            !pending
            || pending.sessionId !== event.sessionId
            || pending.commandId !== event.commandId
          ) return;
          const result: SettingOperationResult = {
            operation: event.operation,
            sessionId: event.sessionId,
            commandId: event.commandId,
            ok: false,
            message: event.message,
          };
          setSettingResults((current) => ({
            ...current,
            [result.operation]: result,
          }));
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
            dispatchChat({
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
    };
    socketEventHandlerRef.current = handleSocketEvent;
    const socket = new PiSocket(handleSocketEvent, (connected) => {
      if (!isCurrentSocket()) return;
      setTransportOnline(connected);
      if (!connected) {
        closePendingImageOpens();
        transitionTiming.cancel("disconnect");
        setProtocolReady(false);
        setProjectActivityByWorkspace(new Map());
        setProjectActivityTruncated(false);
        pendingSettingCommandsRef.current = {};
        setSettingResults({});
        if (pendingColorSchemeRef.current) {
          updatePendingColorScheme(undefined);
          setColorSchemeSaveError("连接已断开，无法确认配色是否保存；重连后请重试。");
        }
        updateDirectoryBrowser(undefined);
        markPendingPromptUnconfirmed();
        const pendingRoleOperation = pendingRoleOperationRef.current;
        if (pendingRoleOperation) {
          pendingRoleOperationRef.current = undefined;
          setRoleOperationResult({
            ...pendingRoleOperation,
            ok: false,
            message: "连接已断开，角色操作结果未确认；重连后请检查当前角色目录。",
          });
        }
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
        if (pendingServiceTierRef.current) {
          updatePendingServiceTier(undefined);
          setError("服务层级修改状态未确认，请重连后检查当前设置。");
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
      closePendingImageOpens();
      transitionTiming.cancel("destroyed");
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

  const saveColorScheme = (colorScheme: ColorScheme, force = false) => {
    if (pendingColorSchemeRef.current) return;
    if (!force && colorScheme === committedColorSchemeRef.current) {
      updateUnsavedColorScheme(undefined);
      setColorSchemeSaveError("");
      return;
    }
    updateUnsavedColorScheme(colorScheme);
    setColorSchemeSaveError("");
    if (!protocolReady || !transportOnline) {
      setColorSchemeSaveError("配色已在本地预览，但尚未保存；重连后请重试。");
      return;
    }
    const pending = { commandId: crypto.randomUUID(), colorScheme };
    updatePendingColorScheme(pending);
    if (!socketRef.current?.send({
      type: "set_color_scheme",
      commandId: pending.commandId,
      colorScheme,
    })) {
      updatePendingColorScheme(undefined);
      setColorSchemeSaveError("配色已在本地预览，但尚未保存；请重试。");
    }
  };
  const openImage = useCallback(({
    messageId,
    imageOrdinal,
  }: ConversationImageLocator) => {
    const focus = focusRef.current;
    if (!focus || !conversationReadyRef.current || !protocolReady) {
      setError("当前对话尚未准备好打开图片");
      return;
    }
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setError("浏览器阻止了图片窗口");
      return;
    }
    const commandId = crypto.randomUUID();
    const pending: PendingImageOpen = {
      ...focus,
      commandId,
      messageId,
      imageOrdinal,
      target,
    };
    pendingImageOpensRef.current.set(commandId, pending);
    const sent = socketRef.current?.send({
      type: "open_image",
      commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      messageId,
      imageOrdinal,
    }) ?? false;
    if (!sent) {
      pendingImageOpensRef.current.delete(commandId);
      target.close();
      setError("本地服务未连接");
    }
  }, [protocolReady]);
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
  const consumeSettingResult = useCallback((consumed: SettingOperationResult) => {
    const pending = pendingSettingCommandsRef.current[consumed.operation];
    if (
      pending?.sessionId === consumed.sessionId
      && pending.commandId === consumed.commandId
    ) delete pendingSettingCommandsRef.current[consumed.operation];
    setSettingResults((current) => {
      const result = current[consumed.operation];
      if (
        result?.sessionId !== consumed.sessionId
        || result.commandId !== consumed.commandId
      ) return current;
      return { ...current, [consumed.operation]: undefined };
    });
  }, []);
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
  function initialize(
    cwd: string,
    conversation: Extract<ClientCommand, { type: "initialize" }>["conversation"] = {
      kind: "recent",
    },
    cached?: CachedWorkspaceProjection,
    transport?: PiSocket,
    origin: TransitionOrigin = "user",
  ) {
    const normalizedCwd = cwd.trim();
    const sessionId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const timingIntent = {
      kind: "workspace" as const,
      sessionId,
      commandId,
      origin,
      intentViewport: phoneViewport ? "mobile" as const : "desktop" as const,
      cacheAtIntent: cached ? "hit" as const : "miss" as const,
    };
    const timingAttempt = transitionTiming.candidate(timingIntent);
    const command = {
      type: "initialize" as const,
      commandId,
      sessionId,
      cwd: normalizedCwd,
      conversation,
    };
    const { sent, events } = sendTransitionCommand(
      () => transport ? transport.send(command) : send(command),
    );
    if (!sent) {
      transitionTiming.fail(timingAttempt, "send-failed");
      if (transport) setError("本地服务未连接");
      return false;
    }
    transitionTiming.promote(timingAttempt);
    // Directory browsing is connection-scoped, not a project transition.
    // A new initialize replaces its local observation scope, so any late
    // listing must find no live browser to update.
    updateDirectoryBrowser(undefined);
    setError("");
    markPendingPromptUnconfirmed();
    clearDraftProjection();
    setPromptNotice("");
    clearSessionProjection();
    setSetupOpen(false);
    rememberWorkspace(normalizedCwd);
    setActiveCwd(normalizedCwd);
    activeCwdRef.current = normalizedCwd;
    sessionIdRef.current = sessionId;
    projectIdRef.current = "";
    focusRef.current = undefined;
    conversationIdRef.current = conversation?.kind === "open"
      ? conversation.conversationId
      : "";
    if (cached && conversation?.kind === "open") {
      showConversationDraft({
        workspaceKey: currentWorkspaceKey(),
        projectId: cached.projectId,
        conversationId: conversation.conversationId,
      });
    }
    authFlowIdRef.current = "";
    updateOutstandingRunId("");
    setAuth({});
    autoOpened.current = false;
    updateWorkspaceSyncing(Boolean(cached));
    if (cached) showCachedWorkspacePresentation(cached);
    dispatchChat({ type: "reset" });
    updatePendingFocus({
      commandId,
      operation: "initialize",
      workspaceKey: currentWorkspaceKey(),
      initializeConversationKind: conversation?.kind ?? "recent",
      transitionOrigin: origin,
      ...(conversation?.kind === "open"
        ? { targetConversationId: conversation.conversationId }
        : {}),
      ...(cached ? { cachedProjectId: cached.projectId } : {}),
    });
    requestTransitionFrame(timingAttempt, cached ? "cache" : "placeholder");
    replayTransitionEvents(events);
    return true;
  }
  const initializeWorkspace = (cwd: string) => {
    const cached = getWorkspaceProjection(
      workspaceProjectionCacheRef.current,
      workspaceKey(cwd),
    );
    return initialize(
      cwd,
      cached
        ? { kind: "open", conversationId: cached.conversationId }
        : { kind: "recent" },
      cached,
    );
  };
  const sendPrompt = (text: string, images: PromptImage[]): boolean => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || !conversationReadyRef.current) return false;
    if (pendingConversationTruncationRef.current) return false;
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    if (!sessionId || !focus || focus.sessionId !== sessionId) return false;
    const knownRunOwnerId = state?.activeRun?.id || outstandingRunIdRef.current;
    const runId = crypto.randomUUID();
    const promptId = crypto.randomUUID();
    const command = {
      type: "prompt" as const,
      sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      runId,
      promptId,
      text: trimmed,
      ...(images.length === 0 ? {} : { images }),
    };
    if (new TextEncoder().encode(JSON.stringify(command)).byteLength > MAX_MESSAGE_BYTES) {
      setPromptNotice("图片和消息合计超过单条传输上限，请移除图片或缩短消息。");
      return false;
    }
    const pending: DirectPendingPrompt = {
      ...focus,
      workspaceKey: currentWorkspaceKey(),
      runId,
      promptId,
      text: trimmed,
      images,
    };
    setPromptNotice("");
    updatePendingPrompt(pending);
    if (!knownRunOwnerId) updateOutstandingRunId(runId);
    const ok = send(command);
    if (!ok) {
      updatePendingPrompt(undefined);
      if (outstandingRunIdRef.current === runId) updateOutstandingRunId("");
      setPromptNotice("消息未发送，内容已保留，可以重试。");
    }
    return ok;
  };
  const submitPrompt = (text: string, images: PromptImage[]): boolean => {
    const trimmed = text.trim();
    if (
      (!trimmed && images.length === 0)
      || !conversationReadyRef.current
      || pendingConversationRoleSwitchRef.current
    ) return false;
    if (trimmed.length > MAX_PROMPT_CHARACTERS) {
      setPromptNotice(`单条消息最多 ${MAX_PROMPT_CHARACTERS.toLocaleString()} 个字符。`);
      return false;
    }
    return sendPrompt(trimmed, images);
  };
  const abortCurrentRun = () => {
    if (!conversationReadyRef.current || pendingFocusRef.current) return;
    const runId = state?.activeRun?.id || outstandingRunIdRef.current;
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
    ) return false;
    if (
      previousPending?.operation === "focus_conversation"
      && previousPending.targetConversationId === conversationId
    ) return true;
    const replacingDifferentPendingTarget = Boolean(
      replacingPendingFocus
      && previousPending.targetConversationId !== conversationId,
    );
    if (
      !replacingDifferentPendingTarget
      && focusRef.current?.conversationId === conversationId
    ) {
      setSelectingRole(false);
      return true;
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
    const timingAttempt = transitionTiming.candidate({
      ...timingIntent,
      origin: "user",
      intentViewport: phoneViewport ? "mobile" : "desktop",
      cacheAtIntent: targetPresentation ? "hit" : "miss",
    });
    const { sent, events } = sendTransitionCommand(() => send(command));
    if (!sent) {
      transitionTiming.fail(timingAttempt, "send-failed");
      return false;
    }
    if (replacingPendingFocus) {
      rememberSupersededFocusCommand(previousPending);
    }
    transitionTiming.promote(timingAttempt);
    // A focus replacement also ends a connection-level directory browse.
    updateDirectoryBrowser(undefined);
    setError("");
    clearPendingAdmissions();
    cacheCurrentConversationPresentation();
    if (targetProjectId) {
      showConversationDraft({
        workspaceKey: workspaceKeyValue,
        projectId: targetProjectId,
        conversationId,
      });
    } else {
      clearDraftProjection();
      setPromptNotice("");
    }
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
    requestTransitionFrame(
      timingAttempt,
      targetPresentation ? "cache" : "placeholder",
    );
    replayTransitionEvents(events);
    return true;
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
    const timingAttempt = transitionTiming.candidate({
      kind: "conversation",
      sessionId,
      commandId,
      origin: "user",
      intentViewport: phoneViewport ? "mobile" : "desktop",
      cacheAtIntent: "n/a",
    });
    const { sent, events } = sendTransitionCommand(() => send({
      type: "create_conversation",
      commandId,
      sessionId,
      roleId,
    }));
    if (!sent) {
      transitionTiming.fail(timingAttempt, "send-failed");
      return;
    }
    transitionTiming.promote(timingAttempt);
    updateDirectoryBrowser(undefined);
    updatePendingFocus({
      commandId,
      operation: "create_conversation",
      workspaceKey: currentWorkspaceKey(),
    });
    setError("");
    requestTransitionFrame(timingAttempt, "placeholder");
    replayTransitionEvents(events);
  };
  const deleteConversation = (conversationId: string): boolean => {
    const sessionId = sessionIdRef.current;
    const conversation = conversations.find(({ id }) => id === conversationId);
    const projectId = projectIdRef.current;
    const focus = focusRef.current;
    const affectedFocus = focus?.projectId === projectId
      && conversations.some((candidate) => (
        candidate.id === focus.conversationId
        && isAffectedByDeletionProjection(candidate, conversationId)
      ))
      ? {
          conversationId: focus.conversationId,
          focusId: focus.focusId,
        }
      : undefined;
    if (
      !sessionId
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || focusedConversationNeedsSnapshot()
      || !projectId
      || !conversation
      || (conversation.activity?.kind ?? "idle") !== "idle"
      || (
        affectedFocus
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
      ...(affectedFocus ? { affectedFocus } : {}),
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
      updateConversationDraft({ text, images: draftImages });
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
  const setServiceTier = (serviceTier: ServiceTier | null): boolean => {
    const focus = focusRef.current;
    if (
      !focus
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || !conversationReadyRef.current
      || pendingFocusRef.current
      || state?.busy
      || state?.compacting
      || pendingServiceTierRef.current
    ) return false;
    const pending = {
      ...focus,
      commandId: crypto.randomUUID(),
    };
    updatePendingServiceTier(pending);
    setError("");
    if (send({
      type: "set_service_tier",
      commandId: pending.commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      serviceTier,
    })) return true;
    updatePendingServiceTier(undefined);
    return false;
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
  const switchConversationRole = (
    roleId: string,
    expectedFocusKey: string,
  ): boolean => {
    const focus = focusRef.current;
    if (
      !focus
      || activeFocusKey(focus) !== expectedFocusKey
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
      ...focus,
      commandId: crypto.randomUUID(),
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
      pendingRoleOperationRef.current = undefined;
      setRoleOperationResult({
        ...pending,
        ok: false,
        message: "本地服务未连接，角色操作未发送；请重连后重试。",
      });
    }
  };
  const switchWorkspace = (cwd: string) => {
    if (!transportOnline || !protocolReady) {
      setError(protocolReady ? "本地服务未连接" : "本地服务尚未完成协议握手");
      return false;
    }
    const targetWorkspaceKey = workspaceKey(cwd);
    const pending = pendingFocusRef.current;
    if (
      targetWorkspaceKey === workspaceKey(activeCwdRef.current)
      && (
        state !== undefined
        || workspaceSyncingRef.current
        || (
          pending?.operation === "initialize"
          && pending.workspaceKey === targetWorkspaceKey
        )
      )
    ) {
      setSetupOpen(false);
      updateDirectoryBrowser(undefined);
      return true;
    }
    cacheCurrentWorkspaceProjection();
    cacheCurrentConversationPresentation();
    return initializeWorkspace(cwd);
  };
  const replaceCurrentPhoneRoute = (route: PhoneHistoryRoute) => {
    if (!phoneViewport) return;
    phoneRouteRef.current = route;
    phoneHistoryEntriesRef.current = { entries: [route], index: 0 };
    replacePhoneHistoryRoute(route);
  };
  const pushCurrentPhoneRoute = (route: PhoneHistoryRoute) => {
    if (!phoneViewport || phoneHistoryRouteEquals(phoneRouteRef.current, route)) return;
    const owned = phoneHistoryEntriesRef.current;
    const current = owned.entries[owned.index];
    if (current && phoneHistoryRouteEquals(current, phoneRouteRef.current)) {
      const entries = [...owned.entries.slice(0, owned.index + 1), route];
      const start = Math.max(0, entries.length - MAX_PHONE_HISTORY_ENTRIES);
      phoneHistoryEntriesRef.current = {
        entries: entries.slice(start),
        index: entries.length - start - 1,
      };
    } else {
      phoneHistoryEntriesRef.current = { entries: [route], index: 0 };
    }
    phoneRouteRef.current = route;
    pushPhoneHistoryRoute(route);
  };
  const phoneFallbackRoute = (): PhoneHistoryRoute => (
    activeCwdRef.current
      ? { screen: "conversations", cwd: activeCwdRef.current }
      : { screen: "workspaces" }
  );
  const navigatePhoneHistoryRoute = (route: PhoneHistoryRoute) => {
    if (!phoneViewport) return;
    if (phoneRouteBlocked) {
      deferredPhoneRouteRef.current = route;
      return;
    }
    phoneRouteRef.current = route;
    setSelectingRole(false);
    if (route.screen === "workspaces") {
      setPhoneScene("workspaces");
      return;
    }
    if (route.screen === "conversations") {
      if (switchWorkspace(route.cwd)) {
        setPhoneScene("conversations");
        return;
      }
      const fallback = phoneFallbackRoute();
      replaceCurrentPhoneRoute(fallback);
      setPhoneScene(fallback.screen);
      return;
    }
    const accepted = workspaceKey(route.cwd) === workspaceKey(activeCwdRef.current)
      && state
      ? focusConversation(route.conversationId)
      : initialize(route.cwd, {
          kind: "open",
          conversationId: route.conversationId,
        });
    if (accepted) {
      setPhoneScene("chat");
      return;
    }
    const fallback = phoneFallbackRoute();
    replaceCurrentPhoneRoute(fallback);
    setPhoneScene(fallback.screen);
  };
  phoneRouteHandlerRef.current = navigatePhoneHistoryRoute;
  phoneCreateRouteHandlerRef.current = (conversationId) => {
    const route = phoneRouteRef.current;
    if (
      !phoneViewport
      || route?.screen !== "conversations"
      || workspaceKey(route.cwd) !== currentWorkspaceKey()
      || mobileSceneRef.current !== "chat"
    ) return;
    pushCurrentPhoneRoute({
      screen: "chat",
      cwd: route.cwd,
      conversationId,
    });
  };
  phoneRouteFailureHandlerRef.current = (pending) => {
    if (!phoneViewport) return;
    const route = phoneRouteRef.current;
    if (pending.operation === "create_conversation") {
      if (route?.screen === "conversations") {
        setSelectingRole(false);
        setPhoneScene("conversations");
      }
      return;
    }
    if (route?.screen !== "chat") return;
    if (
      pending.operation === "initialize"
      && pending.initializeConversationKind === "open"
      && pending.targetConversationId === route.conversationId
    ) {
      replaceCurrentPhoneRoute({ screen: "conversations", cwd: route.cwd });
      setPhoneScene("conversations");
      return;
    }
    if (
      pending.operation === "focus_conversation"
      && pending.targetConversationId === route.conversationId
    ) {
      const fallback: PhoneHistoryRoute = pending.sourceFocus
        ? {
            screen: "chat",
            cwd: route.cwd,
            conversationId: pending.sourceFocus.conversationId,
          }
        : { screen: "conversations", cwd: route.cwd };
      replaceCurrentPhoneRoute(fallback);
      setPhoneScene(fallback.screen);
    }
  };
  phoneRouteDowngradeChatRef.current = (conversationId) => {
    if (!phoneViewport) return;
    const route = phoneRouteRef.current;
    if (
      route?.screen !== "chat"
      || workspaceKey(route.cwd) !== currentWorkspaceKey()
      || route.conversationId !== conversationId
    ) return;
    replaceCurrentPhoneRoute({ screen: "conversations", cwd: route.cwd });
    setSelectingRole(false);
    setPhoneScene("conversations");
  };
  const goBackFromPhoneRoute = () => {
    const route = phoneRouteRef.current;
    if (!phoneViewport || !route) return;
    const parent = phoneHistoryRouteParent(route);
    if (!parent) return;
    const owned = phoneHistoryEntriesRef.current;
    if (
      owned.index > 0
      && phoneHistoryRouteEquals(owned.entries[owned.index], route)
      && phoneHistoryRouteEquals(owned.entries[owned.index - 1], parent)
    ) {
      window.history.back();
      return;
    }
    replaceCurrentPhoneRoute(parent);
    phoneRouteHandlerRef.current(parent);
  };
  const closeWorkspace = (cwd: string) => {
    const key = workspaceKey(cwd);
    if (workspaceKey(activeCwdRef.current) !== key) return;

    workspaceProjectionCacheRef.current.delete(key);
    if (cachedWorkspacePresentationKeyRef.current === key) {
      clearTemporaryWorkspacePresentation();
    }
    for (const [cacheKey, presentation] of conversationPresentationCacheRef.current) {
      if (presentation.workspaceKey === key) {
        conversationPresentationCacheRef.current.delete(cacheKey);
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

    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "close_session", sessionId });
    transitionTiming.cancel("destroyed");
    activeCwdRef.current = "";
    sessionIdRef.current = "";
    conversationIdRef.current = "";
    focusRef.current = undefined;
    setActiveCwd("");
    setSetupCwd("");
    setError("");
    updateWorkspaceSyncing(false);
    clearSessionProjection();
    dispatchChat({ type: "reset" });
  };
  const openWorkspaceDialog = () => {
    setSetupCwd(activeCwdRef.current || setupCwd);
    setSetupOpen(true);
    drawerReturnFocusRef.current = null;
    setDrawer(false);
    setRoleManagerOpen(false);
    if (!protocolError) setError("");
  };
  const closeWorkspaceDialog = () => {
    setSetupOpen(false);
    updateDirectoryBrowser(undefined);
  };
  const handleWorkspaceSelect = useLatestCallback((cwd: string) => {
    if (switchWorkspace(cwd) && phoneViewport) {
      setPhoneScene("conversations");
      pushCurrentPhoneRoute({ screen: "conversations", cwd });
    }
  });
  const handleWorkspaceClose = useLatestCallback((cwd: string) => {
    const active = workspaceKey(cwd) === workspaceKey(activeCwdRef.current);
    closeWorkspace(cwd);
    if (active && phoneViewport) {
      replaceCurrentPhoneRoute({ screen: "workspaces" });
      setPhoneScene("workspaces");
    }
  });
  const handleWorkspaceAdd = useLatestCallback(openWorkspaceDialog);
  const handleSidebarCollapsedChange = useLatestCallback(
    (collapsed: boolean) => setSidebarCollapsed(collapsed),
  );
  const handleConversationSelect = useLatestCallback((conversationId: string) => {
    if (focusConversation(conversationId) && phoneViewport) {
      setPhoneScene("chat");
      pushCurrentPhoneRoute({
        screen: "chat",
        cwd: activeCwdRef.current,
        conversationId,
      });
    }
  });
  const handleConversationCreate = useLatestCallback(() => {
    if (
      !workspaceSyncingRef.current
      && !conversationSyncingRef.current
      && !focusedConversationNeedsSnapshot()
    ) {
      setSelectingRole(true);
      if (phoneViewport) setPhoneScene("chat");
    }
  });
  const handleConversationRename = useLatestCallback(renameConversation);
  const handleConversationDelete = useLatestCallback(deleteConversation);
  const handleChatDraftChange = useLatestCallback((text: string) => {
    updateDraft(text);
    updateConversationDraft({ text, images: draftImages });
    if (promptNotice) setPromptNotice("");
  });
  const handleChatImagesChange = useLatestCallback((images: PromptImage[]) => {
    updateDraftImages(images);
    updateConversationDraft({ text: draft, images });
    if (promptNotice) setPromptNotice("");
  });
  const handleChatSend = useLatestCallback((text: string, images: PromptImage[]) =>
    submitPrompt(text, images));
  const handleChatAbort = useLatestCallback(abortCurrentRun);
  const handleChatSettings = useLatestCallback((
    resolveReturnFocus?: () => HTMLElement | null,
  ) => {
    drawerReturnFocusRef.current = resolveReturnFocus ?? null;
    setDrawer(true);
  });
  const handleChatThinking = useLatestCallback(setThinkingLevel);
  const handleChatServiceTier = useLatestCallback(setServiceTier);
  const handleChatCompactionThreshold = useLatestCallback(setCompactionThreshold);
  const handleChatCompact = useLatestCallback(compactContext);
  const handleChatSwitchRole = useLatestCallback(switchConversationRole);
  const handleChatRewind = useLatestCallback(truncateConversation);
  const online = transportOnline && protocolReady;
  const authModalVisible = Boolean(auth.request || auth.progress);
  const extensionPending = online
    && !authModalVisible
    && !settingsDialogOpen
    ? extensionUI[0]
    : undefined;
  // A covered surface remains mounted for its local state and focus-return
  // chain, but only the top surface may remain an accessible modal.
  const externalModalVisible = Boolean(authModalVisible || extensionPending);
  const directoryBrowserCovered = externalModalVisible;
  const workspaceSetupCovered = Boolean(directoryBrowser || externalModalVisible);
  const blockingModalVisible = Boolean(externalModalVisible || setupOpen);
  const workspaceSetupFocusRef = useModalFocus<HTMLElement>(
    setupOpen,
    setupOpen ? "workspace-setup" : "",
    closeWorkspaceDialog,
  );
  const phoneRouteBlocked = Boolean(
    blockingModalVisible
    || directoryBrowser
    || drawer
    || roleManagerOpen
    || settingsDialogOpen
    || chatBlockingModal
    || sidebarBlockingModal
  );
  useEffect(() => {
    if (!phoneViewport || phoneRouteBlocked) return;
    const deferred = deferredPhoneRouteRef.current;
    if (!deferred) return;
    deferredPhoneRouteRef.current = undefined;
    phoneRouteHandlerRef.current(deferred);
  }, [phoneRouteBlocked, phoneViewport]);
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
    navigationEnabled={online}
    mobile={phoneViewport ? {
      hidden: mobileScene !== "workspaces",
      canGoBack: phoneRouteRef.current?.screen !== "workspaces",
      onBack: goBackFromPhoneRoute,
    } : undefined}
    onSelect={handleWorkspaceSelect}
    onClose={handleWorkspaceClose}
    onAdd={handleWorkspaceAdd}
  />;
  const workspaceSetupDialog = setupOpen && <div
    className="modal-backdrop workspace-setup-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      closeWorkspaceDialog();
    }}
  >
    <section
      ref={workspaceSetupFocusRef}
      className="workspace-setup-dialog"
      role={workspaceSetupCovered ? undefined : "dialog"}
      aria-modal={workspaceSetupCovered ? undefined : "true"}
      aria-hidden={workspaceSetupCovered ? "true" : undefined}
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
        onStart={handleWorkspaceSelect}
      />
    </section>
  </div>;
  const directoryBrowserDialog = directoryBrowser && <DirectoryBrowserDialog
    listing={directoryBrowser.listing}
    loading={Boolean(directoryBrowser.commandId)}
    covered={directoryBrowserCovered}
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
  const currentFocus = focusRef.current?.sessionId === sessionIdRef.current
    ? focusRef.current
    : undefined;
  const focusTransitionPending = pendingFocus?.operation === "focus_conversation";
  // A cache is a read-only presentation, never a substitute for the live
  // state whose full identity matches the current focus.
  const runtimeState = state && !focusTransitionPending && (
    currentFocus
      ? stateMatchesFocus(state, currentFocus)
      : state.sessionId === sessionIdRef.current && state.focusId === undefined
  )
    ? state
    : undefined;
  // On a cache miss retain only the prior shell configuration while the
  // target is opening. Its transcript is reset below and it never enables a
  // control or contributes a runtime activity value.
  const sourcePresentation = focusTransitionPending
    && state
    && state.sessionId === sessionIdRef.current
    ? presentationFromState(state)
    : undefined;
  const visiblePresentation = transitionPresentation?.presentation
    ?? (runtimeState ? presentationFromState(runtimeState) : sourcePresentation);
  const visibleProjectId = runtimeState?.projectId
    ?? transitionPresentation?.projectId
    ?? currentFocus?.projectId;
  const visiblePresentationConversationId = runtimeState?.conversationId
    ?? transitionPresentation?.conversationId
    ?? currentFocus?.conversationId;
  const attachedRuntimeUnknown = Boolean(currentFocus && !runtimeState);
  const showRoleSelection = selectingRole || (
    !currentFocus && !visiblePresentationConversationId
  );
  const visiblePendingConversationDeletion = pendingConversationDeletion
    && runtimeState
    && pendingConversationDeletion.sessionId === runtimeState.sessionId
    && pendingConversationDeletion.workspaceKey === workspaceKey(activeCwd)
    && pendingConversationDeletion.projectId === runtimeState.projectId
    ? pendingConversationDeletion
    : undefined;
  const sidebarConversations = useMemo(
    () => projectConversationsDuringDeletion(
      conversations,
      visiblePendingConversationDeletion?.conversationId,
      visiblePendingConversationDeletion?.affectedFocus?.conversationId,
    ),
    [
      conversations,
      visiblePendingConversationDeletion?.conversationId,
      visiblePendingConversationDeletion?.affectedFocus?.conversationId,
    ],
  );
  const showConversationDeletionProgress =
    visiblePendingConversationDeletion?.affectedFocus !== undefined;
  const switchingFocus = pendingFocus?.operation === "focus_conversation"
    || pendingFocus?.operation === "create_conversation";
  const visibleConversationReady =
    !switchingFocus && !transitioning && conversationReady;
  const roleSwitchFocusKey = visibleConversationReady && runtimeState && currentFocus
    ? activeFocusKey(currentFocus)
    : undefined;
  const pendingTargetConversationId = pendingFocus?.operation === "focus_conversation"
    ? pendingFocus.targetConversationId
    : undefined;
  const visibleConversationId = pendingTargetConversationId
    ?? (showRoleSelection ? undefined : visiblePresentationConversationId);
  const visibleBusyConversationId = runtimeState
    && (runtimeState.busy || outstandingRunId)
    ? runtimeState.conversationId
    : undefined;
  const titleLookupSource = visibleConversationReady
    && visibleProjectId
    && visibleConversationId
    && sidebarConversations.some(({ id }) => id === visibleConversationId)
    ? {
        projectId: visibleProjectId,
        conversations: sidebarConversations,
      }
    : undefined;
  const titleLookupKey = useMemo(
    () => titleLookupSource
      ? conversationTitleLookupKey(
          titleLookupSource.projectId,
          titleLookupSource.conversations,
          conversationIndexTruncated,
        )
      : "",
    [
      conversationIndexTruncated,
      sidebarConversations,
      visibleConversationId,
      visibleConversationReady,
      visibleProjectId,
    ],
  );
  const visibleConversationTitleLookup = useMemo(
    () => titleLookupSource
      ? createConversationTitleLookup(
          titleLookupSource.conversations,
          conversationIndexTruncated,
        )
      : undefined,
    [titleLookupKey],
  );
  const nextVisibleConversationContext = useMemo<
    {
      rootTitle: string;
      currentTitle?: string;
      ordinal?: number;
      agentCount?: number;
    } | undefined
  >(() => {
    if (!visibleConversationReady || !visibleConversationId) return undefined;
    const conversationsById = new Map(
      sidebarConversations.map((conversation) => [conversation.id, conversation]),
    );
    const currentConversation = conversationsById.get(visibleConversationId);
    if (!currentConversation) return undefined;
    const rootConversationId = currentConversation.rootConversationId;
    const rootConversation = !rootConversationId
      || rootConversationId === currentConversation.id
      ? currentConversation
      : conversationsById.get(rootConversationId);
    if (!rootConversation) return undefined;

    const rootTitle = conversationDisplayTitle(rootConversation);
    const currentTitle = conversationDisplayTitle(currentConversation);
    const agentCount = 1 + sidebarConversations.filter((conversation) => (
      conversation.id !== rootConversation.id
      && conversation.rootConversationId === rootConversation.id
    )).length;
    const ordinal = conversationDisplayOrdinal(
      sidebarConversations,
      currentConversation.id,
    );
    return {
      rootTitle,
      ...(currentConversation.id === rootConversation.id ? {} : { currentTitle }),
      ...(ordinal === undefined ? {} : { ordinal }),
      ...(conversationIndexTruncated ? {} : { agentCount }),
    };
  }, [
    conversationIndexTruncated,
    sidebarConversations,
    visibleConversationId,
    visibleConversationReady,
  ]);
  const visibleConversationContextKey = JSON.stringify(
    nextVisibleConversationContext ?? null,
  );
  const visibleConversationContext = useMemo(
    () => nextVisibleConversationContext,
    [visibleConversationContextKey],
  );
  const mobileConversationTitle = useMemo(() => {
    const mobileConversation = sidebarConversations.find(
      ({ id }) => id === visibleConversationId,
    );
    return mobileConversation
      ? conversationDisplayTitle(mobileConversation)
      : "当前会话";
  }, [sidebarConversations, visibleConversationId]);
  const openingConversationTitle = pendingTargetConversationId
    ? sidebarConversations.find(({ id }) => id === pendingTargetConversationId)
    : undefined;
  const showConversationOpening = pendingFocus?.operation === "focus_conversation"
    && !activeConversationPresentation;
  const phoneSceneFocusKey = !activeCwd || (!visiblePresentation && !currentFocus)
    ? mobileScene
    : mobileScene === "chat" && showRoleSelection
      ? "role-selection"
      : mobileScene;
  usePhoneSceneFocus(phoneViewport, phoneSceneFocusKey, phoneWorkbenchRef);

  if (
    !activeCwd
    || (!visiblePresentation && (!currentFocus || !conversationSyncing))
  ) return <>
    <div className="workbench" ref={phoneWorkbenchRef}>
      {workspaceRail}
      <ConversationSidebar
        conversations={[]}
        truncated={false}
        collapsed={sidebarCollapsed}
        navigationEnabled={false}
        actionsEnabled={false}
        mobile={phoneViewport ? {
          hidden: mobileScene !== "conversations" || Boolean(activeCwd),
          onShowWorkspaces: goBackFromPhoneRoute,
        } : undefined}
        onToggleCollapsed={handleSidebarCollapsedChange}
        onSelect={handleConversationSelect}
        onCreate={handleConversationCreate}
        onRename={handleConversationRename}
        onDelete={handleConversationDelete}
        onBlockingModalChange={phoneViewport ? setSidebarBlockingModal : undefined}
      />
      <WorkspacePlaceholder
        cwd={activeCwd}
        unavailable={unavailableWorkspaceKeys.has(workspaceKey(activeCwd))}
        hidden={phoneViewport ? mobileScene !== "conversations" : false}
        announceOpening={phoneViewport && mobileScene === "conversations"}
        onOpen={openWorkspaceDialog}
        onClose={() => closeWorkspace(activeCwd)}
        onRetry={() => switchWorkspace(activeCwd)}
      />
    </div>
    {workspaceSetupDialog}
    {directoryBrowserDialog}
    {extensionDialog}
    {feedback}
  </>;

  const visibleServiceTiers = visiblePresentation?.providers
    .flatMap((provider) => provider.models)
    .find((model) => (
      model.provider === visiblePresentation.selectedModel?.provider
      && model.id === visiblePresentation.selectedModel.id
    ))?.serviceTiers ?? EMPTY_SERVICE_TIERS;
  const focusedConversationId = currentFocus && runtimeState
    ? currentFocus.conversationId
    : undefined;
  const sidebarScopeKey = `${workspaceKey(activeCwd)}:${
    visibleProjectId ?? ""
  }`;
  const conversationCompacting = runtimeState !== undefined && (
    runtimeState.compacting === true || Boolean(pendingContextCompaction)
  );
  const showAttachedConversationProjection =
    conversationSyncing && pendingFocus === undefined;
  let visibleChat = chat;
  if (transitioning) {
    visibleChat = transitionPresentation?.chat
      ?? (showAttachedConversationProjection ? chat : initialChatState);
  } else if (switchingFocus) {
    visibleChat = initialChatState;
  }
  const visibleBusy = transitioning || switchingFocus || !runtimeState
    ? false
    : runtimeState.busy || Boolean(outstandingRunId);
  const visibleActiveRun = transitioning || switchingFocus || !runtimeState
    ? undefined
    : runtimeState.activeRun;
  const focusAwaitingSnapshot = Boolean(currentFocus) && !conversationReady;
  const settingsEnabled = Boolean(runtimeState)
    && !transitioning
    && !focusAwaitingSnapshot
    && !attachedRuntimeUnknown;
  const visibleCompacting = transitioning ? false : conversationCompacting;
  const visibleCompactionAttempt = runtimeState?.compacting === true
    ? runtimeState.compactionAttempt
    : undefined;
  const visibleConversationRole = transitioning
    ? transitionPresentation?.conversationRole
      ?? (showAttachedConversationProjection ? conversationRole : undefined)
    : conversationRole;
  return <>
    <div className="workbench" ref={phoneWorkbenchRef}>
      {workspaceRail}
      <ConversationSidebar
        conversations={sidebarConversations}
        truncated={conversationIndexTruncated}
        currentConversationId={visibleConversationId}
        focusedConversationId={focusedConversationId}
        scopeKey={sidebarScopeKey}
        busyConversationId={visibleBusyConversationId}
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
        deletionBlocked={Boolean(visiblePendingConversationDeletion)}
        mobile={phoneViewport ? {
          hidden: mobileScene !== "conversations",
          onShowWorkspaces: goBackFromPhoneRoute,
          ...(visibleConversationId ? {
            onShowCurrentConversation: () => {
              setPhoneScene("chat");
              pushCurrentPhoneRoute({
                screen: "chat",
                cwd: activeCwdRef.current,
                conversationId: visibleConversationId,
              });
            },
          } : {}),
        } : undefined}
        onToggleCollapsed={handleSidebarCollapsedChange}
        onSelect={handleConversationSelect}
        onCreate={handleConversationCreate}
        onRename={handleConversationRename}
        onDelete={handleConversationDelete}
        onBlockingModalChange={phoneViewport ? setSidebarBlockingModal : undefined}
      />
      <div
        className="workbench-main"
        hidden={phoneViewport && mobileScene !== "chat"}
      >
        {workspaceSyncing && <div
          className="banner transition-status-overlay"
          role="status"
          aria-label="正在同步工作区…"
        >
          正在同步工作区…
        </div>}
        {conversationSyncing && <div
          className="banner transition-status-overlay"
          role="status"
          aria-label={showConversationOpening
            ? openingConversationTitle
              ? `正在同步会话…；正在打开会话 ${conversationDisplayTitle(openingConversationTitle)}`
              : "正在同步会话…；正在打开会话"
            : "正在同步会话…"}
        >
          正在同步会话…
          {showConversationOpening && (openingConversationTitle
            ? ` · 正在打开会话 ${conversationDisplayTitle(openingConversationTitle)}`
            : " · 正在打开会话")}
        </div>}
        {visiblePendingConversationDeletion
          && !showConversationDeletionProgress
          && <div
            className="banner transition-status-overlay"
            role="status"
            aria-label="正在删除对话…"
          >
            正在删除对话…
          </div>}
        {showConversationDeletionProgress
          ? <main
              className="workspace-placeholder conversation-deletion-placeholder"
            >
              <div
                className="workspace-placeholder-content"
                role="status"
                aria-label="正在删除对话…"
              >
                <ActivitySpinner
                  className="conversation-deletion-spinner"
                  strokeWidth={1.2}
                />
                <p className="eyebrow">DELETING CONVERSATION</p>
                <h1>正在删除对话</h1>
                <p>正在完成安全删除；若操作失败，会恢复仍可用的会话。</p>
              </div>
            </main>
          : !visiblePresentation
          ? <main className="app-shell workspace-placeholder">
              {phoneViewport && <header className="topbar">
                <div className="mobile-chat-header">
                  <button
                    type="button"
                    aria-label="返回会话列表"
                    onClick={goBackFromPhoneRoute}
                  >返回</button>
                  <div>
                    <span>PI WEB</span>
                    <strong>正在同步会话</strong>
                  </div>
                </div>
              </header>}
              <div className="workspace-placeholder-content">
                <ActivitySpinner
                  className="conversation-deletion-spinner"
                  strokeWidth={1.2}
                />
                <p className="eyebrow">SYNCHRONIZING CONVERSATION</p>
                <h1>正在同步会话</h1>
                <p>正在等待此会话的运行状态。</p>
              </div>
            </main>
          : showRoleSelection
          ? <RoleSelectionPage
              roles={roles}
              pending={
                pendingFocus?.operation === "create_conversation"
                || transitioning
              }
              mobile={phoneViewport ? {
                onBack: () => {
                  setSelectingRole(false);
                  setPhoneScene("conversations");
                },
              } : undefined}
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
                drawerReturnFocusRef.current = null;
                setDrawer(true);
              }}
            />
          : <Chat
              chat={visibleChat}
              observationSessionId={
                runtimeState?.sessionId
                ?? currentFocus?.sessionId
                ?? sessionIdRef.current
              }
              busy={visibleBusy}
              activeRun={visibleActiveRun}
              loopList={loopList}
              sessionTokenUsage={visiblePresentation.sessionTokenUsage}
              contextTokenCount={visiblePresentation.contextUsage?.tokens}
              contextWindow={visiblePresentation.contextUsage?.contextWindow}
              contextPercent={visiblePresentation.contextUsage?.percent}
              contextSource={visiblePresentation.contextUsage?.source}
              model={visiblePresentation.selectedModel}
              role={visibleConversationRole}
              roles={roles}
              roleSwitchFocusKey={roleSwitchFocusKey}
              roleDialogCovered={externalModalVisible}
              roleSwitchDisabled={
                !runtimeState
                || transitioning
                || runtimeState.busy
                || Boolean(outstandingRunId)
                || Boolean(pendingPrompt)
                || pendingAdmissions.length > 0
                || Boolean(pendingConversationTruncation)
                || Boolean(pendingConversationDeletion)
                || conversationCompacting
              }
              roleSwitching={Boolean(pendingConversationRoleSwitch)}
              thinkingLevel={visiblePresentation.thinkingLevel}
              availableThinkingLevels={visiblePresentation.availableThinkingLevels}
              serviceTiers={visibleServiceTiers}
              selectedServiceTier={visiblePresentation.selectedServiceTier ?? null}
              serviceTierBusy={Boolean(pendingServiceTier)}
              compactionThresholdPercent={
                visiblePresentation.compactionThresholdPercent
                ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT
              }
              compactionThresholdBusy={Boolean(pendingCompactionThreshold)}
              compacting={visibleCompacting}
              compactionAttempt={visibleCompactionAttempt}
              cwd={visiblePresentation.cwd}
              conversationContext={visibleConversationContext}
              conversationTitleLookup={visibleConversationTitleLookup}
              mobile={phoneViewport ? {
                active: mobileScene === "chat",
                title: mobileConversationTitle,
                onBack: goBackFromPhoneRoute,
              } : undefined}
              onBlockingModalChange={phoneViewport ? setChatBlockingModal : undefined}
              online={online}
              interactive={settingsEnabled}
              conversationReady={visibleConversationReady}
              draft={draft}
              draftImages={draftImages}
              submitting={Boolean(pendingPrompt)}
              pendingAdmissions={pendingAdmissions}
              promptNotice={promptNotice || undefined}
              onDraftChange={handleChatDraftChange}
              onImagesChange={handleChatImagesChange}
              onSend={handleChatSend}
              onAbort={handleChatAbort}
              onSettings={handleChatSettings}
              onThinking={handleChatThinking}
              onServiceTier={handleChatServiceTier}
              onCompactionThreshold={handleChatCompactionThreshold}
              onCompact={handleChatCompact}
              onSwitchRole={handleChatSwitchRole}
              onChangeCwd={handleWorkspaceAdd}
              onOpenConversation={handleConversationSelect}
              onOpenImage={openImage}
              onRewind={handleChatRewind}
              rewindingMessageId={pendingConversationTruncation?.messageId}
            />}
      </div>
    </div>
    <SettingsDrawer
      state={runtimeState}
      open={drawer}
      covered={blockingModalVisible}
      resolveReturnFocus={drawerReturnFocusRef.current ?? undefined}
      online={online && settingsEnabled}
      preferencesOnline={online}
      colorScheme={visibleColorScheme}
      colorSchemePending={Boolean(pendingColorScheme)}
      colorSchemeUnsaved={Boolean(unsavedColorScheme)}
      colorSchemeError={colorSchemeSaveError}
      settingResults={settingResults}
      onClose={() => {
        setDrawer(false);
        drawerReturnFocusRef.current = null;
      }}
      onColorSchemeChange={(colorScheme) => saveColorScheme(colorScheme)}
      onRetryColorScheme={() => {
        const colorScheme = unsavedColorSchemeRef.current;
        if (colorScheme) saveColorScheme(colorScheme, true);
      }}
      onKey={(provider, key) => {
        const commandId = crypto.randomUUID();
        const sessionId = sessionIdRef.current;
        if (!sessionId || focusedConversationNeedsSnapshot()) return undefined;
        setSettingResults((current) => ({ ...current, set_api_key: undefined }));
        pendingSettingCommandsRef.current.set_api_key = { sessionId, commandId };
        if (send({ type: "set_api_key", commandId, sessionId, provider, key })) {
          return commandId;
        }
        delete pendingSettingCommandsRef.current.set_api_key;
        return undefined;
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
         setSettingResults((current) => ({ ...current, refresh_models: undefined }));
         pendingSettingCommandsRef.current.refresh_models = { sessionId, commandId };
         if (send({ type: "refresh_models", commandId, sessionId })) return commandId;
         delete pendingSettingCommandsRef.current.refresh_models;
         return undefined;
       }}
      onConsumeSettingResult={consumeSettingResult}
      onKeyDialogChange={setSettingsDialogOpen}
    />
    <RoleManagerDialog
      open={roleManagerOpen && !blockingModalVisible && !transitioning}
      roles={roles}
      providers={runtimeState?.providers ?? []}
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
    {workspaceSetupDialog}
    {directoryBrowserDialog}
    <AuthDialog {...auth} visible={authModalVisible} onRespond={(requestId, response) => {
      const authFlowId = authFlowIdRef.current;
      if (authFlowId) send({ type: "auth_response", authFlowId, requestId, ...response });
    }} onCancel={() => {
      const authFlowId = authFlowIdRef.current;
      if (authFlowId) send({ type: "cancel_auth", authFlowId });
      authFlowIdRef.current = "";
      setAuth({});
    }} />
    {extensionDialog}
    {feedback}
  </>;
}
