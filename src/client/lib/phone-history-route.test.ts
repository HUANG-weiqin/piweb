// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  decodePhoneHistoryRoute,
  encodePhoneHistoryRoute,
  phoneHistoryRouteEquals,
  phoneHistoryRouteParent,
  pushPhoneHistoryRoute,
  replacePhoneHistoryRoute,
  type PhoneHistoryRoute,
} from "./phone-history-route";

afterEach(() => {
  history.replaceState(null, "");
});

describe("phone history route", () => {
  const workspaces: PhoneHistoryRoute = { screen: "workspaces" };
  const conversations: PhoneHistoryRoute = {
    screen: "conversations",
    cwd: "E:\\work",
  };
  const chat: PhoneHistoryRoute = {
    screen: "chat",
    cwd: "E:\\work",
    conversationId: "conversation-a",
  };

  it("accepts only the three durable route shapes", () => {
    expect(decodePhoneHistoryRoute(encodePhoneHistoryRoute(workspaces)))
      .toEqual(workspaces);
    expect(decodePhoneHistoryRoute(encodePhoneHistoryRoute(conversations)))
      .toEqual(conversations);
    expect(decodePhoneHistoryRoute(encodePhoneHistoryRoute(chat))).toEqual(chat);
    expect(decodePhoneHistoryRoute({ screen: "chat", cwd: "E:\\work" }))
      .toBeUndefined();
    expect(decodePhoneHistoryRoute({ screen: "conversations", cwd: " " }))
      .toBeUndefined();
    expect(decodePhoneHistoryRoute({ screen: "controls", cwd: "E:\\work" }))
      .toBeUndefined();
    expect(decodePhoneHistoryRoute({ screen: "workspaces", drawer: true }))
      .toBeUndefined();
    expect(decodePhoneHistoryRoute({
      screen: "chat",
      cwd: "E:\\work",
      conversationId: "conversation-a",
      piwebPhoneRoute: true,
    })).toBeUndefined();
  });

  it("compares durable intent and derives only durable parents", () => {
    expect(phoneHistoryRouteEquals(conversations, { ...conversations })).toBe(true);
    expect(phoneHistoryRouteEquals(chat, conversations)).toBe(false);
    expect(phoneHistoryRouteParent(workspaces)).toBeUndefined();
    expect(phoneHistoryRouteParent(conversations)).toEqual(workspaces);
    expect(phoneHistoryRouteParent(chat)).toEqual(conversations);
  });

  it("writes state without changing the URL", () => {
    const url = window.location.href;

    replacePhoneHistoryRoute(conversations);
    expect(history.state).toEqual({ screen: "conversations", cwd: "E:\\work" });
    expect(window.location.href).toBe(url);

    pushPhoneHistoryRoute(chat);
    expect(history.state).toEqual({
      screen: "chat",
      cwd: "E:\\work",
      conversationId: "conversation-a",
    });
    expect(window.location.href).toBe(url);
  });
});
