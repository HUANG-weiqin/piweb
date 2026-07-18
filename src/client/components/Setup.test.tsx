// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Setup } from "./Setup";

afterEach(cleanup);

describe("Setup", () => {
  it("offers a folder picker without submitting the project", () => {
    const start = vi.fn();
    const pickDirectory = vi.fn();
    render(<Setup
      cwd={"E:\\work"}
      online
      pickingDirectory={false}
      onCwdChange={() => undefined}
      onPickDirectory={pickDirectory}
      onStart={start}
    />);

    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));

    expect(pickDirectory).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts with the entered working directory", () => {
    const start = vi.fn();
    render(<Setup
      cwd={"E:\\work"}
      online
      pickingDirectory={false}
      onCwdChange={() => undefined}
      onPickDirectory={() => undefined}
      onStart={start}
    />);
    fireEvent.click(screen.getByRole("button", { name: "进入项目" }));
    expect(start).toHaveBeenCalledWith("E:\\work");
  });

  it("reflects a directory selected by the parent", () => {
    const props = {
      online: true,
      pickingDirectory: false,
      onCwdChange: () => undefined,
      onPickDirectory: () => undefined,
      onStart: () => undefined,
    };
    const view = render(<Setup cwd="" {...props} />);
    view.rerender(<Setup cwd={"E:\\work"} {...props} />);
    expect(screen.getByRole("textbox", { name: "项目目录" })).toHaveValue("E:\\work");
  });

  it("reports manual path edits to the parent", () => {
    const changeCwd = vi.fn();
    render(<Setup
      cwd=""
      online
      pickingDirectory={false}
      onCwdChange={changeCwd}
      onPickDirectory={() => undefined}
      onStart={() => undefined}
    />);

    fireEvent.change(
      screen.getByRole("textbox", { name: "项目目录" }),
      { target: { value: "E:\\typed" } },
    );

    expect(changeCwd).toHaveBeenCalledWith("E:\\typed");
  });

  it("disables start while offline", () => {
    render(<Setup
      cwd={"E:\\work"}
      online={false}
      pickingDirectory={false}
      onCwdChange={() => undefined}
      onPickDirectory={() => undefined}
      onStart={() => undefined}
    />);
    expect(screen.getByRole("button", { name: "选择文件夹" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在连接本地服务…" })).toBeDisabled();
  });

  it("blocks duplicate selection and project entry while the picker is open", () => {
    render(<Setup
      cwd={"E:\\work"}
      online
      pickingDirectory
      onCwdChange={() => undefined}
      onPickDirectory={() => undefined}
      onStart={() => undefined}
    />);

    expect(screen.getByRole("button", { name: "正在选择…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "进入项目" })).toBeDisabled();
  });

  it("shows a fatal connection label when provided", () => {
    render(<Setup
      cwd={"E:\\work"}
      online={false}
      pickingDirectory={false}
      unavailableLabel="协议不兼容"
      onCwdChange={() => undefined}
      onPickDirectory={() => undefined}
      onStart={() => undefined}
    />);
    expect(screen.getByRole("button", { name: "协议不兼容" })).toBeDisabled();
  });
});
