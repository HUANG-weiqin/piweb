// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

describe("local file paths", () => {
  it("makes the reported Markdown and ZIP links actionable only on click", () => {
    const onOpenLocalFile = vi.fn();
    const report = "E:/godot/godbrave-small-numbers/sim/DuelSim/configs/small-numbers-v2.md";
    const evidence = "E:/godot/godbrave-small-numbers/sim/DuelSim/configs/small-numbers-v2-evidence.zip";
    const { container } = render(<MarkdownContent className="markdown"
      markdown={`[验收报告](${report})｜[原始证据](${evidence})`}
      onOpenLocalFile={onOpenLocalFile} />);
    expect(onOpenLocalFile).not.toHaveBeenCalled();
    expect(container.querySelector("a, img, iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "验收报告 ↗" }));
    expect(onOpenLocalFile).toHaveBeenLastCalledWith(report);
    fireEvent.click(screen.getByRole("button", { name: "原始证据 ↗" }));
    expect(onOpenLocalFile).toHaveBeenLastCalledWith(evidence);
  });

  it.each([
    [String.raw`[报告](E:\reports\.artifacts\_report.md)`, String.raw`E:\reports\.artifacts\_report.md`],
    [String.raw`[报告](<.\reports\_验收 报告.md> "标题")`, String.raw`.\reports\_验收 报告.md`],
    ["[报告](file:///E:/reports/my%20report.md)", "E:/reports/my report.md"],
    ["[证据](./output/my%20evidence.zip)", "./output/my evidence.zip"],
    ["[证据](output/evidence.zip)", "output/evidence.zip"],
    ["[报告](/tmp/report.md)", "/tmp/report.md"],
    ["[网页源文件](file:///E:/a.html)", "E:/a.html"],
  ])("preserves local file destinations in %s", (markdown, path) => {
    const onOpenLocalFile = vi.fn();
    render(<MarkdownContent className="markdown" markdown={markdown} onOpenLocalFile={onOpenLocalFile} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpenLocalFile).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("opens local links, image syntax, inline code and bare paths only on click", () => {
    const onOpenLocalFile = vi.fn();
    const { container } = render(<MarkdownContent
      className="markdown"
      markdown={[
        "[查看成图](file:///E:/screenshots/my%20image.png)",
        "![相对图片](./output/result.webp)",
        "`E:\\screenshots\\中文 图.jpg`",
        "图片在 E:\\screenshots\\plain.png。",
        "图片在 /tmp/output.gif",
        "[相对链接](output/result.png)",
        "[带空格链接](./my%20image.png)",
        String.raw`[Windows 链接](E:\images\link.png)`,
        "图片 `/tmp/a&b.png`",
        "[绝对路径链接](/tmp/result.jpg)",
      ].join("\n\n")}
      onOpenLocalFile={onOpenLocalFile}
    />);
    expect(onOpenLocalFile).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[href^="file:"]')).toBeNull();
    const paths = [
      "E:/screenshots/my image.png", "./output/result.webp",
      "E:\\screenshots\\中文 图.jpg", "E:\\screenshots\\plain.png",
      "/tmp/output.gif", "output/result.png", "./my image.png",
      String.raw`E:\images\link.png`, "/tmp/a&b.png", "/tmp/result.jpg",
    ];
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(paths.length);
    buttons.forEach((button, index) => {
      fireEvent.click(button);
      expect(onOpenLocalFile).toHaveBeenLastCalledWith(paths[index]);
    });
  });

  it.each([
    [String.raw`[查看图片](E:\shots\.artifacts\_result.png)`, String.raw`E:\shots\.artifacts\_result.png`],
    [String.raw`![查看图片](<E:\shots\.artifacts\_result 01.png> "标题")`, String.raw`E:\shots\.artifacts\_result 01.png`],
    [String.raw`[查看图片](.\shots\_result.png)`, String.raw`.\shots\_result.png`],
    [String.raw`[查看图片](E:\shots\folder(1)\_result.png "标题")`, String.raw`E:\shots\folder(1)\_result.png`],
    [String.raw`[查看图片][preview]` + "\n\n" + String.raw`[preview]: <E:\shots\.artifacts\_result.png> "标题"`, String.raw`E:\shots\.artifacts\_result.png`],
    [String.raw`[查看图片](./shots/result\(1\).png "标题")`, "./shots/result(1).png"],
    [String.raw`[查看图片](E:/shots/result\(1\).png "标题")`, "E:/shots/result(1).png"],
  ])("preserves local path separators in %s", (markdown, path) => {
    const onOpenLocalFile = vi.fn();
    render(<MarkdownContent className="markdown" markdown={markdown} onOpenLocalFile={onOpenLocalFile} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpenLocalFile).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("escapes path attributes and labels without enabling embedded HTML handlers", () => {
    const onOpenLocalFile = vi.fn();
    const path = '/tmp/a" onclick="alert(1).png';
    const { container } = render(<MarkdownContent className="markdown"
      markdown={"`" + path + "`"} onOpenLocalFile={onOpenLocalFile} />);
    const button = screen.getByRole("button");
    expect(button).not.toHaveAttribute("onclick");
    expect(container.querySelector("script")).toBeNull();
    fireEvent.click(button.querySelector("code")!);
    expect(onOpenLocalFile).toHaveBeenCalledWith(path);
  });

  it("leaves unsafe paths, non-image code paths and fenced code inert without hijacking web links or anchors", () => {
    const onOpenLocalFile = vi.fn();
    const { container } = render(<MarkdownContent
      className="markdown"
      markdown={[
        "[锚点](#section)",
        "[脚本](javascript:alert(1))",
        "[网络共享](file://server/share/a.png)",
        String.raw`[UNC 路径](\\server\share\a.png)`,
        String.raw`![UNC 图片](\\server\share\a.png)`,
        String.raw`![设备路径](\\?\E:\shots\a.png)`,
        String.raw`[设备文件](\\?\E:\notes.txt)`,
        String.raw`[共享文件](\\server\share\notes.txt)`,
        "[共享 URL](file://server/share/notes.txt)",
        "[ADS](E:/notes.txt:stream)",
        String.raw`[HTTP 链接](https://example.com/\_image.png)`,
        String.raw`[非本机文件 URL](file://server/share/\_image.png)`,
        "`E:\\secret.txt`",
        "```text\nE:\\screenshots\\code.png\n```",
        "[网络图片](https://example.com/a.png)",
        "https://example.com/b.png",
        String.raw`\\server\share\a.png`,
        "`/tmp/a.svg`",
      ].join("\n\n")}
      onOpenLocalFile={onOpenLocalFile}
    />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link", { name: "UNC 路径" })).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[href^="file:"]')).toBeNull();
    expect(screen.getByRole("link", { name: "网络图片" })).toHaveAttribute(
      "href", "https://example.com/a.png",
    );
    expect(screen.getByRole("link", { name: "HTTP 链接" })).toHaveAttribute(
      "href", "https://example.com/_image.png",
    );
    expect(screen.getByRole("link", { name: "锚点" })).toHaveAttribute("href", "#section");
    expect(onOpenLocalFile).not.toHaveBeenCalled();
  });
});
