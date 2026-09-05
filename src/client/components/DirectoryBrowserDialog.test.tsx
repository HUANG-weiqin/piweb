// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryBrowserDialog } from "./DirectoryBrowserDialog";

afterEach(cleanup);

describe("DirectoryBrowserDialog", () => {
  it("dismisses only the directory child from its exact backdrop", () => {
    const close = vi.fn();
    const navigate = vi.fn();
    const openStartup = vi.fn();
    const select = vi.fn();

    function Fixture() {
      const [open, setOpen] = useState(true);
      return <>
        <div data-testid="setup-owner">Setup remains mounted</div>
        {open && <DirectoryBrowserDialog
          online
          loading={false}
          listing={{
            path: "E:\\work",
            parentPath: "E:\\",
            directories: [],
            truncated: false,
          }}
          onNavigate={navigate}
          onOpenStartup={openStartup}
          onSelect={select}
          onClose={() => {
            close();
            setOpen(false);
          }}
        />}
      </>;
    }

    render(<Fixture />);
    const dialog = screen.getByRole("dialog", { name: "选择项目目录" });
    const backdrop = dialog.parentElement!;
    const interiorMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(dialog, interiorMouseDown);

    expect(interiorMouseDown.defaultPrevented).toBe(false);
    expect(dialog).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();

    const backdropMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(backdrop, backdropMouseDown);

    expect(backdropMouseDown.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog", { name: "选择项目目录" }))
      .not.toBeInTheDocument();
    expect(screen.getByTestId("setup-owner")).toBeInTheDocument();
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(openStartup).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("navigates through directories and selects the current folder", () => {
    const navigate = vi.fn();
    const select = vi.fn();
    render(<DirectoryBrowserDialog
      online
      loading={false}
      listing={{
        path: "E:\\work",
        parentPath: "E:\\",
        directories: [{ name: "child", path: "E:\\work\\child" }],
        truncated: false,
      }}
      onNavigate={navigate}
      onOpenStartup={() => undefined}
      onSelect={select}
      onClose={() => undefined}
    />);

    fireEvent.click(screen.getByRole("button", { name: "打开文件夹 child" }));
    expect(navigate).toHaveBeenCalledWith("E:\\work\\child");
    fireEvent.click(screen.getByRole("button", { name: "选择当前文件夹" }));
    expect(select).toHaveBeenCalledWith("E:\\work");
  });

  it("keeps cancellation available while a listing is loading", () => {
    const close = vi.fn();
    render(<DirectoryBrowserDialog
      online
      loading
      onNavigate={() => undefined}
      onOpenStartup={() => undefined}
      onSelect={() => undefined}
      onClose={close}
    />);

    expect(screen.getByRole("status")).toHaveTextContent("正在读取目录");
    expect(screen.getByRole("button", { name: "选择当前文件夹" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(close).toHaveBeenCalledOnce();
  });
});
