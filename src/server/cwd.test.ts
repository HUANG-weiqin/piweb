import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCwd } from "./cwd.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("validateCwd", () => {
  it("accepts an existing directory", async () => {
    const dir = await temporaryDirectory("piweb-");
    await expect(validateCwd(dir)).resolves.toBe(dir);
  });

  it("rejects files and missing paths", async () => {
    const dir = await temporaryDirectory("piweb-");
    const file = join(dir, "file.txt");
    await writeFile(file, "x");
    await expect(validateCwd(file)).rejects.toThrow("not a directory");
    await expect(validateCwd(join(dir, "missing"))).rejects.toThrow("does not exist");
  });
});
