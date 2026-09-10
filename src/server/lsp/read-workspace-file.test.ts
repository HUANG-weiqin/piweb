import { mkdtemp, open, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import koffi from "koffi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readlink: vi.fn(actual.readlink) };
});
vi.mock("koffi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("koffi")>();
  return { ...actual, default: { ...actual.default, load: vi.fn(actual.default.load) } };
});
const nativeFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const nativeKoffi = (await vi.importActual<typeof import("koffi")>("koffi")).default;
let cwd: string;
let file: string;

beforeEach(async () => {
  vi.resetModules();
  vi.mocked(open).mockReset().mockImplementation(nativeFs.open);
  vi.mocked(readlink).mockReset().mockImplementation(nativeFs.readlink);
  vi.mocked(koffi.load).mockReset().mockImplementation(nativeKoffi.load);
  cwd = await realpath(await mkdtemp(join(tmpdir(), "piweb-lsp-bound-read-")));
  file = join(cwd, "source.ts");
  await writeFile(file, "\uFEFFhello\n");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
});

async function read(limit = 32) {
  return (await import("./read-workspace-file.js")).readWorkspaceFile(cwd, file, limit);
}

function platform(name: string) {
  vi.stubGlobal("process", { ...process, platform: name });
}

function darwinBinding(action: (buffer: Buffer) => number) {
  platform("darwin");
  const fcntl = vi.fn((_fd: number, command: number, type: string, buffer: Buffer) => {
    expect(command).toBe(50);
    expect(type).toBe("void *");
    expect(buffer.length).toBe(1024);
    return action(buffer);
  });
  vi.mocked(koffi.load).mockImplementation((library) => {
    expect(library).toBe("/usr/lib/libSystem.B.dylib");
    return { func: (signature: string) => {
      expect(signature).toBe("int fcntl(int fd, int command, ...)");
      return fcntl;
    } } as unknown as ReturnType<typeof koffi.load>;
  });
  return fcntl;
}

describe("descriptor-bound LSP source reads", () => {
  it("reads through the native descriptor binding, preserving bytes and the exact limit", async () => {
    const expected = Buffer.from("\uFEFFhello\n");
    expect(await read(expected.length)).toEqual(expected);
    await expect(read(expected.length - 1)).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("rejects a descriptor moved outside after reading and always closes it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "piweb-lsp-moved-"));
    let close: ReturnType<typeof vi.fn> | undefined;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await nativeFs.open(...args);
      close = vi.spyOn(handle, "close");
      const read = handle.read.bind(handle);
      let moved = false;
      vi.spyOn(handle, "read").mockImplementation(async (...params) => {
        const result = await read(...params as Parameters<typeof read>);
        if (!moved) { moved = true; await rename(file, join(outside, "moved.ts")); }
        return result;
      });
      return handle;
    });
    try {
      await expect(read()).rejects.toMatchObject({ code: "invalid_path" });
      expect(close).toHaveBeenCalledTimes(1);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("rejects a content change during the descriptor read", async () => {
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await nativeFs.open(...args);
      const read = handle.read.bind(handle);
      let changed = false;
      vi.spyOn(handle, "read").mockImplementation(async (...params) => {
        const result = await read(...params as Parameters<typeof read>);
        if (!changed) { changed = true; await writeFile(file, "changed text\n"); }
        return result;
      });
      return handle;
    });
    await expect(read()).rejects.toMatchObject({ code: "content_modified" });
  });

  it("uses Darwin F_GETPATH on the same fd before and after the read", async () => {
    const fcntl = darwinBinding((buffer) => { buffer.write(file + "\0", "utf8"); return 0; });
    expect(await read()).toEqual(Buffer.from("\uFEFFhello\n"));
    expect(fcntl).toHaveBeenCalledTimes(2);
    expect(fcntl.mock.calls[0]![0]).toBe(fcntl.mock.calls[1]![0]);
  });

  it.each(["failed", "unterminated", "external"])("fails closed on a %s Darwin descriptor path before reading", async (kind) => {
    darwinBinding((buffer) => {
      if (kind === "external") buffer.write(join(tmpdir(), "outside.ts") + "\0", "utf8");
      return kind === "failed" ? -1 : 0;
    });
    let readFile: ReturnType<typeof vi.fn> | undefined;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await nativeFs.open(...args);
      readFile = vi.spyOn(handle, "read");
      return handle;
    });
    await expect(read()).rejects.toMatchObject({ code: kind === "external" ? "invalid_path" : "unavailable" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("uses Linux's fd link without reopening the returned path", async () => {
    platform("linux");
    vi.mocked(readlink).mockImplementation(async (path) => {
      expect(path).toMatch(/^\/proc\/self\/fd\/\d+$/u);
      return file;
    });
    expect(await read()).toEqual(Buffer.from("\uFEFFhello\n"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(readlink).toHaveBeenCalledTimes(2);
    expect(koffi.load).not.toHaveBeenCalled();
  });

  it("does not fall back to path reads without a descriptor binding", async () => {
    platform("freebsd");
    await expect(read()).rejects.toMatchObject({ code: "unavailable" });
  });
});
