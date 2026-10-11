import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, ServerEvent, WorkspaceChangesSnapshot } from "../../shared/protocol";
import { useLatestCallback } from "./use-latest-callback";

const REFRESH_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
type RefreshCommand = Extract<ClientCommand, { type: "refresh_workspace_changes" }>;
interface PendingRead {
  command: RefreshCommand;
  scopeKey: string;
  timer?: ReturnType<typeof setTimeout>;
}
interface View {
  scopeKey?: string;
  snapshot?: WorkspaceChangesSnapshot;
  loading: boolean;
}

/** An ephemeral project observation, independent of transcript and conversation focus. */
export function useWorkspaceChanges({ sessionId, projectId, online, send }: {
  sessionId?: string;
  projectId?: string;
  online: boolean;
  send(command: RefreshCommand): boolean;
}) {
  const scopeKey = sessionId && projectId ? `${sessionId}:${projectId}` : undefined;
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const [view, setView] = useState<View>({ loading: false });
  const pendingRef = useRef<PendingRead | undefined>(undefined);

  const finish = useLatestCallback((pending: PendingRead, snapshot: WorkspaceChangesSnapshot) => {
    if (pendingRef.current !== pending) return;
    clearTimeout(pending.timer);
    pendingRef.current = undefined;
    if (pending.scopeKey !== scopeKey) return;
    setView({ scopeKey, snapshot, loading: false });
  });
  const refresh = useLatestCallback(() => {
    if (
      !visibleRef.current || document.visibilityState === "hidden"
      || !online || !scopeKey || !sessionId || !projectId || pendingRef.current
    ) return;
    const command: RefreshCommand = {
      type: "refresh_workspace_changes", sessionId, projectId, commandId: crypto.randomUUID(),
    };
    const pending: PendingRead = { command, scopeKey };
    // Register before dispatch: even a synchronous receipt must have an owner.
    pendingRef.current = pending;
    pending.timer = setTimeout(() => finish(pending, {
      state: "error", message: "读取工作区改动超时，请重试。",
    }), REQUEST_TIMEOUT_MS);
    setView((previous) => ({
      scopeKey, snapshot: previous.scopeKey === scopeKey ? previous.snapshot : undefined, loading: true,
    }));
    if (!send(command)) finish(pending, { state: "error", message: "连接未就绪，无法读取工作区改动。" });
  });
  const observe = useLatestCallback((event: ServerEvent) => {
    const pending = pendingRef.current;
    if (!pending || pending.scopeKey !== scopeKey) return;
    if (event.type === "workspace_changes") {
      if (
        event.sessionId === pending.command.sessionId
        && event.projectId === pending.command.projectId
        && event.commandId === pending.command.commandId
      ) finish(pending, event.snapshot);
    } else if (
      event.type === "error" && event.scope === "command"
      && event.operation === "refresh_workspace_changes"
      && event.sessionId === pending.command.sessionId
      && event.commandId === pending.command.commandId
    ) {
      finish(pending, { state: "error", message: event.message });
    }
  });
  const onVisibilityChange = useCallback((next: boolean) => {
    visibleRef.current = next;
    setVisible(next);
  }, []);

  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    return () => {
      clearTimeout(pendingRef.current?.timer);
      pendingRef.current = undefined;
    };
  }, [scopeKey, online]);
  useEffect(() => {
    if (!scopeKey || !online || !visible || !documentVisible) return;
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [scopeKey, online, visible, documentVisible, refresh]);

  const connected = Boolean(scopeKey && online);
  return {
    snapshot: connected
      ? (view.scopeKey === scopeKey ? view.snapshot : undefined)
      : { state: "error" as const, message: "工作区连接尚未就绪。" },
    loading: connected && view.scopeKey === scopeKey && view.loading,
    refresh,
    observe,
    onVisibilityChange,
  };
}
