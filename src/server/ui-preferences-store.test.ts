import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_VERSION,
  UiPreferencesStore,
} from "./ui-preferences-store.js";

const temporaryDirectories: string[] = [];

async function preferencesPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "piweb-ui-preferences-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "piweb", "ui-preferences.json");
  await mkdir(dirname(path), { recursive: true });
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("UiPreferencesStore", () => {
  it("uses Quiet Rebel without creating a file when preferences are missing", async () => {
    const path = await preferencesPath();
    const store = await UiPreferencesStore.open(path);

    expect(store.get()).toEqual(DEFAULT_UI_PREFERENCES);
    expect(store.getLoadWarning()).toBeUndefined();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists an exact versioned document and restores it", async () => {
    const path = await preferencesPath();
    const store = await UiPreferencesStore.open(path);

    await expect(store.setColorScheme("classic-rebel")).resolves.toEqual({
      colorScheme: "classic-rebel",
    });
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify({
      version: UI_PREFERENCES_VERSION,
      colorScheme: "classic-rebel",
    }, null, 2)}\n`);
    await expect(UiPreferencesStore.open(path).then((reopened) => reopened.get()))
      .resolves.toEqual({ colorScheme: "classic-rebel" });
  });

  it.each([
    "not json",
    "[]",
    JSON.stringify({ version: UI_PREFERENCES_VERSION }),
    JSON.stringify({ version: UI_PREFERENCES_VERSION, colorScheme: "quiet-rebel", extra: true }),
    JSON.stringify({ version: 2, colorScheme: "classic-rebel" }),
    JSON.stringify({ version: UI_PREFERENCES_VERSION, colorScheme: "unknown" }),
  ])("fails safe to Quiet Rebel for an invalid document and repairs it on explicit save", async (raw) => {
    const path = await preferencesPath();
    await writeFile(path, raw, "utf8");

    const store = await UiPreferencesStore.open(path);
    expect(store.get()).toEqual(DEFAULT_UI_PREFERENCES);
    expect(store.getLoadWarning()).toContain("Invalid UI preferences");

    await store.setColorScheme("quiet-rebel");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: UI_PREFERENCES_VERSION,
      colorScheme: "quiet-rebel",
    });
  });

  it("serializes concurrent writes and leaves no temporary files", async () => {
    const path = await preferencesPath();
    const store = await UiPreferencesStore.open(path);

    await Promise.all([
      store.setColorScheme("classic-rebel"),
      store.setColorScheme("quiet-rebel"),
      store.setColorScheme("classic-rebel"),
    ]);

    expect(store.get()).toEqual({ colorScheme: "classic-rebel" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: UI_PREFERENCES_VERSION,
      colorScheme: "classic-rebel",
    });
    expect(await readdir(join(path, ".."))).toEqual(["ui-preferences.json"]);
  });
});
