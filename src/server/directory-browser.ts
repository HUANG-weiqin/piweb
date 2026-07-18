import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Dirent } from "node:fs";
import {
  MAX_MESSAGE_BYTES,
  type DirectoryListing,
} from "../shared/protocol.js";
import { validateCwd } from "./cwd.js";

const MAX_DIRECTORIES = 500;
const MAX_LISTING_BYTES = MAX_MESSAGE_BYTES - (64 * 1024);
const MAX_PATH_LENGTH = 4096;

async function toDirectory(
  currentPath: string,
  entry: Dirent,
): Promise<DirectoryListing["directories"][number] | undefined> {
  const path = join(currentPath, entry.name);
  if (entry.isDirectory()) return { name: entry.name, path };
  if (!entry.isSymbolicLink()) return undefined;
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

  let entries: Dirent[];
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    throw new Error(`无法读取目录：${currentPath}`);
  }

  const directories = (await Promise.all(
    entries.map((entry) => toDirectory(currentPath, entry)),
  ))
    .filter((entry): entry is DirectoryListing["directories"][number] => Boolean(entry))
    .sort((left, right) => left.name.localeCompare(
      right.name,
      undefined,
      { numeric: true, sensitivity: "base" },
    ));

  const parentPath = dirname(currentPath) === currentPath
    ? null
    : dirname(currentPath);
  return buildDirectoryListing(currentPath, parentPath, directories);
}
