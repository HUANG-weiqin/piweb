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
  type CustomProviderSaveInput,
  type DirectoryListing,
  type LoopList,
  type PublicState,
  type ProjectActivitySummary,
  type PromptImage,
  type RoleTemplate,
  type ServerEvent,
  type ServiceTier,
  type ThinkingLevel,
  type WorkspaceSessionRepairBackup,
  type WorkspaceSessionRepairReport,
  type WorkspaceSessionRepairRequest,
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
  type CustomProviderMutationResult,
  type CustomProviderProbeResult,
  type CustomProvidersView,
  type SettingOperationResult,
  type SettingOperationResults,
} from "./components/SettingsDrawer";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { DirectoryBrowserDialog } from "./components/DirectoryBrowserDialog";
import {
  WorkspaceSessionRepairDialog,
  type WorkspaceSessionRepairPending,
} from "./components/WorkspaceSessionRepairDialog";
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
import { conversationDisplayOrdinal } from "./lib/conversation-grouping";
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
const RESUME_RECONNECT_AFTER_HIDDEN_MS = 30_000;
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
  draftEdited?: boolean;
}

interface PendingPromptWithdrawal extends ActiveFocus {
  runId: string;
  promptId: string;
  commandId: string;
}

interface PendingImageOpen extends ActiveFocus {
  commandId: string;
  source: ConversationImageLocator | { path: string };
  target: Window;
}

interface ConversationComposerDraft {
  text: string;
  images: PromptImage[];
  submittedStatus?: "unknown";
  unknownPromptId?: string;
  retryableUnknownPrompt?: boolean;
}

interface ConversationDraftScope {
  workspaceKey: string;
  projectId: string;
  conversationId: string;
}

interface PendingAbort extends ActiveFocus {
  runId: string;
}

interface SessionControlReady {
  sessionId: string;
  projectId: string;
}

