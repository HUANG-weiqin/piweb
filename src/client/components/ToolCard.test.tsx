// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolItem } from "../chat/reducer";
import { ToolCard } from "./ToolCard";

const tool: ToolItem = {
  id: "1",
  name: "read",
  args: { path: "src/index.ts" },
  result: { ok: true },
  status: "done",
};

afterEach(() => {
  cleanup();
});

describe("ToolCard", () => {
  it("is compact by default and shows dashed summary", () => {
    const { container } = render(<ToolCard tool={tool} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = container.querySelector("summary") as HTMLElement;

    expect(details?.open).toBe(false);
    expect(summary).toBeTruthy();
    expect(summary).toHaveTextContent("read");
    expect(summary.querySelector(".tool-title")?.textContent).toMatch(/-+ read -+/);
  });

  it("expands to reveal details when user clicks the summary", () => {
    const { container } = render(<ToolCard tool={tool} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = container.querySelector("summary") as HTMLElement;

    fireEvent.click(summary);

    expect(details.open).toBe(true);
    expect(screen.getByText(/\"path\"/)).toBeInTheDocument();
    expect(screen.getByText(/\"ok\": true/)).toBeInTheDocument();
  });
});
