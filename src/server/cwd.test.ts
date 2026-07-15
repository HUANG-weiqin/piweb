import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCwd } from "./cwd.js";

describe("validateCwd", () => {
  it("accepts an existing directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "piweb-"));
    await expect(validateCwd(dir)).resolves.toBe(dir);
  });

  it("rejects files and missing paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "piweb-"));
    const file = join(dir, "file.txt");
    await writeFile(file, "x");
    await expect(validateCwd(file)).rejects.toThrow("not a directory");
    await expect(validateCwd(join(dir, "missing"))).rejects.toThrow("does not exist");
  });
});
