import { opendir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Dirent } from "node:fs";
import type { DirectoryListing } from "../shared/protocol.js";
import { validateCwd } from "./cwd.js";

const MAX_DIRECTORIES = 500;
const MAX_DIRECTORY_SCAN_ENTRIES = MAX_DIRECTORIES * 4;
const MAX_DIRECTORY_STAT_CONCURRENCY = 16;
// Directory observations keep their own small budget, independent of image upload frames.
const MAX_LISTING_BYTES = 1_000_000 - (64 * 1024);
const MAX_PATH_LENGTH = 4096;

async function toDirectory(
  currentPath: string,
  entry: Dirent,
): Promise<DirectoryListing["directories"][number] | undefined> {
  const path = join(currentPath, entry.name);
  try {
    return (await stat(path)).isDirectory()
      ? { name: entry.name, path }
      : undefined;
  } catch {
    return undefined;
  }
}

export type DirectoryBrowser = (path: string) => Promise<DirectoryListing>;

export function buildDirectoryListing(
  path: string,
  parentPath: string | null,
  directories: DirectoryListing["directories"],
): DirectoryListing {
  const selected: DirectoryListing["directories"] = [];
  let byteLength = Buffer.byteLength(JSON.stringify({
    path,
    parentPath,
    directories: [],
    truncated: false,
  }), "utf8");
  let truncated = false;
  for (const directory of directories) {
    if (
      directory.name.length > 1024
      || directory.path.length > MAX_PATH_LENGTH
    ) {
      truncated = true;
      continue;
    }
    if (selected.length >= MAX_DIRECTORIES) {
      truncated = true;
      break;
    }
    const entryBytes = Buffer.byteLength(JSON.stringify(directory), "utf8") + 1;
    if (byteLength + entryBytes > MAX_LISTING_BYTES) {
      truncated = true;
      break;
    }
    selected.push(directory);
    byteLength += entryBytes;
  }
  return { path, parentPath, directories: selected, truncated };
}

export async function listDirectory(value: string): Promise<DirectoryListing> {
  const requested = resolve(value.trim());
  if (requested.length > MAX_PATH_LENGTH) {
    throw new Error("目录路径过长");
  }
  let currentPath: string;
  try {
    currentPath = await validateCwd(requested);
  } catch {
    throw new Error(`目录不存在或无法访问：${requested}`);
  }

  const directories: DirectoryListing["directories"] = [];
  let enumerationTruncated = false;
  try {
    const directory = await opendir(currentPath);
    try {
      const pendingDirectories: Array<
        Promise<DirectoryListing["directories"][number] | undefined>
      > = [];
      const flushPendingDirectories = async (): Promise<void> => {
        const resolved = await Promise.all(pendingDirectories.splice(0));
        for (const entry of resolved) {
          if (entry !== undefined) directories.push(entry);
        }
      };
      let entriesScanned = 0;
      while (entriesScanned < MAX_DIRECTORY_SCAN_ENTRIES) {
        const entry = await directory.read();
        if (entry === null) break;
        entriesScanned += 1;
        if (entry.isDirectory()) {
          directories.push({ name: entry.name, path: join(currentPath, entry.name) });
        } else if (entry.isSymbolicLink()) {
          pendingDirectories.push(toDirectory(currentPath, entry));
        }
        if (
          pendingDirectories.length === MAX_DIRECTORY_STAT_CONCURRENCY
          || directories.length > MAX_DIRECTORIES
        ) {
          await flushPendingDirectories();
        }
        if (directories.length > MAX_DIRECTORIES) {
          enumerationTruncated = true;
          break;
        }
      }
      if (!enumerationTruncated && entriesScanned === MAX_DIRECTORY_SCAN_ENTRIES) {
        enumerationTruncated = (await directory.read()) !== null;
      }
      await flushPendingDirectories();
      if (directories.length > MAX_DIRECTORIES) enumerationTruncated = true;
    } finally {
      await directory.close();
    }
  } catch {
    throw new Error(`无法读取目录：${currentPath}`);
  }

  directories.sort((left, right) => left.name.localeCompare(
    right.name,
    undefined,
    { numeric: true, sensitivity: "base" },
  ));
  const parentPath = dirname(currentPath) === currentPath
    ? null
    : dirname(currentPath);
  const listing = buildDirectoryListing(currentPath, parentPath, directories);
  return { ...listing, truncated: listing.truncated || enumerationTruncated };
}
