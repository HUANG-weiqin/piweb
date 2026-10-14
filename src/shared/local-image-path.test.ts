import { describe, expect, it } from "vitest";
import { localImagePath, MAX_LOCAL_IMAGE_PATH_CHARACTERS } from "./local-image-path.js";

describe("localImagePath", () => {
  it.each([
    ["E:\\图片\\my image.PNG", "E:\\图片\\my image.PNG"],
    ["/tmp/图片.png", "/tmp/图片.png"],
    ["./output/a.webp", "./output/a.webp"],
    ["../output/a.jpeg", "../output/a.jpeg"],
    ["output/a.gif", "output/a.gif"],
    ["file:///E:/my%20image.png", "E:/my image.png"],
    ["file://localhost/tmp/a%23b.png", "/tmp/a#b.png"],
    [`file:///tmp/${encodeURIComponent("中".repeat(500))}.png`, `/tmp/${"中".repeat(500)}.png`],
  ])("accepts %s", (input, expected) => {
    expect(localImagePath(input)).toBe(expected);
  });

  it.each([
    "", "file://server/share/a.png", "\\\\server\\share\\a.png",
    "\\\\?\\C:\\a.png", "C:a.png", "C:\\a.txt:stream.png",
    "https://example.com/a.png", "data:image/png;base64,abcd",
    "javascript:alert(1).png", "file:///a.png?query=1", "file:///a.png#hash",
    "file:///a%00.png", "file:///a%ZZ.png", "a.svg", "a.html", "a.txt",
    "a\u0000.png", "a\n.png", "a.png\n", "\ta.png",
    "a".repeat(MAX_LOCAL_IMAGE_PATH_CHARACTERS) + ".png",
  ])("rejects unsafe or unsupported path %s", (input) => {
    expect(localImagePath(input)).toBeUndefined();
  });
});
