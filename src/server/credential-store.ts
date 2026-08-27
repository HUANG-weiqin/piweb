import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";

const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_RETRY_DELAY_MS = 2_000;
const COMMAND_TIMEOUT_MS = 10_000;
const commandResultCache = new Map<string, string | undefined>();

interface AuthData {
  [providerId: string]: Credential;
}

type TemplatePart =
  | { type: "literal"; value: string }
  | { type: "env"; name: string };

function defaultAuthPath(): string {
  return join(getAgentDir(), "auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "api_key") {
    const validKey = value.key === undefined || typeof value.key === "string";
    const validEnv =
      value.env === undefined ||
      (isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === "string"));
    return validKey && validEnv;
  }

  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  );
}

function parseAuthData(content: string): AuthData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Failed to read auth.json: invalid JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid auth.json: expected an object");
  }

  for (const [providerId, credential] of Object.entries(parsed)) {
    if (!isCredential(credential)) {
      throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
    }
  }

  return parsed as AuthData;
}

function cloneCredential(credential: Credential | undefined): Credential | undefined {
  return credential === undefined ? undefined : structuredClone(credential);
}

function getCredential(data: AuthData, providerId: string): Credential | undefined {
  return Object.hasOwn(data, providerId) ? data[providerId] : undefined;
}

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "literal") {
    previous.value += value;
  } else {
    parts.push({ type: "literal", value });
  }
}

function parseTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const envNamePrefix = /^[A-Za-z_][A-Za-z0-9_]*/;
  let index = 0;

  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }

    appendLiteral(parts, config.slice(index, dollarIndex));
    const next = config[dollarIndex + 1];
    if (next === "$" || next === "!") {
      appendLiteral(parts, next);
      index = dollarIndex + 2;
      continue;
    }

    if (next === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, "$");
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (envName.test(name)) {
        parts.push({ type: "env", name });
      } else {
        appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      }
      index = endIndex + 1;
      continue;
    }

    const match = config.slice(dollarIndex + 1).match(envNamePrefix);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }

    appendLiteral(parts, "$");
    index = dollarIndex + 1;
  }

  return parts;
}

function resolveTemplate(config: string, env: Record<string, string> | undefined): string | undefined {
  let result = "";
  for (const part of parseTemplate(config)) {
    if (part.type === "literal") {
      result += part.value;
      continue;
    }
    const value = env?.[part.name] || process.env[part.name] || undefined;
    if (value === undefined) return undefined;
    result += value;
  }
  return result;
}

