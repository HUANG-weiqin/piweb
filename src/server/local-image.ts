import { localImagePath } from "../shared/local-image-path.js";
import {
  MAX_CONVERSATION_IMAGE_BYTES,
  type ConversationImage,
  type PromptImageMimeType,
} from "../shared/protocol.js";
import { readLocalFileBytes } from "./local-file.js";

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
  const bytes = await readLocalFileBytes(cwd, path, MAX_CONVERSATION_IMAGE_BYTES);
  if (bytes.length === 0) throw new Error("图片必须非空且不超过 16 MiB");
  const mimeType = rasterMimeType(bytes);
  if (!mimeType) throw new Error("文件内容不是受支持的图片");
  return { mimeType, data: bytes.toString("base64") };
}
