import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function validateCwd(value: string): Promise<string> {
  const cwd = resolve(value.trim());
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!info.isDirectory()) throw new Error(`Working path is not a directory: ${cwd}`);
  return cwd;
}
