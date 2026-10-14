import { describe, expect, it } from "vitest";
import { localFilePath, MAX_LOCAL_FILE_PATH_CHARACTERS } from "./local-file-path.js";

describe("localFilePath", () => {
  it.each([
    ["E:/godot/god/验收报告.md", "E:/godot/god/验收报告.md"],
    ["E:\\归档\\my file.zip", "E:\\归档\\my file.zip"],
    ["/tmp/报告.markdown", "/tmp/报告.markdown"],
    ["./output/a.txt", "./output/a.txt"],
    ["../output/archive.zip", "../output/archive.zip"],
    ["output/no-extension", "output/no-extension"],
    ["file:///E:/my%20report.md", "E:/my report.md"],
    ["file://localhost/tmp/a%23b.zip", "/tmp/a#b.zip"],
    ["a.svg", "a.svg"],
    ["a.html", "a.html"],
    ["a".repeat(MAX_LOCAL_FILE_PATH_CHARACTERS), "a".repeat(MAX_LOCAL_FILE_PATH_CHARACTERS)],
  ])("accepts local path %s", (input, expected) => {
    expect(localFilePath(input)).toBe(expected);
  });

  it.each([
    "", "file://server/share/a.md", "\\\\server\\share\\a.zip", "//server/share/a.md",
    "\\\\?\\C:\\a.md", "\\\\.\\pipe\\a", "file:////server/share/a.md",
    "C:a.md", "C:\\a.txt:stream", "a:stream", "file:///C:/a.txt%3Astream",
    "https://example.com/a.md", "data:text/plain;base64,abcd", "javascript:alert(1)",
    "file:///a.md?query=1", "file:///a.md#hash", "file:///a%00.md", "file:///a%ZZ.md",
    "a\u0000.md", "a\n.md", "a\u007f.md", "a.md\n", "\ta.md",
    "a".repeat(MAX_LOCAL_FILE_PATH_CHARACTERS + 1),
  ])("rejects unsafe path %j", (input) => {
    expect(localFilePath(input)).toBeUndefined();
  });
});
