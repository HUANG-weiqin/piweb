import { constants } from "node:fs";
import { open, readlink } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { LspError } from "./contracts.js";

let nativePathReader: Promise<(fd: number) => string> | undefined;

async function descriptorPath(fd: number): Promise<string> {
  if (process.platform === "linux") return readlink(`/proc/self/fd/${fd}`);
  nativePathReader ??= (async () => {
    const { default: koffi } = await import("koffi");
    if (process.platform === "win32") {
      // Use Node's own libuv/CRT table, not ucrtbase.dll's different fd table.
      const osHandle = koffi.load(null).func("intptr_t uv_get_osfhandle(int fd)");
      const finalPath = koffi.load("kernel32.dll").func(
        "uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t handle, _Out_ uint8_t *path, uint32_t capacity, uint32_t flags)",
      );
      return (file: number) => {
        const handle: number | bigint = osHandle(file);
        if (handle === -1 || handle === -1n) throw new Error("No native file handle");
        const buffer = Buffer.alloc(32768 * 2);
        const length: number = finalPath(handle, buffer, 32768, 0);
        if (!length || length >= 32768) throw new Error("No bounded final file path");
        const path = buffer.subarray(0, length * 2).toString("utf16le");
        if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
        if (/^\\\\\?\\[A-Za-z]:\\/u.test(path)) return path.slice(4);
        throw new Error("No comparable DOS/UNC file path");
      };
    }
    if (process.platform === "darwin") {
      const fcntl = koffi.load("/usr/lib/libSystem.B.dylib").func("int fcntl(int fd, int command, ...)");
      return (file: number) => {
        // Darwin F_GETPATH=50 writes a NUL-terminated path, at most MAXPATHLEN=1024.
        const buffer = Buffer.alloc(1024, 0xff);
        if (fcntl(file, 50, "void *", buffer) !== 0) throw new Error("F_GETPATH failed");
        const end = buffer.indexOf(0);
        if (end <= 0) throw new Error("No bounded descriptor path");
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
      };
    }
    throw new Error("Descriptor path binding is unavailable on this platform");
  })();
  return (await nativePathReader)(fd);
}

/** A bounded source observation. No decoding or caller-visible bytes before fd/path proof. */
export async function readWorkspaceFile(
  workspace: string,
  file: string,
  maxBytes: number,
  onRead?: (bytes: number) => void,
): Promise<Buffer> {
  const root = normalize(workspace);
  const expected = normalize(file);
  const suffix = relative(root, expected);
  // Exact canonical spelling also keeps Windows case-sensitive directories distinct.
  if (!isAbsolute(root) || !isAbsolute(expected) || !expected.startsWith(root.endsWith(sep) ? root : root + sep)
    || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new LspError("invalid_path", "LSP source is outside the canonical workspace");
  }
  // A replacement FIFO must not turn a regular-file read into an unbounded open.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  const assertBound = async () => {
    let actual: string;
    try { actual = normalize(await descriptorPath(handle.fd)); }
    catch (error) { throw new LspError("unavailable", "Unable to bind the LSP source descriptor to its path", { cause: error }); }
    if (actual !== expected) throw new LspError("invalid_path", "The LSP source path was replaced or moved");
  };
  try {
    await assertBound();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new LspError("invalid_path", "LSP source is not a regular file");
    if (before.size > BigInt(maxBytes)) throw new LspError("resource_limit", "LSP source exceeds the read budget");
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      onRead?.(bytesRead);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    await assertBound();
    if (length > maxBytes || after.size > BigInt(maxBytes)) throw new LspError("resource_limit", "LSP source exceeds the read budget");
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || after.size !== BigInt(length)
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new LspError("content_modified", "The LSP source changed while it was read");
    }
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
