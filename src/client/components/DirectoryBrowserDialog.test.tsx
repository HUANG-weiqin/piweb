// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryBrowserDialog } from "./DirectoryBrowserDialog";

afterEach(cleanup);

describe("DirectoryBrowserDialog", () => {
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