function executeWithConfiguredShell(command: string): {
  executed: boolean;
  value: string | undefined;
} {
  try {
    const { shell, args, commandTransport } = getShellConfig();
    const commandFromStdin = commandTransport === "stdin";
    const result = spawnSync(
      shell,
      commandFromStdin ? args : [...args, command],
      {
        encoding: "utf8",
        input: commandFromStdin ? command : undefined,
        timeout: COMMAND_TIMEOUT_MS,
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error) {
      const code = "code" in result.error ? result.error.code : undefined;
      return code === "ENOENT"
        ? { executed: false, value: undefined }
        : { executed: true, value: undefined };
    }
    return {
      executed: true,
      value: result.status === 0 ? result.stdout.trim() || undefined : undefined,
    };
  } catch {
    return { executed: false, value: undefined };
  }
}

function executeWithDefaultShell(command: string): string | undefined {
  try {
    const output = execSync(command, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveConfigValue(config: string, env: Record<string, string> | undefined): string | undefined {
  if (!config.startsWith("!")) return resolveTemplate(config, env);
  if (commandResultCache.has(config)) return commandResultCache.get(config);

  const command = config.slice(1);
  const result = process.platform === "win32"
    ? (() => {
        const configured = executeWithConfiguredShell(command);
        return configured.executed ? configured.value : executeWithDefaultShell(command);
      })()
    : executeWithDefaultShell(command);
  commandResultCache.set(config, result);
  return result;
}

export function clearCredentialCommandCache(): void {
  commandResultCache.clear();
}

function abortIfNeeded(options?: AuthOperationOptions): void {
  options?.signal?.throwIfAborted();
}

function abortReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason
    ?? new DOMException("Aborted", "AbortError");
}

function raceWithAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

type ReloadState = {
  promise: Promise<{ data: AuthData; revision: string | undefined }>;
  abortController: AbortController;
  readers: number;
};

export class FileCredentialStore implements CredentialStore {
  private readonly authPath: string;
  private cachedData: AuthData | undefined;
  private cachedRevision: string | undefined;
  private reloadState: ReloadState | undefined;

  constructor(authPath: string = defaultAuthPath()) {
    const expanded = authPath === "~"
      ? homedir()
      : authPath.startsWith("~/") || authPath.startsWith("~\\")
        ? join(homedir(), authPath.slice(2))
        : authPath;
    this.authPath = resolve(expanded);
  }

  private ensureParentDirectory(): void {
    const parent = dirname(this.authPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: AUTH_DIRECTORY_MODE });
  }

  private getFileRevision(): string | undefined {
    try {
      const stats = statSync(this.authPath, { bigint: true });
      // Match cache identity to the file and its high-resolution write metadata.
      // A mismatch reloads under the writer lock, so in-place writes cannot be
      // parsed until the writer has released a complete JSON document.
      return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
    } catch {
      return undefined;
    }
  }

  private async acquireLock(
    options: AuthOperationOptions | undefined,
    onCompromised: (error: Error) => void,
  ): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_STALE_MS;
    let retry = 0;
    while (true) {
      abortIfNeeded(options);
      try {
        const release = await lockfile.lock(this.authPath, {
          realpath: false,
          retries: 0,
          stale: LOCK_STALE_MS,
          onCompromised,
        });
        if (options?.signal?.aborted) {
          await release();
          abortIfNeeded(options);
        }
        return release;
      } catch (error) {
        abortIfNeeded(options);
        const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
        const remainingMs = deadline - Date.now();
        if (code !== "ELOCKED" || remainingMs <= 0) throw error;
        const baseDelayMs = Math.min(10 * 2 ** retry, LOCK_MAX_RETRY_DELAY_MS / 2);
        retry++;
        const retryDelayMs = Math.min(
          Math.round(baseDelayMs * (1 + Math.random())),
          remainingMs,
        );
        await delay(
          retryDelayMs,
          undefined,
          options?.signal ? { signal: options.signal } : undefined,
        );
      }
    }
  }

  private async withLock<T>(
    options: AuthOperationOptions | undefined,
    operation: (data: AuthData) => Promise<{ result: T; next?: AuthData }>,
  ): Promise<T> {
    abortIfNeeded(options);
    this.ensureParentDirectory();

    let compromised: Error | undefined;
    const release = await this.acquireLock(options, (error) => {
      compromised = error;
    });
    try {
      if (compromised) throw compromised;
      abortIfNeeded(options);
      if (!existsSync(this.authPath)) {
        writeFileSync(this.authPath, "{}", { encoding: "utf8", mode: AUTH_FILE_MODE });
        chmodSync(this.authPath, AUTH_FILE_MODE);
      }
      const data = parseAuthData(readFileSync(this.authPath, "utf8"));
      const { result, next } = await operation(data);
      if (compromised) throw compromised;
      abortIfNeeded(options);
      if (next !== undefined) {
        const serialized = JSON.stringify(next, null, 2);
        writeFileSync(this.authPath, serialized, { encoding: "utf8", mode: AUTH_FILE_MODE });
        chmodSync(this.authPath, AUTH_FILE_MODE);
        if (compromised) throw compromised;
      }
      return result;
    } finally {
      try {
        await release();
      } catch (error) {
        if (!compromised) throw error;
      }
    }
  }

  private reloadUnderLock(
    signal: AbortSignal,
  ): Promise<{ data: AuthData; revision: string | undefined }> {
    return this.withLock({ signal }, async (data) => ({
      result: {
        data,
        revision: this.getFileRevision(),
      },
    }));
  }

  private async readLatestData(options?: AuthOperationOptions): Promise<AuthData> {
    abortIfNeeded(options);
    const currentRevision = this.getFileRevision();
    if (
      this.cachedData !== undefined &&
      this.cachedRevision !== undefined &&
      currentRevision !== undefined &&
      this.cachedRevision === currentRevision
    ) {
      abortIfNeeded(options);
      return this.cachedData;
    }
    return this.joinReload(options);
  }

  private async joinReload(options?: AuthOperationOptions): Promise<AuthData> {
    abortIfNeeded(options);
    while (true) {
      let state = this.reloadState;
      if (state?.abortController.signal.aborted) {
        // The last reader abandoned this generation. Keep successors behind its
        // settlement so lock cleanup cannot race a replacement reload.
        const settlement = state.promise.then(
          () => undefined,
          () => undefined,
        );
        await raceWithAbortSignal(settlement, options?.signal);
        abortIfNeeded(options);
        continue;
      }
      if (!state) {
        const abortController = new AbortController();
        let createdState!: ReloadState;
        const promise = this.reloadUnderLock(abortController.signal).then((result) => {
          if (this.reloadState === createdState) {
            this.cachedData = result.data;
            this.cachedRevision = result.revision;
          }
          return result;
        });
        createdState = { promise, abortController, readers: 0 };
        this.reloadState = createdState;
        const clearIfCurrent = (): void => {
          // A retiring generation remains visible until its lock attempt and
          // release path have completely settled.
          if (this.reloadState === createdState) this.reloadState = undefined;
        };
        void promise.then(clearIfCurrent, clearIfCurrent);
        state = createdState;
      }
      state.readers++;
      try {
        const result = await raceWithAbortSignal(state.promise, options?.signal);
        return result.data;
      } finally {
        state.readers--;
        if (
          state.readers === 0 &&
          this.reloadState === state &&
          !state.abortController.signal.aborted
        ) {
          // Do not clear here: a replacement must observe this retiring state
          // until state.promise runs the settlement cleanup above.
          state.abortController.abort();
        }
      }
    }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const data = await this.readLatestData(options);
    abortIfNeeded(options);
    const credential = cloneCredential(getCredential(data, providerId));
    abortIfNeeded(options);
    if (credential?.type === "api_key" && credential.key !== undefined) {
      credential.key = resolveConfigValue(credential.key, credential.env);
    }
    abortIfNeeded(options);
    return credential;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const data = await this.readLatestData(options);
    abortIfNeeded(options);
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    let snapshot!: AuthData;
    let snapshotRevision: string | undefined;
    let wrote = false;
    const result = await this.withLock(options, async (data) => {
      const current = cloneCredential(getCredential(data, providerId));
      const next = await fn(current);
      abortIfNeeded(options);
      if (next === undefined) {
        snapshot = data;
        snapshotRevision = this.getFileRevision();
        return { result: cloneCredential(getCredential(data, providerId)) };
      }
      if (!isCredential(next)) {
        throw new Error(`Invalid credential for provider "${providerId}"`);
      }
      const stored = cloneCredential(next) as Credential;
      snapshot = { ...data, [providerId]: stored };
      wrote = true;
      return { result: cloneCredential(stored), next: snapshot };
    });
    this.cachedData = snapshot;
    // A write's revision cannot be sampled after unlock without pairing this
    // snapshot with a later process's write. Revalidate once on the next read.
    this.cachedRevision = wrote ? undefined : snapshotRevision;
    return result;
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    let snapshot!: AuthData;
    await this.withLock(options, async (data) => {
      snapshot = { ...data };
      delete snapshot[providerId];
      return { result: undefined, next: snapshot };
    });
    this.cachedData = snapshot;
    // See modify(): force one locked revalidation after publishing a write.
    this.cachedRevision = undefined;
  }
}
