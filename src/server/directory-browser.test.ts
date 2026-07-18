import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES } from "../shared/protocol.js";
import {
  buildDirectoryListing,
  listDirectory,
} from "./directory-browser.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("listDirectory", () => {
  it("returns an absolute, sorted, directory-only listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "piweb-directory-browser-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "zeta"));
    await mkdir(join(root, "Alpha"));
    await writeFile(join(root, "notes.txt"), "not a directory");

    await expect(listDirectory(root)).resolves.toEqual({
      path: resolve(root),
      parentPath: dirname(resolve(root)),
      directories: [{
        name: "Alpha",
        path: join(resolve(root), "Alpha"),
      }, {
        name: "zeta",
        path: join(resolve(root), "zeta"),
      }],
      truncated: false,
    });
  });

  it("rejects missing paths instead of returning an empty directory", async () => {
    const missing = join(tmpdir(), "piweb-directory-browser-missing");
    await expect(listDirectory(missing)).rejects.toThrow("目录不存在或无法访问");
  });

  it("rejects files as browsing locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "piweb-directory-browser-file-"));
    temporaryDirectories.push(root);
    const file = join(root, "notes.txt");
    await writeFile(file, "not a directory");

    await expect(listDirectory(file)).rejects.toThrow("目录不存在或无法访问");
  });

  it("caps the number of visible directories", () => {
    const listing = buildDirectoryListing(
      "E:\\work",
      "E:\\",
      Array.from({ length: 501 }, (_, index) => ({
        name: `directory-${index}`,
        path: `E:\\work\\directory-${index}`,
      })),
    );

    expect(listing.directories).toHaveLength(500);
    expect(listing.truncated).toBe(true);
  });

  it("keeps long listings below the socket message limit", () => {
    const listing = buildDirectoryListing(
      "E:\\work",
      "E:\\",
      Array.from({ length: 500 }, (_, index) => ({
        name: `directory-${index}`,
        path: `E:\\${"界".repeat(4_000)}-${index}`,
      })),
    );
    const event = {
      type: "directory_listing",
      commandId: "b55e4225-e07f-4874-b760-015f7982d999",
      ...listing,
    };

    expect(listing.truncated).toBe(true);
    expect(listing.directories.length).toBeLessThan(500);
    expect(Buffer.byteLength(JSON.stringify(event), "utf8"))
      .toBeLessThan(MAX_MESSAGE_BYTES);
  });
});
