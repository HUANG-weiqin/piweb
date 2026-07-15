// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicState } from "../../shared/protocol";
import { ConnectionDrawer } from "./ConnectionDrawer";

afterEach(cleanup);

const state: PublicState = {
  cwd: "E:\\work",
  busy: false,
  thinkingLevel: "off",
  availableThinkingLevels: ["off", "low"],
  providers: [{
    id: "test",
    name: "Test",
    configured: true,
    oauth: false,
    models: [
      { provider: "test", id: "ready", name: "Ready", reasoning: false, input: ["text"], contextWindow: 100, available: true },
      { provider: "test", id: "locked", name: "Locked", reasoning: false, input: ["text"], contextWindow: 100, available: false },
    ],
  }],
};

describe("ConnectionDrawer", () => {
  it("shows only models Pi reports as available", () => {
    render(<ConnectionDrawer state={state} open onClose={() => undefined} onKey={() => undefined} onOAuth={() => undefined} onLogout={() => undefined} onModel={() => undefined} onThinking={() => undefined} />);
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.queryByText("locked")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "low" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "high" })).not.toBeInTheDocument();
  });

  it("does not crash if the browser briefly receives state from an older server", () => {
    const legacyState = { ...state, availableThinkingLevels: undefined } as unknown as PublicState;
    expect(() => render(<ConnectionDrawer state={legacyState} open onClose={() => undefined} onKey={() => undefined} onOAuth={() => undefined} onLogout={() => undefined} onModel={() => undefined} onThinking={() => undefined} />)).not.toThrow();
  });
});
