import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOCAL_FILE_BYTES } from "../shared/protocol.js";
import { readLocalFile } from "./local-file.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

let cwd: string;
beforeEach(async () => { cwd = await fs.mkdtemp(join(tmpdir(), "piweb-local-file-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("readLocalFile", () => {
  it("reads the clicked Markdown report and ZIP bytes, with relative, absolute and local file URLs", async () => {
    for (const [fileName, mimeType, bytes] of [
      ["验收报告.md", "text/plain", Buffer.from("# 验收报告\n通过\n")],
      ["my archive.zip", "application/octet-stream", Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff])],
    ] as const) {
      const file = join(cwd, fileName);
      await fs.writeFile(file, bytes);
      for (const path of [fileName, file, pathToFileURL(file).href]) {
        expect(await readLocalFile(cwd, path)).toEqual({ fileName, mimeType, data: bytes.toString("base64") });
      }
      await fs.writeFile(file, "current disk bytes");
      expect((await readLocalFile(cwd, fileName)).data).toBe(Buffer.from("current disk bytes").toString("base64"));
    }
  });

  it("allows explicit absolute paths outside the workspace", async () => {
    await fs.mkdir(join(cwd, "workspace"));
    const file = join(cwd, "outside.txt");
    await fs.writeFile(file, "outside");
    expect(await readLocalFile(join(cwd, "workspace"), file)).toMatchObject({ fileName: "outside.txt", mimeType: "text/plain" });
  });

  it.each(["md", "markdown", "txt", "log", "json", "csv", "yaml", "yml", "MD"])(
    "only classifies supported text extension .%s as text/plain", async (extension) => {
      await fs.writeFile(join(cwd, `a.${extension}`), "<script>not rendered</script>");
      expect(await readLocalFile(cwd, `a.${extension}`)).toMatchObject({ mimeType: "text/plain" });
    },
  );

  it.each(["a.html", "a.svg", "a.png", "a.js", "no-extension"])(
    "returns %s as an inert binary download", async (fileName) => {
      await fs.writeFile(join(cwd, fileName), "<script>not rendered</script>");
      expect(await readLocalFile(cwd, fileName)).toMatchObject({ mimeType: "application/octet-stream" });
    },
  );

  it("allows empty files and exactly 16 MiB, but rejects oversize, missing and non-regular paths", async () => {
    await fs.writeFile(join(cwd, "empty.txt"), "");
    expect(await readLocalFile(cwd, "empty.txt")).toEqual({ fileName: "empty.txt", mimeType: "text/plain", data: "" });
    const handle = await fs.open(join(cwd, "large.zip"), "w");
    try {
      await handle.truncate(MAX_LOCAL_FILE_BYTES);
      expect(Buffer.from((await readLocalFile(cwd, "large.zip")).data, "base64")).toHaveLength(MAX_LOCAL_FILE_BYTES);
      await handle.truncate(MAX_LOCAL_FILE_BYTES + 1);
      await expect(readLocalFile(cwd, "large.zip")).rejects.toThrow("16 MiB");
    } finally {
      await handle.close();
    }
    await expect(readLocalFile(cwd, "missing.md")).rejects.toThrow(/ENOENT/);
    await fs.mkdir(join(cwd, "directory.md"));
    await expect(readLocalFile(cwd, "directory.md")).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without blocking", async () => {
    const fifo = join(cwd, "fifo.txt");
    execFileSync("mkfifo", [fifo]);
    await expect(readLocalFile(cwd, "fifo.txt")).rejects.toThrow("普通文件");
  }, 2_000);

  it.each(["file://server/share/a.md", "\\\\server\\share\\a.zip", "C:\\a.txt:stream", "C:a.md", "https://example.com/a.md"])(
    "rejects unsafe paths before accessing the filesystem: %s", async (path) => {
      await expect(readLocalFile(cwd, path)).rejects.toThrow("本地文件路径");
    },
  );

  it("rejects a local symlink resolved onto a network share", async () => {
    vi.spyOn(fs, "realpath").mockResolvedValue("\\\\server\\share\\report.md");
    await expect(readLocalFile(cwd, "local-link.md")).rejects.toThrow("网络");
  });

  it.each(["short", "same-size", "growing"])("rejects a %s file change during reading", async (change) => {
    const file = join(cwd, "changing.txt");
    await fs.writeFile(file, "original");
    const handle = await fs.open(file, "r");
    const stat = handle.stat.bind(handle);
    let reads = 0;
    vi.spyOn(handle, "stat").mockImplementation(async () => {
      const result = await stat({ bigint: true });
      if (reads++ === 0) {
        await fs.writeFile(file, change === "short" ? "" : change === "same-size" ? "replaced" : "grown beyond original");
        await fs.utimes(file, new Date(0), new Date(0));
      }
      return result;
    });
    vi.spyOn(fs, "open").mockResolvedValue(handle);
    await expect(readLocalFile(cwd, "changing.txt")).rejects.toThrow("发生变化");
  });
});
