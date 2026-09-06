export type PhoneHistoryRoute =
  | { screen: "workspaces" }
  | { screen: "conversations"; cwd: string }
  | { screen: "chat"; cwd: string; conversationId: string };

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function encodePhoneHistoryRoute(route: PhoneHistoryRoute): PhoneHistoryRoute {
  if (route.screen === "workspaces") return { screen: "workspaces" };
  if (route.screen === "conversations") {
    return { screen: "conversations", cwd: route.cwd };
  }
  return {
    screen: "chat",
    cwd: route.cwd,
    conversationId: route.conversationId,
  };
}

export function decodePhoneHistoryRoute(value: unknown): PhoneHistoryRoute | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<PhoneHistoryRoute>;
  if (state.screen === "workspaces" && Object.keys(state).length === 1) {
    return { screen: "workspaces" };
  }
  if (
    state.screen === "conversations"
    && nonBlankString(state.cwd)
    && Object.keys(state).length === 2
  ) {
    return { screen: "conversations", cwd: state.cwd };
  }
  if (
    state.screen === "chat"
    && nonBlankString(state.cwd)
    && nonBlankString(state.conversationId)
    && Object.keys(state).length === 3
  ) {
    return {
      screen: "chat",
      cwd: state.cwd,
      conversationId: state.conversationId,
    };
  }
  return undefined;
}

export function phoneHistoryRouteEquals(
  left: PhoneHistoryRoute | undefined,
  right: PhoneHistoryRoute | undefined,
): boolean {
  if (!left || !right || left.screen !== right.screen) return false;
  if (left.screen === "workspaces") return true;
  if (right.screen === "workspaces" || left.cwd !== right.cwd) return false;
  return left.screen !== "chat"
    || (right.screen === "chat" && left.conversationId === right.conversationId);
}

export function phoneHistoryRouteParent(
  route: PhoneHistoryRoute,
): PhoneHistoryRoute | undefined {
  if (route.screen === "workspaces") return undefined;
  if (route.screen === "conversations") return { screen: "workspaces" };
  return { screen: "conversations", cwd: route.cwd };
}

export function readPhoneHistoryRoute(): PhoneHistoryRoute | undefined {
  return decodePhoneHistoryRoute(window.history.state);
}

export function pushPhoneHistoryRoute(route: PhoneHistoryRoute): void {
  window.history.pushState(encodePhoneHistoryRoute(route), "");
}

export function replacePhoneHistoryRoute(route: PhoneHistoryRoute): void {
  window.history.replaceState(encodePhoneHistoryRoute(route), "");
}
