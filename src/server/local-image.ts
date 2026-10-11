import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { localImagePath } from "../shared/local-image-path.js";
import {
  MAX_CONVERSATION_IMAGE_BYTES,
  type ConversationImage,
  type PromptImageMimeType,
} from "../shared/protocol.js";

function rasterMimeType(bytes: Buffer): PromptImageMimeType | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const header = bytes.toString("ascii", 0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

/** Read current disk bytes; this is not a persisted conversation image. */
export async function readLocalImage(cwd: string, value: string): Promise<ConversationImage> {
  const path = localImagePath(value);
  if (!path) throw new Error("仅支持本地 PNG/JPEG/WebP/GIF 图片路径");
  if (process.platform !== "win32" && /^[a-z]:[\\/]/i.test(path)) {
    throw new Error("当前操作系统不支持 Windows 图片路径");
  }
  const canonical = await realpath(resolve(cwd, path));
  if (canonical.replace(/\\/g, "/").startsWith("//")) {
    throw new Error("不支持网络共享图片路径");
  }
  // O_NONBLOCK prevents a substituted FIFO from stalling the read on POSIX.
  const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("图片路径不是普通文件");
    if (before.size === 0 || before.size > MAX_CONVERSATION_IMAGE_BYTES) {
      throw new Error("图片必须非空且不超过 16 MiB");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("读取期间图片文件发生变化，请重试");
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("读取期间图片文件发生变化，请重试");
    }
    const mimeType = rasterMimeType(bytes);
    if (!mimeType) throw new Error("文件内容不是受支持的图片");
    return { mimeType, data: bytes.toString("base64") };
  } finally {
    await file.close();
  }
}
