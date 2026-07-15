// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat/reducer";
import { Message } from "./Message";

afterEach(() => {
  cleanup();
});

describe("Message", () => {
  const toolsMessage: ChatMessage = {
    id: "1",
    role: "assistant",
    text: "",
    thinking: "",
    tools: [
      {
        id: "1",
        name: "read",
        args: { path: "src/index.ts" },
        result: { ok: true },
        status: "done",
      },
    ],
  };

  it("keeps tool details collapsed by default", () => {
    const { container } = render(<Message message={toolsMessage} />);
    const details = container.querySelector("details.tools") as HTMLDetailsElement;

    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
  });

  it("expands tool details when user clicks the tools summary", () => {
    render(<Message message={toolsMessage} />);

    const summary = screen.getByText("工具调用（1）") as HTMLElement;
    fireEvent.click(summary);
    const details = screen.getByText("工具调用（1）").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByText(/\"path\"/)).toBeInTheDocument();
    expect(screen.getByText(/\"ok\": true/)).toBeInTheDocument();
  });
});