/** busy 时已接受、尚未投递的浏览器 prompt（服务端内存态）。 */
interface PendingAdmission {
  promptId: string;
  text: string;
  runId?: string;
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

interface ConversationRenamePresentation {
  commandId: string;
  sessionId: string;
  workspaceKey: string;
  projectId: string;
  conversationId: string;
  name: string;
  status: "syncing" | "unknown" | "committed";
  recoverySessionId?: string;
  recoveryFocusId?: string;
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

interface WorkspaceSessionRepairDialogState {
  dialogId: string;
  cwd: string;
  report?: WorkspaceSessionRepairReport;
  reportFresh: boolean;
  backups: WorkspaceSessionRepairBackup[];
  pending?: WorkspaceSessionRepairPending;
  phase?: "report" | "entering" | "ready";
  error?: string;
  repairError?: string;
  needsRecheck?: boolean;
  enterSessionId?: string;
  enterCommandId?: string;
  enterFocus?: ActiveFocus;
  enterEmptyProjectId?: string;
  enterStateSeen?: boolean;
  enterSnapshotSeen?: boolean;
  dismissed?: boolean;
}

interface WorkspaceSessionRepairArchive {
  backups: WorkspaceSessionRepairBackup[];
  needsRecheck: boolean;
  error?: string;
  repairError?: string;
}

interface PendingWorkspaceSessionCommand {
  socket: PiSocket;
  connectionEpoch: number;
  dialogId: string;
  cwd: string;
  commandId: string;
  operation: WorkspaceSessionRepairPending;
  purpose: "inspect" | "repair" | "retry-recovery" | "enter";
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
  "发送状态未确认；恢复会话后将自动核对提交。";
const EDITED_UNCONFIRMED_PROMPT_NOTICE =
  "发送状态未确认；草稿已修改，未自动重试。";

interface PendingFocus {
  commandId: string;
  operation: "initialize" | "focus_conversation" | "create_conversation" | "fork_conversation";
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

interface PendingCustomProvidersRefresh {
  commandId: string;
  /** 命令标识只在接收它的连接上有意义；失效连接不能阻住新连接的重读。 */
  socket: PiSocket;
}

interface PendingCustomProviderMutation {
  commandId: string;
  operation: "save_custom_provider" | "delete_custom_provider";
}

interface PendingCustomProviderProbe {
  commandId: string;
  baseUrl: string;
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
  const backgroundedAtRef = useRef<number | undefined>(undefined);
  const hasCompletedInitialHandshakeRef = useRef(false);
  const [transportOnline, setTransportOnline] = useState(false);
  const transportOnlineRef = useRef(false);
  const [protocolReady, setProtocolReady] = useState(false);
  const protocolReadyRef = useRef(false);
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
  const draftRef = useRef("");
  const updateDraft = (text: string) => {
    draftRef.current = text;
    setDraft(text);
  };
  const [draftImages, setDraftImages] = useState<PromptImage[]>([]);
  const draftImagesRef = useRef<PromptImage[]>([]);
  const updateDraftImages = (images: PromptImage[]) => {
    draftImagesRef.current = images;
    setDraftImages(images);
  };
  const [draftScope, setDraftScopeState] = useState<ConversationDraftScope | undefined>(undefined);
  const draftScopeRef = useRef<ConversationDraftScope | undefined>(undefined);
  const updateDraftScope = (scope: ConversationDraftScope | undefined) => {
    draftScopeRef.current = scope;
    setDraftScopeState(scope);
  };
  const conversationDraftByScopeRef = useRef(
    new Map<string, ConversationComposerDraft>(),
  );
  const clearDraftProjection = () => {
    updateDraftScope(undefined);
    updateDraft("");
    updateDraftImages([]);
  };
  const [pendingPrompt, setPendingPrompt] = useState<DirectPendingPrompt>();
  const pendingPromptRef = useRef<DirectPendingPrompt | undefined>(undefined);
  // A withdrawal can overtake its admission receipt on the control path.
  const settledPromptIdsRef = useRef(new Set<string>());
  const recordSettledPrompt = (promptId: string) => {
    const ids = settledPromptIdsRef.current;
    ids.add(promptId);
    if (ids.size > 256) ids.delete(ids.values().next().value!);
  };
  const [pendingPromptWithdrawal, setPendingPromptWithdrawal] = useState<PendingPromptWithdrawal>();
  const pendingPromptWithdrawalRef = useRef<PendingPromptWithdrawal | undefined>(undefined);
  const updatePendingPromptWithdrawal = (pending: PendingPromptWithdrawal | undefined) => {
    pendingPromptWithdrawalRef.current = pending;
    setPendingPromptWithdrawal(pending);
  };
  const [pendingAbort, setPendingAbortState] = useState<PendingAbort>();
  const pendingAbortRef = useRef<PendingAbort | undefined>(undefined);
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
  /**
   * Conversations the in-flight deletion owns. Only these may block other
   * client operations; unrelated conversations stay operable.
   */
  const pendingConversationDeletionScopeRef = useRef<ReadonlySet<string>>(
    new Set<string>(),
  );
  const [conversationRenamePresentations, setConversationRenamePresentations] =
    useState(new Map<string, ConversationRenamePresentation>());
  const conversationRenamePresentationsRef = useRef(
    new Map<string, ConversationRenamePresentation>(),
  );
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
  const [workspaceSessionRepair, setWorkspaceSessionRepairState] =
    useState<WorkspaceSessionRepairDialogState>();
  const workspaceSessionRepairRef = useRef<
    WorkspaceSessionRepairDialogState | undefined
  >(undefined);
  const workspaceSessionRepairArchiveRef = useRef(
    new Map<string, WorkspaceSessionRepairArchive>(),
  );
  const pendingWorkspaceSessionCommandRef = useRef<
    PendingWorkspaceSessionCommand | undefined
  >(undefined);
  const [workspaceInitializationFailure, setWorkspaceInitializationFailure] =
    useState<{ cwd: string; message: string }>();
  const [promptNotice, setPromptNotice] = useState("");
  const [outstandingRunId, setOutstandingRunId] = useState("");
  const outstandingRunIdRef = useRef("");
  const [state, setState] = useState<PublicState>();
  const boundActiveRunIdRef = useRef<string | undefined>(undefined);
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
  const [sessionControlReady, setSessionControlReadyState] =
    useState<SessionControlReady | undefined>(undefined);
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
  const [customProviders, setCustomProviders] = useState<CustomProvidersView>();
  const pendingCustomProvidersRefreshRef = useRef<
    PendingCustomProvidersRefresh | undefined
  >(undefined);
  const [customProvidersRefreshing, setCustomProvidersRefreshing] = useState(false);
  const [customProvidersRefreshError, setCustomProvidersRefreshError] = useState("");
  const pendingCustomProviderMutationRef = useRef<
    PendingCustomProviderMutation | undefined
  >(undefined);
  const [customProviderMutationPending, setCustomProviderMutationPending] = useState(false);
  const [customProviderMutationResult, setCustomProviderMutationResult] =
    useState<CustomProviderMutationResult>();
  const pendingCustomProviderProbeRef = useRef<
    PendingCustomProviderProbe | undefined
  >(undefined);
  const [customProviderProbePending, setCustomProviderProbePending] = useState(false);
  const [customProviderProbeResult, setCustomProviderProbeResult] =
    useState<CustomProviderProbeResult>();
  const updatePendingCustomProviderMutation = (
    pending: PendingCustomProviderMutation | undefined,
  ) => {
    pendingCustomProviderMutationRef.current = pending;
    setCustomProviderMutationPending(Boolean(pending));
  };
  const updatePendingCustomProviderProbe = (
    pending: PendingCustomProviderProbe | undefined,
  ) => {
    pendingCustomProviderProbeRef.current = pending;
    setCustomProviderProbePending(Boolean(pending));
  };
  const beginCustomProvidersRefresh = (socket: PiSocket) => {
    if (pendingCustomProvidersRefreshRef.current?.socket === socket) return;
    const commandId = crypto.randomUUID();
    pendingCustomProvidersRefreshRef.current = { commandId, socket };
    setCustomProvidersRefreshing(true);
    setCustomProvidersRefreshError("");
    if (!socket.send({ type: "refresh_custom_providers", commandId })) {
      pendingCustomProvidersRefreshRef.current = undefined;
      setCustomProvidersRefreshing(false);
      setCustomProvidersRefreshError("本地服务未连接；无法读取本机模型配置。");
    }
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
  const updatePendingAbort = (pending: PendingAbort | undefined) => {
    pendingAbortRef.current = pending;
    setPendingAbortState(pending);
  };
  const updateSessionControlReady = (ready: SessionControlReady | undefined) => {
    setSessionControlReadyState(ready);
  };
  const currentWorkspaceKey = () => workspaceKey(activeCwdRef.current);
  const focusedConversationNeedsSnapshot = () =>
    Boolean(focusRef.current) && !conversationReadyRef.current;
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
    boundActiveRunIdRef.current = undefined;
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
  const showConversationDraft = (scope: ConversationDraftScope) => {
    updateDraftScope(scope);
    const key = pendingConversationKey(scope);
    const savedDraft = conversationDraftByScopeRef.current.get(key);
    updateDraft(savedDraft?.text ?? "");
    updateDraftImages(savedDraft?.images ?? []);
    setPromptNotice(savedDraft?.submittedStatus === "unknown"
      ? savedDraft.retryableUnknownPrompt
        ? UNCONFIRMED_PROMPT_NOTICE
        : EDITED_UNCONFIRMED_PROMPT_NOTICE
      : "");
  };
  const updateConversationDraft = (next: Pick<
    ConversationComposerDraft,
    "text" | "images"
  >) => {
    const scope = draftScopeRef.current;
    if (!scope) return;
    const key = pendingConversationKey(scope);
    const savedDraft = conversationDraftByScopeRef.current.get(key);
    const pending = pendingPromptRef.current;
    if (pending && pendingConversationKey(pending) === key) pending.draftEdited = true;
    if (!next.text && next.images.length === 0 && !savedDraft?.submittedStatus) {
      conversationDraftByScopeRef.current.delete(key);
    } else {
      conversationDraftByScopeRef.current.set(key, {
        ...next,
        ...(savedDraft?.submittedStatus
          ? { submittedStatus: savedDraft.submittedStatus }
          : {}),
        ...(savedDraft?.unknownPromptId
          ? { unknownPromptId: savedDraft.unknownPromptId }
          : {}),
      });
    }
  };
  const settleAcceptedPromptDraft = (pending: DirectPendingPrompt) => {
    const scope = draftScopeRef.current;
    if (!scope || pendingConversationKey(scope) !== pendingConversationKey(pending)) {
      return;
    }
    const currentImages = draftImagesRef.current;
    const stillShowingSubmittedPayload = draftRef.current.trim() === pending.text
      && currentImages.length === pending.images.length
      && currentImages.every((image, index) => (
        image.mimeType === pending.images[index]?.mimeType
        && image.data === pending.images[index]?.data
      ));
    if (!stillShowingSubmittedPayload || pending.draftEdited) return;
    conversationDraftByScopeRef.current.delete(pendingConversationKey(scope));
    updateDraft("");
    updateDraftImages([]);
  };
  const alignVisibleDraftScopeWorkspace = (cwd: string, focus: ActiveFocus) => {
    const scope = draftScopeRef.current;
    if (
      !scope
      || scope.projectId !== focus.projectId
      || scope.conversationId !== focus.conversationId
    ) return;
    const nextWorkspaceKey = workspaceKey(cwd);
    if (scope.workspaceKey === nextWorkspaceKey) return;
    const previousKey = pendingConversationKey(scope);
    const nextScope = { ...scope, workspaceKey: nextWorkspaceKey };
    const draft = conversationDraftByScopeRef.current.get(previousKey);
    if (draft) {
      conversationDraftByScopeRef.current.delete(previousKey);
      conversationDraftByScopeRef.current.set(pendingConversationKey(nextScope), draft);
    }
    updateDraftScope(nextScope);
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
  const updateConversationRenamePresentation = (
    key: string,
    presentation: ConversationRenamePresentation | undefined,
  ) => {
    const next = new Map(conversationRenamePresentationsRef.current);
    if (presentation) next.set(key, presentation);
    else next.delete(key);
    conversationRenamePresentationsRef.current = next;
    setConversationRenamePresentations(next);
  };
  const markSyncingRenamesUnknown = () => {
    const next = new Map(conversationRenamePresentationsRef.current);
    let changed = false;
    for (const [key, presentation] of next) {
      if (presentation.status !== "syncing") continue;
      next.set(key, {
        ...presentation,
        status: "unknown",
        recoverySessionId: undefined,
        recoveryFocusId: undefined,
      });
      changed = true;
    }
    if (!changed) return;
    conversationRenamePresentationsRef.current = next;
    setConversationRenamePresentations(next);
  };
  const clearRenamesConfirmedByProjectSnapshot = (
    projectId: string,
    conversations: readonly ConversationSummary[],
  ) => {
    const namesByConversationId = new Map(
      conversations.map((conversation) => [conversation.id, conversation.name]),
    );
    const workspaceKeyValue = currentWorkspaceKey();
    const next = new Map(conversationRenamePresentationsRef.current);
    let changed = false;
    for (const [key, presentation] of next) {
      if (
        presentation.workspaceKey !== workspaceKeyValue
        || presentation.projectId !== projectId
        || presentation.status === "unknown"
        || namesByConversationId.get(presentation.conversationId) !== presentation.name
      ) continue;
      next.delete(key);
      changed = true;
    }
    if (!changed) return;
    conversationRenamePresentationsRef.current = next;
    setConversationRenamePresentations(next);
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
  const updateWorkspaceSessionRepair = (
    next: WorkspaceSessionRepairDialogState | undefined,
  ) => {
    workspaceSessionRepairRef.current = next;
    if (next) {
      const key = workspaceKey(next.cwd);
      if (next.backups.length > 0 || next.needsRecheck) {
        workspaceSessionRepairArchiveRef.current.set(key, {
          backups: next.backups,
          needsRecheck: Boolean(next.needsRecheck),
          error: next.error,
          repairError: next.repairError,
        });
      } else {
        workspaceSessionRepairArchiveRef.current.delete(key);
      }
    }
    setWorkspaceSessionRepairState(next);
  };
  const invalidateWorkspaceSessionRepair = (reason: string) => {
    const pending = pendingWorkspaceSessionCommandRef.current;
    if (pending) pendingWorkspaceSessionCommandRef.current = undefined;
    const dialog = workspaceSessionRepairRef.current;
    if (!dialog) return;
    const ownsPending = pending?.dialogId === dialog.dialogId;
    const entering = dialog.phase === "entering" && Boolean(dialog.enterSessionId);
    if (!ownsPending && !entering && !dialog.reportFresh) return;
    updateWorkspaceSessionRepair({
      ...dialog,
      pending: undefined,
      phase: "report",
      enterSessionId: undefined,
      enterCommandId: undefined,
      enterFocus: undefined,
      enterEmptyProjectId: undefined,
      enterStateSeen: false,
      enterSnapshotSeen: false,
      reportFresh: false,
      error: reason,
      needsRecheck: Boolean(entering || (ownsPending && pending.operation === "repair"))
        || Boolean(dialog.needsRecheck),
    });
  };
  const closeWorkspaceSessionRepair = () => {
    const dialog = workspaceSessionRepairRef.current;
    if (!dialog) return;
    const pending = pendingWorkspaceSessionCommandRef.current;
    if (pending?.dialogId === dialog.dialogId && pending.operation === "repair") return;
    if (pending?.dialogId === dialog.dialogId) {
      pendingWorkspaceSessionCommandRef.current = undefined;
    }
    if (dialog.needsRecheck || dialog.backups.length > 0) {
      updateWorkspaceSessionRepair({ ...dialog, dismissed: true });
    } else {
      updateWorkspaceSessionRepair(undefined);
    }
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
  const settleUnconfirmedDraftReceipt = (promptId: string, delivered: boolean) => {
    const scope = draftScopeRef.current;
    const focus = focusRef.current;
    if (!scope || !focus || scope.projectId !== focus.projectId
      || scope.conversationId !== focus.conversationId) return;
    const key = pendingConversationKey(scope);
    const draft = conversationDraftByScopeRef.current.get(key);
    if (draft?.unknownPromptId !== promptId) return;
    if (delivered && draft.retryableUnknownPrompt) {
      conversationDraftByScopeRef.current.delete(key);
      updateDraft("");
      updateDraftImages([]);
    } else {
      // A withdrawn prompt or a later user edit keeps the current draft, not its uncertainty.
      conversationDraftByScopeRef.current.set(key, {
        text: draft.text,
        images: draft.images,
      });
    }
    setPromptNotice("");
  };
  const settleSubmittedPromptReceipt = (event: {
    sessionId: string; conversationId: string; focusId: string; promptId: string;
  }, delivered: boolean) => {
    if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
    const pending = pendingPromptRef.current;
    const acceptedPending = pending && pending.promptId === event.promptId
      && pending.sessionId === event.sessionId
      && pending.conversationId === event.conversationId
      && pending.focusId === event.focusId ? pending : undefined;
    if (acceptedPending) {
      if (delivered) settleAcceptedPromptDraft(acceptedPending);
      updatePendingPrompt(undefined);
      if (outstandingRunIdRef.current === acceptedPending.runId) updateOutstandingRunId("");
    }
    settleUnconfirmedDraftReceipt(event.promptId, delivered);
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
    boundActiveRunIdRef.current = undefined;
    updatePendingPromptWithdrawal(undefined);
    settledPromptIdsRef.current.clear();
    const pendingAbort = pendingAbortRef.current;
    if (
      pendingAbort
      && (
        !conversationId
        || !focusId
        || !sameFocus(pendingAbort, {
          sessionId,
          projectId,
          conversationId,
          focusId,
        })
      )
    ) updatePendingAbort(undefined);
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
    setPromptNotice("");
    settleAcceptedPromptDraft(pending);
    settleUnconfirmedDraftReceipt(pending.promptId, true);
    updatePendingPrompt(undefined);
    updateOutstandingRunId(runId);
  };
  const markPendingPromptUnconfirmed = (message?: string) => {
    const pending = pendingPromptRef.current;
    if (!pending) return;
    updatePendingPrompt(undefined);
    if (outstandingRunIdRef.current === pending.runId) updateOutstandingRunId("");
    const key = pendingConversationKey(pending);
    const draft = conversationDraftByScopeRef.current.get(key);
    const canReconcile = Boolean(draft && !pending.draftEdited
      && draft.text.trim() === pending.text
      && draft.images.length === pending.images.length
      && draft.images.every((image, index) => (
        image.mimeType === pending.images[index]?.mimeType
        && image.data === pending.images[index]?.data
      )));
    if (draft && (draft.text || draft.images.length > 0)) {
      conversationDraftByScopeRef.current.set(key, {
        ...draft,
        submittedStatus: "unknown",
        unknownPromptId: pending.promptId,
        retryableUnknownPrompt: canReconcile,
      });
    }
    const activeScope = draftScopeRef.current;
    if (activeScope && pendingConversationKey(activeScope) === key) {
      const notice = canReconcile
        ? UNCONFIRMED_PROMPT_NOTICE
        : EDITED_UNCONFIRMED_PROMPT_NOTICE;
      setPromptNotice(message ? `消息提交结果未确认：${message}。${notice}` : notice);
    }
  };
  const updateConversationReady = (ready: boolean) => {
    if (!ready) updatePendingPromptWithdrawal(undefined);
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
    boundActiveRunIdRef.current = undefined;
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
    updatePendingAbort(undefined);
    updateSessionControlReady(undefined);
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
    boundActiveRunIdRef.current = currentFocus && stateMatchesFocus(nextState, currentFocus)
      ? nextState.activeRun?.id : undefined;
    projectIdRef.current = nextState.projectId;
    if (!currentFocus) {
      conversationIdRef.current = nextState.conversationId ?? "";
      setSelectingRole(!nextState.conversationId);
    }
    if (nextState.activeRun?.id === outstandingRunIdRef.current) {
      updateOutstandingRunId("");
    }
    const pendingAbort = pendingAbortRef.current;
    if (
      pendingAbort
      && nextState.sessionId === pendingAbort.sessionId
      && nextState.projectId === pendingAbort.projectId
      && nextState.conversationId === pendingAbort.conversationId
      && nextState.focusId === pendingAbort.focusId
      && nextState.activeRun?.id !== pendingAbort.runId
    ) updatePendingAbort(undefined);
    setActiveCwd(nextState.cwd);
    activeCwdRef.current = nextState.cwd;
    if (
      currentFocus
      && stateMatchesFocus(nextState, currentFocus)
    ) alignVisibleDraftScopeWorkspace(nextState.cwd, currentFocus);
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
      completedOutputRate: event.completedOutputRate,
      bashActivity: event.bashActivity,
    })) return;
    const scope = draftScopeRef.current;
    if (
      !scope
      || scope.projectId !== focus.projectId
      || scope.conversationId !== focus.conversationId
    ) {
      showConversationDraft({
        workspaceKey: currentWorkspaceKey(),
        projectId: focus.projectId,
        conversationId: focus.conversationId,
      });
    }
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
    replacePendingAdmissions(
      event.pendingPrompts.map(({ promptId, text }) => ({
        promptId, text,
        runId: pendingAdmissionsRef.current.find((admission) => admission.promptId === promptId)?.runId,
      })),
    );
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
    const renamePresentation = conversationRenamePresentationsRef.current.get(
      snapshotPresentationKey,
    );
    if (
      renamePresentation?.status === "unknown"
      && renamePresentation.recoverySessionId === event.sessionId
      && renamePresentation.recoveryFocusId === event.focusId
    ) {
      updateConversationRenamePresentation(snapshotPresentationKey, undefined);
    }
    if (
      settleReadiness
      && (workspaceSyncingRef.current || conversationSyncingRef.current)
    ) {
      if (workspaceSyncingRef.current) clearTemporaryWorkspacePresentation();
      updateWorkspaceSyncing(false);
      updateConversationSyncing(false);
    }
    if (conversationReadyRef.current && settleReadiness && !pendingFocusRef.current
      && protocolReadyRef.current && transportOnlineRef.current && !pendingPromptRef.current) {
      const currentScope = draftScopeRef.current;
      const savedDraft = currentScope && conversationDraftByScopeRef.current.get(
        pendingConversationKey(currentScope),
      );
      if (currentScope?.projectId === focus.projectId
        && currentScope.conversationId === focus.conversationId
        && savedDraft?.retryableUnknownPrompt && savedDraft.unknownPromptId) {
        sendPrompt(savedDraft.text, savedDraft.images);
      }
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
        (pendingFocusRef.current?.operation === "create_conversation"
          || pendingFocusRef.current?.operation === "fork_conversation")
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
      if (event.type === "workspace_sessions_inspected") {
        const owner = pendingWorkspaceSessionCommandRef.current;
        const dialog = workspaceSessionRepairRef.current;
        if (
          !owner
          || owner.operation !== "inspect"
          || owner.commandId !== event.commandId
          || owner.socket !== socketRef.current
          || owner.connectionEpoch !== epoch
          || !dialog
          || dialog.dialogId !== owner.dialogId
          || workspaceKey(owner.cwd) !== workspaceKey(event.cwd)
        ) return;
        pendingWorkspaceSessionCommandRef.current = undefined;
        updateWorkspaceSessionRepair({
          ...dialog,
          cwd: event.cwd,
          report: event,
          reportFresh: true,
          pending: undefined,
          phase: "report",
          error: "",
          needsRecheck: false,
        });
        return;
      }
      if (event.type === "workspace_sessions_repaired") {
        const owner = pendingWorkspaceSessionCommandRef.current;
        const dialog = workspaceSessionRepairRef.current;
        if (
          !owner
          || owner.operation !== "repair"
          || owner.commandId !== event.commandId
          || owner.socket !== socketRef.current
          || owner.connectionEpoch !== epoch
          || !dialog
          || dialog.dialogId !== owner.dialogId
          || workspaceKey(owner.cwd) !== workspaceKey(event.cwd)
        ) return;
        pendingWorkspaceSessionCommandRef.current = undefined;
        const updated: WorkspaceSessionRepairDialogState = {
          ...dialog,
          cwd: event.cwd,
          backups: [...dialog.backups, ...event.backups],
          pending: undefined,
          reportFresh: owner.purpose === "enter" && !event.error
            ? dialog.reportFresh
            : false,
          phase: "report",
          repairError: event.error ?? "",
          error: event.error
            ? "服务端返回修复错误；已提交部分可能已经生效。正在重新检查。"
            : "",
          needsRecheck: owner.purpose !== "enter" || Boolean(event.error),
        };
        updateWorkspaceSessionRepair(updated);
        if (owner.purpose === "enter" && !event.error) {
          const started = initialize(
            event.cwd,
            { kind: "recent" },
            undefined,
            socket,
            "user",
            owner.dialogId,
          );
          if (!started) {
            const current = workspaceSessionRepairRef.current;
            if (current?.dialogId === owner.dialogId) {
              updateWorkspaceSessionRepair({
                ...current,
                phase: "report",
                reportFresh: true,
                error: "服务端检查请求已响应，但工作区初始化请求未发送。"
              });
            }
          }
        } else {
          inspectWorkspaceSessionFiles(owner.dialogId, socket, epoch);
        }
        return;
      }
      if (event.type === "hello") {
        if (event.protocolVersion !== PROTOCOL_VERSION) {
          const message = `协议版本不兼容：服务端 ${event.protocolVersion}，客户端 ${PROTOCOL_VERSION}`;
          invalidateWorkspaceSessionRepair(
            "协议版本失配；检查/修复结果不可确认，请在协议恢复后重新检查。",
          );
          transitionTiming.cancel("protocol-error");
          protocolReadyRef.current = false;
          transportOnlineRef.current = false;
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
        protocolReadyRef.current = true;
        setProtocolReady(true);
        setSetupCwd((current) => current || event.startupCwd);
        beginCustomProvidersRefresh(socket);
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
      } else if (event.type === "custom_providers_snapshot") {
        setCustomProviders({
          revision: event.revision,
          providers: event.providers,
          error: event.error ?? "",
          truncated: event.truncated,
        });
        if (!event.commandId) return;
        const pendingRefresh = pendingCustomProvidersRefreshRef.current;
        if (pendingRefresh?.commandId === event.commandId) {
          pendingCustomProvidersRefreshRef.current = undefined;
          setCustomProvidersRefreshing(false);
          setCustomProvidersRefreshError("");
          return;
        }
        const pendingMutation = pendingCustomProviderMutationRef.current;
        if (!pendingMutation || pendingMutation.commandId !== event.commandId) return;
        updatePendingCustomProviderMutation(undefined);
        setCustomProviderMutationResult({
          ok: true,
          message: pendingMutation.operation === "delete_custom_provider"
            ? "自定义提供商已删除。"
            : "自定义提供商已保存。",
        });
      } else if (event.type === "custom_provider_models_probe") {
        const pending = pendingCustomProviderProbeRef.current;
        if (!pending || pending.commandId !== event.commandId) return;
        updatePendingCustomProviderProbe(undefined);
        setCustomProviderProbeResult({
          commandId: event.commandId,
          baseUrl: event.baseUrl,
          models: event.models,
          truncated: event.truncated,
          error: "",
        });
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
        const repairDialog = workspaceSessionRepairRef.current;
        if (
          repairDialog?.phase === "entering"
          && repairDialog.enterSessionId === event.state.sessionId
          && !event.state.conversationId
          && !event.state.focusId
        ) {
          const attached = repairDialog.enterEmptyProjectId === event.state.projectId;
          updateWorkspaceSessionRepair({
            ...repairDialog,
            phase: attached ? "ready" : "entering",
            enterEmptyProjectId: event.state.projectId,
            enterStateSeen: true,
            ...(attached ? {
              enterSessionId: undefined,
              enterCommandId: undefined,
              enterEmptyProjectId: undefined,
              enterStateSeen: false,
              enterSnapshotSeen: false,
              needsRecheck: false,
              error: "",
            } : {}),
          });
        } else if (
          repairDialog?.phase === "entering"
          && repairDialog.enterFocus
          && stateMatchesFocus(event.state, repairDialog.enterFocus)
        ) {
          const ready = Boolean(repairDialog.enterSnapshotSeen);
          updateWorkspaceSessionRepair({
            ...repairDialog,
            phase: ready ? "ready" : "entering",
            enterStateSeen: true,
            ...(ready ? {
              enterSessionId: undefined,
              enterCommandId: undefined,
              enterFocus: undefined,
              needsRecheck: false,
              error: "",
            } : {}),
          });
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
        const repairDialog = workspaceSessionRepairRef.current;
        if (
          event.operation === "initialize"
          && repairDialog?.enterSessionId === event.sessionId
          && repairDialog.enterCommandId === event.commandId
          && workspaceKey(repairDialog.cwd) === currentWorkspaceKey()
        ) {
          if (event.conversationId && event.focusId) {
            const enterFocus: ActiveFocus = {
              sessionId: event.sessionId,
              projectId: event.projectId,
              conversationId: event.conversationId,
              focusId: event.focusId,
            };
            const pendingState = pendingFocusedStateRef.current;
            updateWorkspaceSessionRepair({
              ...repairDialog,
              phase: "entering",
              enterFocus,
              enterEmptyProjectId: undefined,
              enterStateSeen: Boolean(pendingState && stateMatchesFocus(pendingState, enterFocus)),
              enterSnapshotSeen: false,
            });
          } else {
            const stateSeen = repairDialog.enterStateSeen
              && repairDialog.enterEmptyProjectId === event.projectId;
            updateWorkspaceSessionRepair({
              ...repairDialog,
              phase: stateSeen ? "ready" : "entering",
              enterFocus: undefined,
              enterEmptyProjectId: stateSeen ? undefined : event.projectId,
              enterStateSeen: false,
              enterSnapshotSeen: false,
              ...(stateSeen ? {
                enterSessionId: undefined,
                enterCommandId: undefined,
                needsRecheck: false,
                error: "",
              } : {}),
            });
          }
        }
        if (
          event.conversationId
          && event.focusId
          && (
            event.operation === "focus_conversation"
            || (
              event.operation === "initialize"
              && pending.initializeConversationKind === "open"
            )
          )
        ) {
          const renameKey = conversationScopeKey(
            pending.workspaceKey,
            event.projectId,
            event.conversationId,
          );
          const renamePresentation = conversationRenamePresentationsRef.current.get(
            renameKey,
          );
          if (renamePresentation?.status === "unknown") {
            updateConversationRenamePresentation(renameKey, {
              ...renamePresentation,
              recoverySessionId: event.sessionId,
              recoveryFocusId: event.focusId,
            });
          }
        }
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
        if (event.operation === "initialize") {
          updateSessionControlReady({
            sessionId: event.sessionId,
            projectId: event.projectId,
          });
        }
        updateConversationSyncing(
          event.operation === "focus_conversation"
          || event.operation === "create_conversation"
          || event.operation === "fork_conversation",
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
          if (event.operation === "create_conversation"
            || event.operation === "fork_conversation") {
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
          clearRenamesConfirmedByProjectSnapshot(
            event.projectId,
            event.conversations,
          );
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
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)
          || settledPromptIdsRef.current.has(event.promptId)) return;
        // Durable acceptance clears the draft; SDK delivery is a separate receipt.
        const pending = pendingPromptRef.current;
        const acceptedPending = pending && pending.promptId === event.promptId
          && pending.sessionId === event.sessionId
          && pending.conversationId === event.conversationId
          && pending.focusId === event.focusId ? pending : undefined;
        if (acceptedPending) {
          setPromptNotice("");
          settleAcceptedPromptDraft(acceptedPending);
          updatePendingPrompt(undefined);
          if (outstandingRunIdRef.current === acceptedPending.runId) {
            updateOutstandingRunId("");
          }
        }
        settleUnconfirmedDraftReceipt(event.promptId, true);
        addPendingAdmission({ promptId: event.promptId, text: event.text, runId: event.runId });
      } else if (event.type === "prompt_delivered") {
        settleSubmittedPromptReceipt(event, true);
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        recordSettledPrompt(event.promptId);
        removePendingAdmission(event.promptId);
        const pending = pendingPromptWithdrawalRef.current;
        if (pending?.promptId === event.promptId && pending.runId === event.runId) {
          setPromptNotice("消息已投递，无法撤回。");
        }
      } else if (event.type === "prompt_withdrawn") {
        settleSubmittedPromptReceipt(event, false);
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        recordSettledPrompt(event.promptId);
        removePendingAdmission(event.promptId);
        const pending = pendingPromptWithdrawalRef.current;
        if (pending?.promptId === event.promptId && pending.runId === event.runId) {
          updatePendingPromptWithdrawal(undefined);
        }
      } else if (event.type === "conversation_image" || event.type === "local_image") {
        const pending = pendingImageOpensRef.current.get(event.commandId);
        if (!pending) return;
        pendingImageOpensRef.current.delete(event.commandId);
        const matchesSource = event.type === "local_image"
          ? "path" in pending.source && pending.source.path === event.path
          : "messageId" in pending.source
            && pending.source.messageId === event.messageId
            && pending.source.imageOrdinal === event.imageOrdinal;
        if (
          pending.sessionId !== event.sessionId
          || pending.conversationId !== event.conversationId
          || pending.focusId !== event.focusId
          || !matchesSource
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
      } else if (event.type === "bash_activity") {
        if (pendingFocusRef.current) return;
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        const focus = focusRef.current;
        if (!focus) return;
        dispatchChat({
          type: "bash_activity",
          activity: event.activity,
          ...focus,
        });
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
        const repairDialog = workspaceSessionRepairRef.current;
        const enteredFocus = repairDialog?.enterFocus;
        // Attached identity survives state normalizing an alias cwd.
        if (
          repairDialog?.phase === "entering"
          && enteredFocus
          && enteredFocus.sessionId === event.sessionId
          && enteredFocus.conversationId === event.conversationId
          && enteredFocus.focusId === event.focusId
        ) {
          const ready = Boolean(repairDialog.enterStateSeen);
          updateWorkspaceSessionRepair({
            ...repairDialog,
            phase: ready ? "ready" : "entering",
            enterSnapshotSeen: true,
            ...(ready ? {
              enterSessionId: undefined,
              enterCommandId: undefined,
              enterFocus: undefined,
              needsRecheck: false,
              error: "",
            } : {}),
          });
        }
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
        const pendingAbort = pendingAbortRef.current;
        if (
          pendingAbort
          && event.event.type === "run_finished"
          && event.runId === pendingAbort.runId
          && sameFocus(pendingAbort, focusRef.current ?? pendingAbort)
        ) updatePendingAbort(undefined);
        if (event.event.type === "run_finished"
          && pendingPromptWithdrawalRef.current?.runId === event.runId) {
          updatePendingPromptWithdrawal(undefined);
        }
        const focus = focusRef.current;
        if (!focus) return;
        dispatchChat({
          type: "session",
          runId: event.runId,
          event: event.event,
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
        if (event.operation === "withdraw_prompt") {
          const pending = pendingPromptWithdrawalRef.current;
          if (!pending
            || pending.sessionId !== event.sessionId
            || pending.commandId !== event.commandId
            || !matchesFocus(pending.sessionId, pending.conversationId, pending.focusId)
          ) return;
          updatePendingPromptWithdrawal(undefined);
          return;
        }
        if (event.operation === "rename_conversation") {
          for (const [key, presentation] of conversationRenamePresentationsRef.current) {
            if (
              presentation.sessionId === event.sessionId
              && presentation.commandId === event.commandId
            ) {
              updateConversationRenamePresentation(key, {
                ...presentation,
                status: "committed",
              });
              setNotification({
                id: ++notificationIdRef.current,
                level: "info",
                message: "对话名称已保存",
              });
              return;
            }
          }
          return;
        }
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
          updateConversationRenamePresentation(targetKey, undefined);
          if (affectedFocusKey) {
            conversationDraftByScopeRef.current.delete(affectedFocusKey);
            updateConversationRenamePresentation(affectedFocusKey, undefined);
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
        if (
          event.scope === "command"
          && event.commandId
          && (event.operation === "inspect_workspace_sessions"
            || event.operation === "repair_workspace_sessions")
        ) {
          const owner = pendingWorkspaceSessionCommandRef.current;
          const dialog = workspaceSessionRepairRef.current;
          if (
            !owner
            || owner.commandId !== event.commandId
            || owner.socket !== socketRef.current
            || owner.connectionEpoch !== epoch
            || !dialog
            || dialog.dialogId !== owner.dialogId
            || (owner.operation === "inspect"
              ? event.operation !== "inspect_workspace_sessions"
              : event.operation !== "repair_workspace_sessions")
          ) return;
          pendingWorkspaceSessionCommandRef.current = undefined;
          updateWorkspaceSessionRepair({
            ...dialog,
            pending: undefined,
            reportFresh: false,
            error: owner.operation === "repair"
              ? `修复请求失败：${event.message}。结果可能部分提交，正在重新检查。`
              : `检查失败：${event.message}`,
            repairError: owner.operation === "repair" ? event.message : dialog.repairError,
            needsRecheck: owner.operation === "repair" || dialog.needsRecheck,
          });
          if (owner.operation === "repair") {
            inspectWorkspaceSessionFiles(owner.dialogId, socket, epoch);
          }
          return;
        }
        const pendingImageOpen = (
          event.operation === "open_image" || event.operation === "open_local_image"
        ) && event.commandId ? pendingImageOpensRef.current.get(event.commandId) : undefined;
        if (
          pendingImageOpen
          && event.operation === ("path" in pendingImageOpen.source ? "open_local_image" : "open_image")
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
        if (
          event.commandId
          && (
            event.operation === "save_custom_provider"
            || event.operation === "delete_custom_provider"
          )
        ) {
          const pending = pendingCustomProviderMutationRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingCustomProviderMutation(undefined);
          setCustomProviderMutationResult({
            ok: false,
            message: event.message
              || (pending.operation === "delete_custom_provider" ? "删除失败" : "保存失败"),
          });
          return;
        }
        if (event.operation === "probe_custom_provider_models" && event.commandId) {
          const pending = pendingCustomProviderProbeRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingCustomProviderProbe(undefined);
          setCustomProviderProbeResult({
            commandId: event.commandId,
            baseUrl: pending.baseUrl,
            models: [],
            truncated: false,
            error: event.message || "拉取模型列表失败",
          });
          return;
        }
        if (event.operation === "refresh_custom_providers" && event.commandId) {
          const pending = pendingCustomProvidersRefreshRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          pendingCustomProvidersRefreshRef.current = undefined;
          setCustomProvidersRefreshing(false);
          setCustomProvidersRefreshError(`读取本机模型配置失败：${event.message}`);
          return;
        }
        if (event.sessionId && event.sessionId !== sessionIdRef.current) return;
        if (event.operation === "withdraw_prompt") {
          const pending = pendingPromptWithdrawalRef.current;
          if (!pending
            || event.scope !== "command"
            || pending.sessionId !== event.sessionId
            || pending.commandId !== event.commandId
            || pending.runId !== event.runId
            || pending.conversationId !== event.conversationId
            || pending.focusId !== event.focusId
            || !matchesFocus(pending.sessionId, pending.conversationId, pending.focusId)
          ) return;
          updatePendingPromptWithdrawal(undefined);
          setPromptNotice(`撤回失败：${event.message}`);
          return;
        }
        if (
          event.operation === "rename_conversation"
          && event.sessionId
          && event.commandId
        ) {
          for (const [key, presentation] of conversationRenamePresentationsRef.current) {
            if (
              presentation.sessionId !== event.sessionId
              || presentation.commandId !== event.commandId
              || (
                event.conversationId !== undefined
                && presentation.conversationId !== event.conversationId
              )
            ) continue;
            if (event.scope === "settings") {
              updateConversationRenamePresentation(key, {
                ...presentation,
                status: "unknown",
                recoverySessionId: undefined,
                recoveryFocusId: undefined,
              });
              setError(event.message);
            } else {
              updateConversationRenamePresentation(key, undefined);
              setError(`重命名对话失败：${event.message}`);
            }
            return;
          }
          return;
        }
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
        if (event.operation === "abort") {
          const pendingAbort = pendingAbortRef.current;
          if (
            pendingAbort
            && event.sessionId === pendingAbort.sessionId
            && event.conversationId === pendingAbort.conversationId
            && event.focusId === pendingAbort.focusId
            && event.runId === pendingAbort.runId
          ) {
            updatePendingAbort(undefined);
            setError(`停止请求失败：${event.message}`);
          }
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
            || event.operation === "create_conversation"
            || event.operation === "fork_conversation")
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
            setWorkspaceInitializationFailure({
              cwd: activeCwdRef.current,
              message: event.message,
            });
            const repairDialog = workspaceSessionRepairRef.current;
            if (
              repairDialog
              && repairDialog.enterSessionId === event.sessionId
              && repairDialog.enterCommandId === event.commandId
            ) {
              updateWorkspaceSessionRepair({
                ...repairDialog,
                phase: "report",
                enterSessionId: undefined,
                enterCommandId: undefined,
                enterFocus: undefined,
                reportFresh: false,
                needsRecheck: true,
                error: `工作区初始化失败：${event.message}。请重新检查后再尝试进入。`,
              });
            }
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
        let matchedPendingPromptError = false;
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
            matchedPendingPromptError = true;
            markPendingPromptUnconfirmed(event.message);
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
            && !matchedPendingPromptError
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
      transportOnlineRef.current = connected;
      setTransportOnline(connected);
      if (!connected) {
        const repairOwner = pendingWorkspaceSessionCommandRef.current;
        const repairDialog = workspaceSessionRepairRef.current;
        if (repairOwner || repairDialog) {
          invalidateWorkspaceSessionRepair(
            repairOwner?.operation === "repair"
              ? "连接已断开，修复结果未确认；请重新检查。不会自动重试修复。"
              : "连接已断开，进入状态未确认；请重新检查后手动继续。不会自动重新进入。",
          );
        }
        closePendingImageOpens();
        transitionTiming.cancel("disconnect");
        protocolReadyRef.current = false;
        setProtocolReady(false);
        setProjectActivityByWorkspace(new Map());
        setProjectActivityTruncated(false);
        pendingSettingCommandsRef.current = {};
        setSettingResults({});
        updateSessionControlReady(undefined);
        markSyncingRenamesUnknown();
        updatePendingAbort(undefined);
        if (pendingPromptWithdrawalRef.current) {
          updatePendingPromptWithdrawal(undefined);
          setPromptNotice("连接已断开，撤回结果未确认；重连后请核对等待中消息。");
        }
        if (pendingColorSchemeRef.current) {
          updatePendingColorScheme(undefined);
          setColorSchemeSaveError("连接已断开，无法确认配色是否保存；重连后请重试。");
        }
        if (pendingCustomProvidersRefreshRef.current) {
          pendingCustomProvidersRefreshRef.current = undefined;
          setCustomProvidersRefreshing(false);
          setCustomProvidersRefreshError(
            "连接已断开，未能读取本机模型配置；重连后请重试。",
          );
        }
        const pendingCustomProviderMutation = pendingCustomProviderMutationRef.current;
        if (pendingCustomProviderMutation) {
          updatePendingCustomProviderMutation(undefined);
          setCustomProviderMutationResult({
            ok: false,
            message: "连接已断开，保存结果未确认；重连后请检查 models.json 或重试。",
          });
        }
        const pendingCustomProviderProbe = pendingCustomProviderProbeRef.current;
        if (pendingCustomProviderProbe) {
          updatePendingCustomProviderProbe(undefined);
          setCustomProviderProbeResult({
            commandId: pendingCustomProviderProbe.commandId,
            baseUrl: pendingCustomProviderProbe.baseUrl,
            models: [],
            truncated: false,
            error: "连接已断开，模型列表未确认；重连后请重试。",
          });
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
    let replaceConnectionOnResume = false;
    if (
      document.visibilityState === "hidden"
      && backgroundedAtRef.current === undefined
    ) {
      backgroundedAtRef.current = Date.now();
    }
    const flush = () => {
      refreshTimer = undefined;
      if (document.visibilityState === "hidden") return;
      const replaceCurrent = replaceConnectionOnResume;
      replaceConnectionOnResume = false;
      if (socketRef.current?.resume(replaceCurrent)) return;
      if (
        !transportOnline
        || !protocolReady
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
    const noteBackgrounded = () => {
      backgroundedAtRef.current ??= Date.now();
    };
    const schedule = () => {
      if (document.visibilityState === "hidden") {
        noteBackgrounded();
        return;
      }
      const backgroundedAt = backgroundedAtRef.current;
      backgroundedAtRef.current = undefined;
      if (
        backgroundedAt !== undefined
        && Date.now() - backgroundedAt >= RESUME_RECONNECT_AFTER_HIDDEN_MS
      ) {
        replaceConnectionOnResume = true;
      }
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(flush, RESUME_REFRESH_DELAY_MS);
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) replaceConnectionOnResume = true;
      schedule();
    };
    window.addEventListener("focus", schedule);
    window.addEventListener("online", schedule);
    window.addEventListener("pagehide", noteBackgrounded);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("online", schedule);
      window.removeEventListener("pagehide", noteBackgrounded);
      window.removeEventListener("pageshow", handlePageShow);
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
    if (!protocolReadyRef.current) {
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
  const refreshCustomProviders = () => {
    const socket = socketRef.current;
    if (!protocolReady || !transportOnline || !socket) {
      setCustomProvidersRefreshing(false);
      setCustomProvidersRefreshError("本地服务未连接；无法读取本机模型配置，重连后请重试。");
      return;
    }
    beginCustomProvidersRefresh(socket);
  };
  const customProviderCommandPending = () => (
    Boolean(pendingCustomProviderMutationRef.current)
    || Boolean(pendingCustomProviderProbeRef.current)
  );
  const saveCustomProvider = (
    provider: CustomProviderSaveInput,
  ): string | undefined => {
    const revision = customProviders?.revision;
    if (!revision) {
      setCustomProviderMutationResult({
        ok: false,
        message: "尚未读取本机模型配置；请先读取最新配置再保存。",
      });
      return undefined;
    }
    if (customProviderCommandPending()) return undefined;
    if (!protocolReady || !transportOnline) {
      setCustomProviderMutationResult({
        ok: false,
        message: "本地服务未连接；配置未保存，重连后请重试。",
      });
      return undefined;
    }
    const commandId = crypto.randomUUID();
    updatePendingCustomProviderMutation({
      commandId,
      operation: "save_custom_provider",
    });
    setCustomProviderMutationResult(undefined);
    if (!socketRef.current?.send({
      type: "save_custom_provider",
      commandId,
      expectedRevision: revision,
      provider,
    })) {
      updatePendingCustomProviderMutation(undefined);
      setCustomProviderMutationResult({
        ok: false,
        message: "本地服务未连接；配置未保存，请重试。",
      });
      return undefined;
    }
    return commandId;
  };
  const deleteCustomProvider = (providerId: string): string | undefined => {
    const revision = customProviders?.revision;
    if (!revision) {
      setCustomProviderMutationResult({
        ok: false,
        message: "尚未读取本机模型配置；请先读取最新配置再删除。",
      });
      return undefined;
    }
    if (customProviderCommandPending()) return undefined;
    if (!protocolReady || !transportOnline) {
      setCustomProviderMutationResult({
        ok: false,
        message: "本地服务未连接；未删除，重连后请重试。",
      });
      return undefined;
    }
    const commandId = crypto.randomUUID();
    updatePendingCustomProviderMutation({
      commandId,
      operation: "delete_custom_provider",
    });
    setCustomProviderMutationResult(undefined);
    if (!socketRef.current?.send({
      type: "delete_custom_provider",
      commandId,
      expectedRevision: revision,
      providerId,
    })) {
      updatePendingCustomProviderMutation(undefined);
      setCustomProviderMutationResult({
        ok: false,
        message: "本地服务未连接；未删除，请重试。",
      });
      return undefined;
    }
    return commandId;
  };
  const probeCustomProviderModels = (baseUrl: string): string | undefined => {
    if (customProviderCommandPending()) return undefined;
    if (!protocolReady || !transportOnline) return undefined;
    const commandId = crypto.randomUUID();
    updatePendingCustomProviderProbe({ commandId, baseUrl });
    setCustomProviderProbeResult(undefined);
    if (!socketRef.current?.send({
      type: "probe_custom_provider_models",
      commandId,
      baseUrl,
    })) {
      updatePendingCustomProviderProbe(undefined);
      setCustomProviderProbeResult({
        commandId,
        baseUrl,
        models: [],
        truncated: false,
        error: "本地服务未连接；无法拉取模型列表。",
      });
      return undefined;
    }
    return commandId;
  };
  const openImageSource = useCallback((source: ConversationImageLocator | { path: string }) => {
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
      source,
      target,
    };
    pendingImageOpensRef.current.set(commandId, pending);
    const identity = {
      commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
    };
    const sent = socketRef.current?.send("path" in source
      ? { type: "open_local_image", ...identity, path: source.path }
      : { type: "open_image", ...identity, ...source }) ?? false;
    if (!sent) {
      pendingImageOpensRef.current.delete(commandId);
      target.close();
      setError("本地服务未连接");
    }
  }, [protocolReady]);
  const openImage = useCallback((source: ConversationImageLocator) => {
    openImageSource(source);
  }, [openImageSource]);
  const openLocalImage = useCallback((path: string) => {
    openImageSource({ path });
  }, [openImageSource]);
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
  const inspectWorkspaceSessionFiles = (
    dialogId: string,
    socket = socketRef.current,
    connectionEpoch = socketEpochRef.current,
  ): boolean => {
    const dialog = workspaceSessionRepairRef.current;
    if (!dialog || dialog.dialogId !== dialogId) return false;
    if (!socket || !transportOnlineRef.current || !protocolReadyRef.current) {
      updateWorkspaceSessionRepair({
        ...dialog,
        pending: undefined,
        reportFresh: false,
        error: "本地服务未连接；请连接后重新检查。",
      });
      return false;
    }
    if (pendingWorkspaceSessionCommandRef.current) return false;
    const owner: PendingWorkspaceSessionCommand = {
      socket,
      connectionEpoch,
      dialogId,
      cwd: dialog.cwd,
      commandId: crypto.randomUUID(),
      operation: "inspect",
      purpose: "inspect",
    };
    pendingWorkspaceSessionCommandRef.current = owner;
    updateWorkspaceSessionRepair({
      ...dialog,
      pending: "inspect",
      reportFresh: false,
      error: "",
      needsRecheck: dialog.needsRecheck,
    });
    if (!socket.send({
      type: "inspect_workspace_sessions",
      commandId: owner.commandId,
      cwd: owner.cwd,
    })) {
      if (pendingWorkspaceSessionCommandRef.current === owner) {
        pendingWorkspaceSessionCommandRef.current = undefined;
        const current = workspaceSessionRepairRef.current;
        if (current?.dialogId === dialogId) {
          updateWorkspaceSessionRepair({
            ...current,
            pending: undefined,
            reportFresh: false,
            error: "检查请求未发送；请确认本地服务连接后重试。",
          });
        }
      }
      return false;
    }
    return true;
  };
  const repairWorkspaceSessionFiles = (
    dialogId: string,
    files: WorkspaceSessionRepairRequest[],
    allowDiscardIncompleteTail: boolean,
  ): boolean => {
    const dialog = workspaceSessionRepairRef.current;
    const socket = socketRef.current;
    const report = dialog?.report;
    if (
      !dialog
      || dialog.dialogId !== dialogId
      || !report
      || !dialog.reportFresh
      || !socket
      || !transportOnlineRef.current
      || !protocolReadyRef.current
      || pendingWorkspaceSessionCommandRef.current
      || files.length === 0
    ) return false;
    const issuesByFile = new Map(report.issues.map((issue) => [issue.fileName, issue]));
    const selectedIssues = files.map((file) => issuesByFile.get(file.fileName));
    if (selectedIssues.some((issue, index) => (
      !issue
      || issue.revision !== files[index]?.expectedRevision
      || issue.repair === null
      || (issue.repair.kind === "discard_incomplete_tail" && !allowDiscardIncompleteTail)
    ))) return false;
    const owner: PendingWorkspaceSessionCommand = {
      socket,
      connectionEpoch: socketEpochRef.current,
      dialogId,
      cwd: report.cwd,
      commandId: crypto.randomUUID(),
      operation: "repair",
      purpose: "repair",
    };
    pendingWorkspaceSessionCommandRef.current = owner;
    updateWorkspaceSessionRepair({
      ...dialog,
      pending: "repair",
      reportFresh: false,
      error: "",
      needsRecheck: true,
    });
    if (!socket.send({
      type: "repair_workspace_sessions",
      commandId: owner.commandId,
      cwd: owner.cwd,
      files,
      allowDiscardIncompleteTail,
    })) {
      if (pendingWorkspaceSessionCommandRef.current === owner) {
        pendingWorkspaceSessionCommandRef.current = undefined;
        const current = workspaceSessionRepairRef.current;
        if (current?.dialogId === dialogId) {
          updateWorkspaceSessionRepair({
            ...current,
            pending: undefined,
            reportFresh: true,
            error: "修复请求未发送；尚未提交修复，请确认连接后重试。",
            needsRecheck: false,
          });
        }
      }
      return false;
    }
    return true;
  };
  const sendEmptyWorkspaceSessionRepair = (
    dialogId: string,
    purpose: "retry-recovery" | "enter",
  ): boolean => {
    const dialog = workspaceSessionRepairRef.current;
    const report = dialog?.report;
    const socket = socketRef.current;
    if (
      !dialog
      || dialog.dialogId !== dialogId
      || !report
      || !dialog.reportFresh
      || !socket
      || !transportOnlineRef.current
      || !protocolReadyRef.current
      || pendingWorkspaceSessionCommandRef.current
      || report.truncated
      || report.issues.length > 0
      || (purpose === "enter" && report.recoveryError !== undefined)
      || (purpose === "retry-recovery" && !report.recoveryError)
    ) return false;
    const owner: PendingWorkspaceSessionCommand = {
      socket,
      connectionEpoch: socketEpochRef.current,
      dialogId,
      cwd: report.cwd,
      commandId: crypto.randomUUID(),
      operation: "repair",
      purpose,
    };
    pendingWorkspaceSessionCommandRef.current = owner;
    updateWorkspaceSessionRepair({
      ...dialog,
      pending: "repair",
      reportFresh: purpose === "enter",
      error: "",
      needsRecheck: true,
    });
    if (!socket.send({
      type: "repair_workspace_sessions",
      commandId: owner.commandId,
      cwd: owner.cwd,
      files: [],
      allowDiscardIncompleteTail: false,
    })) {
      if (pendingWorkspaceSessionCommandRef.current === owner) {
        pendingWorkspaceSessionCommandRef.current = undefined;
        const current = workspaceSessionRepairRef.current;
        if (current?.dialogId === dialogId) {
          updateWorkspaceSessionRepair({
            ...current,
            pending: undefined,
            reportFresh: true,
            error: "重新校验请求未发送；工作区尚未重新打开。",
            needsRecheck: false,
          });
        }
      }
      return false;
    }
    return true;
  };
  const openWorkspaceSessionRepair = (cwd: string) => {
    const path = cwd.trim();
    if (!path || pendingWorkspaceSessionCommandRef.current?.operation === "repair") return;
    pendingWorkspaceSessionCommandRef.current = undefined;
    const dialogId = crypto.randomUUID();
    const key = workspaceKey(path);
    const current = workspaceSessionRepairRef.current;
    const currentForKey = current && workspaceKey(current.cwd) === key ? current : undefined;
    const previous = currentForKey ?? workspaceSessionRepairArchiveRef.current.get(key);
    setSetupOpen(false);
    updateDirectoryBrowser(undefined);
    updateWorkspaceSessionRepair({
      dialogId,
      cwd: path,
      report: currentForKey?.report,
      reportFresh: false,
      backups: previous?.backups ?? [],
      pending: undefined,
      phase: "report",
      dismissed: false,
      error: previous?.needsRecheck ? previous.error : "",
      repairError: previous?.repairError,
      needsRecheck: previous?.needsRecheck,
    });
    if (!inspectWorkspaceSessionFiles(dialogId)) {
      const current = workspaceSessionRepairRef.current;
      if (current?.dialogId === dialogId && !transportOnlineRef.current) {
        updateWorkspaceSessionRepair({
          ...current,
          error: "本地服务未连接；请连接后重新检查。",
        });
      }
    }
  };
  function initialize(
    cwd: string,
    conversation: Extract<ClientCommand, { type: "initialize" }>["conversation"] = {
      kind: "recent",
    },
    cached?: CachedWorkspaceProjection,
    transport?: PiSocket,
    origin: TransitionOrigin = "user",
    repairDialogId?: string,
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
    const repairDialog = workspaceSessionRepairRef.current;
    if (
      repairDialog
      && workspaceKey(repairDialog.cwd) !== workspaceKey(normalizedCwd)
    ) {
      invalidateWorkspaceSessionRepair(
        "工作区已切换；原工作区修复结果未确认，请重新检查。不会自动重试修复。",
      );
    }
    setWorkspaceInitializationFailure(undefined);
    if (repairDialogId) {
      const currentRepairDialog = workspaceSessionRepairRef.current;
      if (currentRepairDialog?.dialogId === repairDialogId) {
        updateWorkspaceSessionRepair({
          ...currentRepairDialog,
          phase: "entering",
          enterSessionId: sessionId,
          enterCommandId: commandId,
          enterFocus: undefined,
          enterEmptyProjectId: undefined,
          enterStateSeen: false,
          enterSnapshotSeen: false,
          reportFresh: true,
          needsRecheck: true,
          error: "",
        });
      }
    }
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
    if (pendingConversationTruncationRef.current || pendingPromptRef.current) return false;
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    const scope = draftScopeRef.current;
    if (
      !sessionId
      || !focus
      || focus.sessionId !== sessionId
      || !scope
      || scope.projectId !== focus.projectId
      || scope.conversationId !== focus.conversationId
    ) return false;
    const knownRunOwnerId = boundActiveRunIdRef.current || outstandingRunIdRef.current;
    const runId = crypto.randomUUID();
    const savedDraft = conversationDraftByScopeRef.current.get(pendingConversationKey(scope));
    const promptId = savedDraft?.retryableUnknownPrompt && savedDraft.unknownPromptId
      && savedDraft.text.trim() === trimmed
      && savedDraft.images.length === images.length
      && savedDraft.images.every((image, index) => (
        image.mimeType === images[index]?.mimeType && image.data === images[index]?.data
      ))
      ? savedDraft.unknownPromptId
      : crypto.randomUUID();
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
    const bytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
    if (bytes > MAX_MESSAGE_BYTES) {
      setPromptNotice("图片和消息合计超过单条传输上限，请移除图片或缩短消息。");
      return false;
    }
    const submittedImages = images.map((image) => ({ ...image }));
    const pending: DirectPendingPrompt = {
      ...focus,
      workspaceKey: scope.workspaceKey,
      runId,
      promptId,
      text: trimmed,
      images: submittedImages,
    };
    setPromptNotice("");
    updatePendingPrompt(pending);
    if (!knownRunOwnerId) updateOutstandingRunId(runId);
    const ok = send(command);
    if (!ok) {
      if (pendingPromptRef.current !== pending) return false;
      updatePendingPrompt(undefined);
      if (outstandingRunIdRef.current === runId) updateOutstandingRunId("");
      setPromptNotice(savedDraft?.unknownPromptId === promptId
        ? "消息提交结果仍未确认，草稿已保留；恢复会话后将再次核对。"
        : "消息未发送，内容已保留，可以重试。");
      return false;
    }
    return true;
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
  const withdrawPrompt = (promptId: string) => {
    const focus = focusRef.current;
    const activeRun = state?.activeRun;
    if (!online || !settingsEnabled || !conversationReadyRef.current
      || pendingFocusRef.current || pendingPromptWithdrawalRef.current
      || pendingAbortRef.current || !focus || !state || !stateMatchesFocus(state, focus)
      || !activeRun || (activeRun.phase !== "running" && activeRun.phase !== "waiting")
      || !pendingAdmissionsRef.current.some((admission) => admission.promptId === promptId)
    ) return;
    const pending = { ...focus, runId: activeRun.id, promptId, commandId: crypto.randomUUID() };
    updatePendingPromptWithdrawal(pending);
    setPromptNotice("");
    const sent = send({
      type: "withdraw_prompt",
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      runId: pending.runId,
      promptId,
      commandId: pending.commandId,
    });
    if (!sent && pendingPromptWithdrawalRef.current === pending) {
      updatePendingPromptWithdrawal(undefined);
      setPromptNotice("撤回请求未发送，等待中消息已保留，请重试。");
    }
  };
  const abortCurrentRun = () => {
    if (!conversationReadyRef.current || pendingFocusRef.current) return;
    const runId = state?.activeRun?.id || outstandingRunIdRef.current;
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    const existingAbort = pendingAbortRef.current;
    if (
      !sessionId
      || !runId
      || !focus
      || (
        existingAbort?.runId === runId
        && sameFocus(existingAbort, focus)
      )
    ) return;
    const pending = { ...focus, runId };
    updatePendingAbort(pending);
    if (send({
      type: "abort",
      sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      runId,
    })) {
      updatePendingPromptWithdrawal(undefined);
    } else if (pendingAbortRef.current === pending) {
      updatePendingAbort(undefined);
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
      || pendingConversationDeletionScopeRef.current.has(conversationId)
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
    const currentFocus = focusRef.current;
    const reopenUnknownRename = Boolean(
      currentFocus?.conversationId === conversationId
      && conversationRenamePresentationsRef.current.get(conversationScopeKey(
        workspaceKeyValue,
        currentFocus.projectId,
        conversationId,
      ))?.status === "unknown",
    );
    if (
      !replacingDifferentPendingTarget
      && currentFocus?.conversationId === conversationId
      && !reopenUnknownRename
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
    const knownBusyDescendant = conversations.some((candidate) => (
      candidate.rootConversationId === conversationId
      && (
        candidate.compacting
        || (candidate.activity?.kind ?? "idle") !== "idle"
      )
    ));
    const renamePresentation = conversationRenamePresentationsRef.current.get(
      conversationScopeKey(currentWorkspaceKey(), projectId, conversationId),
    );
    if (
      !sessionId
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || focusedConversationNeedsSnapshot()
      || !projectId
      || !conversation
      || (conversation.activity?.kind ?? "idle") !== "idle"
      || knownBusyDescendant
      || renamePresentation?.status === "syncing"
      || renamePresentation?.status === "unknown"
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
  const renameConversation = (conversationId: string, name: string): boolean => {
    const sessionId = sessionIdRef.current;
    const projectId = projectIdRef.current;
    const workspaceKeyValue = currentWorkspaceKey();
    const key = conversationScopeKey(workspaceKeyValue, projectId, conversationId);
    const existing = conversationRenamePresentationsRef.current.get(key);
    if (
      !sessionId
      || !projectId
      || !conversations.some(({ id }) => id === conversationId)
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || focusedConversationNeedsSnapshot()
      || existing?.status === "syncing"
      || existing?.status === "unknown"
    ) return false;
    const commandId = crypto.randomUUID();
    if (!send({
      type: "rename_conversation",
      commandId,
      sessionId,
      conversationId,
      name,
    })) return false;
    updateConversationRenamePresentation(key, {
      commandId,
      sessionId,
      workspaceKey: workspaceKeyValue,
      projectId,
      conversationId,
      name,
      status: "syncing",
    });
    return true;
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
      || pendingConversationDeletionScopeRef.current.has(focus.conversationId)
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
      || pendingConversationDeletionScopeRef.current.has(focus.conversationId)
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
    if (
      pending.operation === "create_conversation"
      || pending.operation === "fork_conversation"
    ) {
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
    if (workspaceKey(workspaceSessionRepairRef.current?.cwd ?? "") === key) {
      invalidateWorkspaceSessionRepair(
        "工作区已关闭；旧检查/进入观察失效，请重新打开后手动检查。",
      );
    }
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
  const forkConversation = (conversationId: string): boolean => {
    const sessionId = sessionIdRef.current;
    const projectId = projectIdRef.current;
    const conversation = conversations.find(({ id }) => id === conversationId);
    if (
      !sessionId
      || !projectId
      || !conversation
      || workspaceSyncingRef.current
      || conversationSyncingRef.current
      || focusedConversationNeedsSnapshot()
      || (conversation.activity?.kind ?? "idle") !== "idle"
      || conversation.compacting
      || pendingFocusRef.current
      || pendingConversationDeletionRef.current
      || pendingConversationTruncationRef.current
      || pendingConversationRoleSwitchRef.current
    ) {
      return false;
    }
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
      type: "fork_conversation",
      commandId,
      sessionId,
      conversationId,
    }));
    if (!sent) {
      transitionTiming.fail(timingAttempt, "send-failed");
      return false;
    }
    transitionTiming.promote(timingAttempt);
    updateDirectoryBrowser(undefined);
    updatePendingFocus({
      commandId,
      operation: "fork_conversation",
      workspaceKey: currentWorkspaceKey(),
    });
    setError("");
    requestTransitionFrame(timingAttempt, "placeholder");
    replayTransitionEvents(events);
    return true;
  };
  const handleConversationFork = useLatestCallback(forkConversation);
  const updateDraftEditNotice = () => {
    const scope = draftScopeRef.current;
    const savedDraft = scope && conversationDraftByScopeRef.current.get(pendingConversationKey(scope));
    if (savedDraft?.submittedStatus === "unknown") {
      setPromptNotice(EDITED_UNCONFIRMED_PROMPT_NOTICE);
    } else if (promptNotice) {
      setPromptNotice("");
    }
  };
  const handleChatDraftChange = useLatestCallback((text: string) => {
    updateDraft(text);
    updateConversationDraft({ text, images: draftImagesRef.current });
    updateDraftEditNotice();
  });
  const handleChatImagesChange = useLatestCallback((images: PromptImage[]) => {
    updateDraftImages(images);
    updateConversationDraft({ text: draftRef.current, images });
    updateDraftEditNotice();
  });
  const handleChatSend = useLatestCallback((text: string, images: PromptImage[]) =>
    submitPrompt(text, images));
  const handleChatAbort = useLatestCallback(abortCurrentRun);
  const handleChatWithdrawPrompt = useLatestCallback(withdrawPrompt);
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
  const workspaceSetupCovered = Boolean(
    directoryBrowser || externalModalVisible
    || (workspaceSessionRepair && !workspaceSessionRepair.dismissed),
  );
  const blockingModalVisible = Boolean(
    externalModalVisible || setupOpen
    || (workspaceSessionRepair && !workspaceSessionRepair.dismissed),
  );
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

  const workspaceSessionRepairDialog = workspaceSessionRepair
    && !workspaceSessionRepair.dismissed
    && <WorkspaceSessionRepairDialog
    open
    cwd={workspaceSessionRepair.cwd}
    online={online}
    covered={externalModalVisible}
    report={workspaceSessionRepair.report}
    reportFresh={workspaceSessionRepair.reportFresh}
    backups={workspaceSessionRepair.backups}
    pending={workspaceSessionRepair.pending}
    phase={workspaceSessionRepair.phase}
    error={workspaceSessionRepair.error}
    repairError={workspaceSessionRepair.repairError}
    needsRecheck={workspaceSessionRepair.needsRecheck}
    onInspect={() => inspectWorkspaceSessionFiles(workspaceSessionRepair.dialogId)}
    onRepair={(files, allowDiscard) => repairWorkspaceSessionFiles(
      workspaceSessionRepair.dialogId,
      files,
      allowDiscard,
    )}
    onRetryRecovery={() => sendEmptyWorkspaceSessionRepair(
      workspaceSessionRepair.dialogId,
      "retry-recovery",
    )}
    onRevalidateAndEnter={() => sendEmptyWorkspaceSessionRepair(
      workspaceSessionRepair.dialogId,
      "enter",
    )}
    onClose={closeWorkspaceSessionRepair}
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
  const sidebarRenamePresentations = useMemo(() => new Map(
    [...conversationRenamePresentations.values()]
      .filter((presentation) => (
        presentation.workspaceKey === workspaceKey(activeCwd)
        && presentation.projectId === visibleProjectId
      ))
      .map((presentation) => [presentation.conversationId, {
        name: presentation.name,
        status: presentation.status,
      }]),
  ), [activeCwd, conversationRenamePresentations, visibleProjectId]);
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
  const pendingConversationDeletionScope = useMemo(() => {
    const scope = new Set<string>();
    if (!visiblePendingConversationDeletion) return scope;
    scope.add(visiblePendingConversationDeletion.conversationId);
    // Cascade membership is display-grade evidence: only a complete project
    // snapshot may widen the scope beyond the explicit delete target, and the
    // server still decides the authoritative cascade.
    if (conversationIndexTruncated) return scope;
    const target = visiblePendingConversationDeletion.conversationId;
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const conversation of conversations) {
        if (scope.has(conversation.id)) continue;
        const creator = conversation.createdBy;
        const belongsToTarget = conversation.rootConversationId === target
          || (
            creator?.kind === "conversation"
            && scope.has(creator.conversationId)
          );
        if (belongsToTarget) {
          scope.add(conversation.id);
          expanded = true;
        }
      }
    }
    return scope;
  }, [
    conversationIndexTruncated,
    conversations,
    visiblePendingConversationDeletion,
  ]);
  useEffect(() => {
    pendingConversationDeletionScopeRef.current =
      pendingConversationDeletionScope;
  }, [pendingConversationDeletionScope]);
  const focusedConversationIsDeleting = currentFocus !== undefined
    && pendingConversationDeletionScope.has(currentFocus.conversationId);
  // The deletion owns the workspace pane only when it removed the focused
  // conversation. Unrelated conversations keep their normal pane.
  const showConversationDeletionProgress =
    visiblePendingConversationDeletion !== undefined
    && (
      visiblePendingConversationDeletion.affectedFocus !== undefined
      || focusedConversationIsDeleting
    );
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
  const switchingFocus = pendingFocus?.operation === "focus_conversation"
    || pendingFocus?.operation === "create_conversation"
    || pendingFocus?.operation === "fork_conversation";
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
        initializationError={workspaceInitializationFailure
          && workspaceKey(workspaceInitializationFailure.cwd) === workspaceKey(activeCwd)
          ? workspaceInitializationFailure.message
          : undefined}
        repairUnknown={Boolean(
          workspaceSessionRepair?.dismissed
          && workspaceSessionRepair.needsRecheck
          && workspaceKey(workspaceSessionRepair.cwd) === workspaceKey(activeCwd)
        )}
        onReviewRepair={() => openWorkspaceSessionRepair(activeCwd)}
        onInspectSessions={() => openWorkspaceSessionRepair(activeCwd)}
        onClose={() => closeWorkspace(activeCwd)}
        onRetry={() => switchWorkspace(activeCwd)}
      />
    </div>
    {workspaceSetupDialog}
    {directoryBrowserDialog}
    {workspaceSessionRepairDialog}
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
  const visibleStopping = Boolean(
    pendingAbort
    && currentFocus
    && runtimeState
    && sameFocus(pendingAbort, currentFocus)
    && (runtimeState.activeRun?.id ?? outstandingRunId) === pendingAbort.runId,
  );
  const draftScopeMatchesCurrentFocus = Boolean(
    draftScope
    && currentFocus
    && draftScope.workspaceKey === currentWorkspaceKey()
    && draftScope.projectId === currentFocus.projectId
    && draftScope.conversationId === currentFocus.conversationId,
  );
  const draftScopeMatchesPendingFocus = Boolean(
    draftScope
    && pendingFocus
    && draftScope.workspaceKey === pendingFocus.workspaceKey
    && draftScope.projectId === pendingFocus.targetProjectId
    && draftScope.conversationId === pendingFocus.targetConversationId,
  );
  const draftEditable = !pendingConversationTruncation
    && (draftScopeMatchesCurrentFocus || draftScopeMatchesPendingFocus);
  const focusAwaitingSnapshot = Boolean(currentFocus) && !conversationReady;
  const settingsEnabled = Boolean(runtimeState)
    && !transitioning
    && !focusAwaitingSnapshot
    && !attachedRuntimeUnknown;
  const sessionControlsEnabled = online
    && sessionControlReady?.sessionId === sessionIdRef.current
    && sessionControlReady?.projectId === projectIdRef.current;
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
        renamePresentations={sidebarRenamePresentations}
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
        onFork={handleConversationFork}
        onBlockingModalChange={phoneViewport ? setSidebarBlockingModal : undefined}
      />
      <div
        className="workbench-main"
        hidden={phoneViewport && mobileScene !== "chat"}
      >
        {workspaceSessionRepair?.dismissed
          && workspaceSessionRepair.needsRecheck
          && workspaceKey(workspaceSessionRepair.cwd) === currentWorkspaceKey()
          && <div className="banner workspace-session-diagnostic" role="alert">
            <span>修复结果未知；不会自动重试或进入工作区。已确认的备份仍可查看。</span>
            <button type="button" onClick={() => openWorkspaceSessionRepair(workspaceSessionRepair.cwd)}>
              查看备份并重新检查
            </button>
          </div>}
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
          ? <main className="app-shell workspace-placeholder">
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
                <p>该会话正在删除；其他会话仍可继续使用。</p>
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
              draftEditable={draftEditable}
              draftScopeKey={draftScope ? pendingConversationKey(draftScope) : undefined}
              submitting={Boolean(pendingPrompt)}
              pendingAdmissions={pendingAdmissions}
              withdrawingPromptId={pendingPromptWithdrawal?.promptId}
              onWithdrawPrompt={handleChatWithdrawPrompt}
              promptNotice={promptNotice || undefined}
              onDraftChange={handleChatDraftChange}
              onImagesChange={handleChatImagesChange}
              onSend={handleChatSend}
              onAbort={handleChatAbort}
              stopping={visibleStopping}
              onSettings={handleChatSettings}
              onThinking={handleChatThinking}
              onServiceTier={handleChatServiceTier}
              onCompactionThreshold={handleChatCompactionThreshold}
              onCompact={handleChatCompact}
              onSwitchRole={handleChatSwitchRole}
              onChangeCwd={handleWorkspaceAdd}
              onOpenConversation={handleConversationSelect}
              onOpenImage={openImage}
              onOpenLocalImage={openLocalImage}
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
      online={sessionControlsEnabled}
      preferencesOnline={online}
      colorScheme={visibleColorScheme}
      colorSchemePending={Boolean(pendingColorScheme)}
      colorSchemeUnsaved={Boolean(unsavedColorScheme)}
      colorSchemeError={colorSchemeSaveError}
      customProviders={customProviders}
      customProvidersRefreshing={customProvidersRefreshing}
      customProvidersRefreshError={customProvidersRefreshError}
      customProviderMutationPending={customProviderMutationPending}
      customProviderMutationResult={customProviderMutationResult}
      customProviderProbePending={customProviderProbePending}
      customProviderProbeResult={customProviderProbeResult}
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
      onRefreshCustomProviders={refreshCustomProviders}
      onSaveCustomProvider={saveCustomProvider}
      onDeleteCustomProvider={deleteCustomProvider}
      onProbeCustomProviderModels={probeCustomProviderModels}
      onKey={(provider, key) => {
        const commandId = crypto.randomUUID();
        const sessionId = sessionIdRef.current;
        if (!sessionId || !sessionControlsEnabled) return undefined;
        setSettingResults((current) => ({ ...current, set_api_key: undefined }));
        pendingSettingCommandsRef.current.set_api_key = { sessionId, commandId };
        if (send({ type: "set_api_key", commandId, sessionId, provider, key })) {
          return commandId;
        }
        delete pendingSettingCommandsRef.current.set_api_key;
        return undefined;
      }}
      onOAuth={(provider) => {
        if (!sessionControlsEnabled) return;
        const authFlowId = crypto.randomUUID();
        authFlowIdRef.current = authFlowId;
        setAuth({ progress: "正在启动登录…" });
        if (!send({ type: "login_oauth", authFlowId, provider })) {
          authFlowIdRef.current = "";
          setAuth({});
        }
      }}
      onLogout={(provider) => (
        sessionControlsEnabled
          ? send({ type: "logout", provider })
          : false
      )}
      onRefresh={() => {
         const commandId = crypto.randomUUID();
         const sessionId = sessionIdRef.current;
         if (!sessionId || !sessionControlsEnabled) return undefined;
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
    {workspaceSessionRepairDialog}
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
