// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Setup } from "./Setup";

afterEach(cleanup);

describe("Setup", () => {
  it("starts with the entered working directory", () => {
    const start = vi.fn();
    render(<Setup initialCwd={"E:\\work"} online onStart={start} />);
    fireEvent.click(screen.getByRole("button", { name: "进入项目" }));
    expect(start).toHaveBeenCalledWith("E:\\work");
  });

  it("updates the field when the server provides its startup directory", () => {
    const view = render(<Setup initialCwd="" online onStart={() => undefined} />);
    view.rerender(<Setup initialCwd={"E:\\work"} online onStart={() => undefined} />);
    expect(screen.getByRole("textbox", { name: "项目目录" })).toHaveValue("E:\\work");
  });

  it("disables start while offline", () => {
    render(<Setup initialCwd={"E:\\work"} online={false} onStart={() => undefined} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("shows a fatal connection label when provided", () => {
    render(<Setup
      initialCwd={"E:\\work"}
      online={false}
      unavailableLabel="协议不兼容"
      onStart={() => undefined}
    />);
    expect(screen.getByRole("button", { name: "协议不兼容" })).toBeDisabled();
  });
});
