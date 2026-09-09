import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ColorScheme, UiPreferences } from "../shared/protocol.js";

export const UI_PREFERENCES_VERSION = 1;
export const DEFAULT_UI_PREFERENCES: Readonly<UiPreferences> = Object.freeze({
  colorScheme: "quiet-rebel",
});

interface UiPreferencesDocument extends UiPreferences {
  version: typeof UI_PREFERENCES_VERSION;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColorScheme(value: unknown): value is ColorScheme {
  return value === "quiet-rebel" || value === "classic-rebel";
}

function parseDocument(raw: string): UiPreferencesDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("UI preferences must contain valid JSON", { cause: error });
  }
  if (!isRecord(value)) throw new Error("UI preferences must be an object");
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.includes("version")
    || !keys.includes("colorScheme")
  ) {
    throw new Error("UI preferences must contain only version and colorScheme");
  }
  if (value.version !== UI_PREFERENCES_VERSION) {
    throw new Error(`Unsupported UI preferences version: ${String(value.version)}`);
  }
  if (!isColorScheme(value.colorScheme)) {
    throw new Error(`Unsupported color scheme: ${String(value.colorScheme)}`);
  }
  return {
    version: UI_PREFERENCES_VERSION,
    colorScheme: value.colorScheme,
  };
}

async function writeDocumentAtomically(
  preferencesPath: string,
  document: UiPreferencesDocument,
): Promise<void> {
  await mkdir(dirname(preferencesPath), { recursive: true });
  const temporaryPath = join(
    dirname(preferencesPath),
    `.${basename(preferencesPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(document, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporaryPath, preferencesPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class UiPreferencesStore {
  private preferences: UiPreferences;
  private needsRepair: boolean;
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly preferencesPath: string | undefined,
    preferences: UiPreferences,
    private readonly loadWarning: string | undefined,
    needsRepair: boolean,
  ) {
    this.preferences = { ...preferences };
    this.needsRepair = needsRepair;
  }

  static memory(preferences: UiPreferences = DEFAULT_UI_PREFERENCES): UiPreferencesStore {
    if (!isColorScheme(preferences.colorScheme)) {
      throw new Error(`Unsupported color scheme: ${String(preferences.colorScheme)}`);
    }
    return new UiPreferencesStore(undefined, preferences, undefined, false);
  }

  static async open(
    preferencesPath = join(getAgentDir(), "piweb", "ui-preferences.json"),
  ): Promise<UiPreferencesStore> {
    let raw: string;
    try {
      raw = await readFile(preferencesPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return new UiPreferencesStore(
          preferencesPath,
          DEFAULT_UI_PREFERENCES,
          undefined,
          false,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return new UiPreferencesStore(
        preferencesPath,
        DEFAULT_UI_PREFERENCES,
        `Unable to read UI preferences at ${preferencesPath}: ${message}`,
        true,
      );
    }

    try {
      const document = parseDocument(raw);
      return new UiPreferencesStore(
        preferencesPath,
        { colorScheme: document.colorScheme },
        undefined,
        false,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new UiPreferencesStore(
        preferencesPath,
        DEFAULT_UI_PREFERENCES,
        `Invalid UI preferences at ${preferencesPath}: ${message}`,
        true,
      );
    }
  }

  get(): UiPreferences {
    return { ...this.preferences };
  }

  getLoadWarning(): string | undefined {
    return this.loadWarning;
  }

  async setColorScheme(colorScheme: ColorScheme): Promise<UiPreferences> {
    if (!isColorScheme(colorScheme)) {
      throw new Error(`Unsupported color scheme: ${String(colorScheme)}`);
    }
    return this.enqueueWrite(async () => {
      if (this.preferences.colorScheme === colorScheme && !this.needsRepair) {
        return this.get();
      }
      if (this.preferencesPath !== undefined) {
        await writeDocumentAtomically(this.preferencesPath, {
          version: UI_PREFERENCES_VERSION,
          colorScheme,
        });
      }
      this.preferences = { colorScheme };
      this.needsRepair = false;
      return this.get();
    });
  }

  private enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(write, write);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
