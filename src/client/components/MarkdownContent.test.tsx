// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

describe("local image paths", () => {
  it("opens local links, image syntax, inline code and bare paths only on click", () => {
    const onOpenLocalImage = vi.fn();
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
      onOpenLocalImage={onOpenLocalImage}
    />);
    expect(onOpenLocalImage).not.toHaveBeenCalled();
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
      expect(onOpenLocalImage).toHaveBeenLastCalledWith(paths[index]);
    });
  });

  it("escapes path attributes and labels without enabling embedded HTML handlers", () => {
    const onOpenLocalImage = vi.fn();
    const path = '/tmp/a" onclick="alert(1).png';
    const { container } = render(<MarkdownContent className="markdown"
      markdown={"`" + path + "`"} onOpenLocalImage={onOpenLocalImage} />);
    const button = screen.getByRole("button");
    expect(button).not.toHaveAttribute("onclick");
    expect(container.querySelector("script")).toBeNull();
    fireEvent.click(button.querySelector("code")!);
    expect(onOpenLocalImage).toHaveBeenCalledWith(path);
  });

  it("leaves non-images, unsafe schemes, remote file URLs and fenced code inert", () => {
    const onOpenLocalImage = vi.fn();
    const { container } = render(<MarkdownContent
      className="markdown"
      markdown={[
        "[文件](file:///E:/secret.txt)",
        "[脚本](javascript:alert(1))",
        "[网络共享](file://server/share/a.png)",
        "`E:\\secret.txt`",
        "```text\nE:\\screenshots\\code.png\n```",
        "[网络图片](https://example.com/a.png)",
        "https://example.com/b.png",
        String.raw`\\server\share\a.png`,
        "`/tmp/a.svg`",
        "[本机网页](file:///E:/a.html)",
      ].join("\n\n")}
      onOpenLocalImage={onOpenLocalImage}
    />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[href^="file:"]')).toBeNull();
    expect(screen.getByRole("link", { name: "网络图片" })).toHaveAttribute(
      "href", "https://example.com/a.png",
    );
    expect(onOpenLocalImage).not.toHaveBeenCalled();
  });
});
