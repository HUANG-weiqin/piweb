// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function BrokenChild(): ReactElement {
  throw new Error("render failed");
}

describe("ErrorBoundary", () => {
  it("shows a visible fallback instead of a blank page", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<ErrorBoundary><BrokenChild /></ErrorBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("页面出错了");
    expect(screen.getByRole("alert")).toHaveTextContent("render failed");
  });
});
