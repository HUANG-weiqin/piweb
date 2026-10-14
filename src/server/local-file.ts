import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { localFilePath } from "../shared/local-file-path.js";
import { MAX_LOCAL_FILE_BYTES, MAX_LOCAL_FILE_NAME_CHARACTERS, type LocalFile } from "../shared/protocol.js";

/** Shared finite read for validated native local paths, including image previews. */
export async function readLocalFileBytes(cwd: string, path: string, maximumBytes: number): Promise<Buffer> {
  if (process.platform !== "win32" && /^[a-z]:[\\/]/i.test(path)) {
    throw new Error("当前操作系统不支持 Windows 文件路径");
  }
  const canonical = await realpath(resolve(cwd, path));
  if (canonical.replace(/\\/g, "/").startsWith("//")) {
    throw new Error("不支持网络共享文件路径");
  }
  // O_NONBLOCK prevents a substituted FIFO from stalling the read on POSIX.
  const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("文件路径不是普通文件");
    if (before.size > BigInt(maximumBytes)) throw new Error("文件不得超过 16 MiB");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("读取期间文件发生变化，请重试");
      offset += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("读取期间文件发生变化，请重试");
    }
    return bytes;
  } finally {
    await file.close();
  }
}

/** Read current disk bytes only; no history, static service or OS handoff. */
export async function readLocalFile(cwd: string, value: string): Promise<LocalFile> {
  const path = localFilePath(value);
  if (!path) throw new Error("仅支持安全的本地文件路径");
  const fileName = basename(path);
  if (!fileName || fileName.length > MAX_LOCAL_FILE_NAME_CHARACTERS || /[\\/\x00-\x1f\x7f]/.test(fileName)) {
    throw new Error("文件名不是安全的 basename");
  }
  const bytes = await readLocalFileBytes(cwd, path, MAX_LOCAL_FILE_BYTES);
  const mimeType = /^\.(?:md|markdown|txt|log|json|csv|yaml|yml)$/i.test(extname(fileName))
    ? "text/plain" : "application/octet-stream";
  return { fileName, mimeType, data: bytes.toString("base64") };
}
