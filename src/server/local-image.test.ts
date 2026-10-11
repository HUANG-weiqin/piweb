import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CONVERSATION_IMAGE_BYTES } from "../shared/protocol.js";
import { readLocalImage } from "./local-image.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3xQAAAAASUVORK5CYII=", "base64");
let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "piweb-local-image-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("readLocalImage", () => {
  it("reads exact bytes for relative, absolute and file-URL paths, including spaces and Unicode", async () => {
    const file = join(cwd, "中文 image.png");
    await writeFile(file, PNG);
    for (const path of ["中文 image.png", file, pathToFileURL(file).href]) {
      expect(await readLocalImage(cwd, path)).toEqual({ mimeType: "image/png", data: PNG.toString("base64") });
    }
    // The preview reflects current disk content, not a durable history image.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await writeFile(file, jpeg);
    expect(await readLocalImage(cwd, file)).toEqual({ mimeType: "image/jpeg", data: jpeg.toString("base64") });
  });

  it("allows an explicitly clicked absolute image outside the workspace", async () => {
    await mkdir(join(cwd, "workspace"));
    const file = join(cwd, "outside.png");
    await writeFile(file, PNG);
    expect(await readLocalImage(join(cwd, "workspace"), file)).toMatchObject({ mimeType: "image/png" });
  });

  it("recognizes each supported raster signature, not the extension alone", async () => {
    for (const [mimeType, bytes] of [
      ["image/gif", Buffer.from("GIF89a")],
      ["image/webp", Buffer.from("RIFF1234WEBP")],
    ] as const) {
      await writeFile(join(cwd, "a.png"), bytes);
      expect(await readLocalImage(cwd, "a.png")).toMatchObject({ mimeType });
    }
    await writeFile(join(cwd, "a.png"), "<html>not an image</html>");
    await expect(readLocalImage(cwd, "a.png")).rejects.toThrow("文件内容不是受支持的图片");
  });

  it("rejects missing files, directories, empty and oversized files", async () => {
    await expect(readLocalImage(cwd, "missing.png")).rejects.toThrow(/ENOENT/);
    await mkdir(join(cwd, "dir.png"));
    await expect(readLocalImage(cwd, "dir.png")).rejects.toThrow();
    await writeFile(join(cwd, "empty.png"), "");
    await expect(readLocalImage(cwd, "empty.png")).rejects.toThrow("16 MiB");
    const file = await open(join(cwd, "large.png"), "w");
    await file.truncate(MAX_CONVERSATION_IMAGE_BYTES + 1);
    await file.close();
    await expect(readLocalImage(cwd, "large.png")).rejects.toThrow("16 MiB");
  });

  it.each(["a.svg", "a.txt", "file://server/share/a.png", "\\\\server\\share\\a.png", "C:\\a.txt:stream.png"])(
    "rejects unsupported or remote path %s before reading", async (path) => {
      await expect(readLocalImage(cwd, path)).rejects.toThrow("仅支持本地");
    },
  );
});
