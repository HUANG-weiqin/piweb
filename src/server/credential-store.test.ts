import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "./credential-store.js";

const tempDirectories: string[] = [];

async function makeAuthPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "piweb-credential-store-"));
  tempDirectories.push(directory);
  return join(directory, "nested", "auth.json");
}

async function writeAuth(authPath: string, data: unknown): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("FileCredentialStore", () => {
  it("initializes a missing auth file as an empty object", async () => {
    const authPath = await makeAuthPath();
    const store = new FileCredentialStore(authPath);

    await expect(store.list()).resolves.toEqual([]);
    await expect(readFile(authPath, "utf8")).resolves.toBe("{}");
  });

  it("reads, lists, modifies, and deletes credentials", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, {
      alpha: { type: "api_key", key: "alpha-secret", env: { REGION: "west" } },
      oauth: { type: "oauth", access: "access", refresh: "refresh", expires: 123, accountId: "extra" },
    });
    const store = new FileCredentialStore(authPath);

    await expect(store.read("alpha")).resolves.toEqual({
      type: "api_key",
      key: "alpha-secret",
      env: { REGION: "west" },
    });
    await expect(store.list()).resolves.toEqual([
      { providerId: "alpha", type: "api_key" },
      { providerId: "oauth", type: "oauth" },
    ]);
    await expect(
      store.modify("beta", async () => ({ type: "api_key", key: "beta-secret" })),
    ).resolves.toEqual({ type: "api_key", key: "beta-secret" });
    await store.delete("alpha");

    await expect(store.read("alpha")).resolves.toBeUndefined();
    await expect(store.read("beta")).resolves.toEqual({ type: "api_key", key: "beta-secret" });
    await expect(store.read("oauth")).resolves.toEqual({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 123,
      accountId: "extra",
    });
  });

  it("does not write when modify returns undefined", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, { alpha: { type: "api_key", key: "original" } });
    const store = new FileCredentialStore(authPath);

    await expect(
      store.modify("alpha", async (current) => {
        expect(current).toEqual({ type: "api_key", key: "original" });
        return undefined;
      }),
    ).resolves.toEqual({ type: "api_key", key: "original" });
    await expect(readFile(authPath, "utf8")).resolves.toContain("original");
  });

  it("serializes two store instances without losing different provider updates", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, {});
    const first = new FileCredentialStore(authPath);
    const second = new FileCredentialStore(authPath);
    let firstStarted!: () => void;
    const firstCallbackStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstCallbackMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstUpdate = first.modify("first", async () => {
      firstStarted();
      await firstCallbackMayFinish;
      return { type: "api_key", key: "first" };
    });
    await firstCallbackStarted;
    const secondUpdate = second.modify("second", async () => ({ type: "api_key", key: "second" }));
    await delay(20);
    releaseFirst();
    await Promise.all([firstUpdate, secondUpdate]);

    await expect(first.list()).resolves.toEqual([
      { providerId: "first", type: "api_key" },
      { providerId: "second", type: "api_key" },
    ]);
  });

  it("does not overwrite a corrupt auth file", async () => {
    const authPath = await makeAuthPath();
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, "{not-json", { mode: 0o600 });
    const store = new FileCredentialStore(authPath);

    await expect(store.list()).rejects.toThrow("Failed to read auth.json");
    await expect(store.modify("alpha", async () => ({ type: "api_key", key: "secret" }))).rejects.toThrow(
      "Failed to read auth.json",
    );
    await expect(readFile(authPath, "utf8")).resolves.toBe("{not-json");
  });

  it("rejects invalid top-level and credential data without writing", async () => {
    const authPath = await makeAuthPath();
    const store = new FileCredentialStore(authPath);

    await writeAuth(authPath, []);
    await expect(store.read("alpha")).rejects.toThrow("expected an object");
    await writeAuth(authPath, { alpha: { type: "oauth", access: "only-access" } });
    await expect(store.read("alpha")).rejects.toThrow("Invalid auth.json credential");
  });

  it("does not write when the callback throws or is aborted", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, { alpha: { type: "api_key", key: "original" } });
    const store = new FileCredentialStore(authPath);

    await expect(
      store.modify("alpha", async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    await expect(readFile(authPath, "utf8")).resolves.toContain("original");

    const controller = new AbortController();
    let callbackStarted!: () => void;
    const callbackStartedPromise = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    const abortedUpdate = store.modify(
      "alpha",
      async () => {
        callbackStarted();
        await delay(100);
        return { type: "api_key", key: "should-not-write" };
      },
      { signal: controller.signal },
    );
    await callbackStartedPromise;
    controller.abort();
    await expect(abortedUpdate).rejects.toThrow();
    await expect(
      store.modify("beta", async () => ({ type: "api_key", key: "not-reached" }), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    await expect(readFile(authPath, "utf8")).resolves.not.toContain("should-not-write");
  });

  it("supports aborting while waiting for the cross-process lock", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, {});
    const heldRelease = await lockfile.lock(authPath, { realpath: false });
    const controller = new AbortController();
    const store = new FileCredentialStore(authPath);
    const pending = store.modify(
      "alpha",
      async () => ({ type: "api_key", key: "not-written" }),
      { signal: controller.signal },
    );

    await delay(30);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await heldRelease();
    await expect(store.read("alpha")).resolves.toBeUndefined();
  });

  it("resolves API key templates, escapes, and commands with credential env precedence", async () => {
    const authPath = await makeAuthPath();
    const envName = "PIWEB_CREDENTIAL_STORE_TEST_VALUE";
    const previous = process.env[envName];
    process.env[envName] = "process-value";
    await writeAuth(authPath, {
      template: {
        type: "api_key",
        key: "$PREFIX-${PIWEB_CREDENTIAL_STORE_TEST_VALUE}",
        env: { PREFIX: "credential-value", [envName]: "credential-value" },
      },
      escaped: { type: "api_key", key: "$$PREFIX/$!MARKER" },
      command: {
        type: "api_key",
        key: `!${JSON.stringify(process.execPath)} -e "process.stdout.write('command-value')"`,
      },
      unresolved: { type: "api_key", key: "$PIWEB_CREDENTIAL_STORE_MISSING_VALUE" },
    });

    try {
      const store = new FileCredentialStore(authPath);
      await expect(store.read("template")).resolves.toEqual({
        type: "api_key",
        key: "credential-value-credential-value",
        env: { PREFIX: "credential-value", [envName]: "credential-value" },
      });
      await expect(store.read("escaped")).resolves.toEqual({
        type: "api_key",
        key: "$PREFIX/!MARKER",
      });
      await expect(store.read("command")).resolves.toEqual({
        type: "api_key",
        key: "command-value",
      });
      await expect(store.read("unresolved")).resolves.toEqual({
        type: "api_key",
        key: undefined,
      });
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("returns clones and does not expose secrets from list", async () => {
    const authPath = await makeAuthPath();
    const oauth: Credential = {
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 123,
      nested: { accountId: "account" },
    };
    await writeAuth(authPath, { oauth });
    const store = new FileCredentialStore(authPath);

    const readCredential = await store.read("oauth");
    expect(readCredential).toEqual(oauth);
    if (readCredential?.type === "oauth") {
      readCredential.access = "mutated";
      (readCredential.nested as { accountId: string }).accountId = "mutated";
    }
    await expect(store.read("oauth")).resolves.toEqual(oauth);
    await expect(store.list()).resolves.toEqual([{ providerId: "oauth", type: "oauth" }]);
  });
});

describe("FileCredentialStore read cache regression", () => {
  it("cold concurrent burst should perform one lock-backed reload", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, { alpha: { type: "api_key", key: "secret" } });
    const store = new FileCredentialStore(authPath);
    const spy = vi.spyOn(lockfile, "lock");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.read("alpha")),
    );
    for (const result of results) {
      expect(result).toEqual({ type: "api_key", key: "secret" });
    }
    expect(spy.mock.calls.length).toBe(1);
  });

  it("repeated unchanged reads/list should add zero locks", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, { alpha: { type: "api_key", key: "cached" } });
    const store = new FileCredentialStore(authPath);
    await store.read("alpha");
    const spy = vi.spyOn(lockfile, "lock");
    await expect(store.read("alpha")).resolves.toEqual({ type: "api_key", key: "cached" });
    await expect(store.list()).resolves.toEqual([{ providerId: "alpha", type: "api_key" }]);
    await expect(store.read("alpha")).resolves.toEqual({ type: "api_key", key: "cached" });
    await expect(store.list()).resolves.toEqual([{ providerId: "alpha", type: "api_key" }]);
    expect(spy.mock.calls.length).toBe(0);
  });

  it("external file change must be observed and require one reload", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, { alpha: { type: "api_key", key: "old" } });
    const store = new FileCredentialStore(authPath);
    await expect(store.read("alpha")).resolves.toEqual({ type: "api_key", key: "old" });
    await writeAuth(authPath, { alpha: { type: "api_key", key: "new" } });
    const spy = vi.spyOn(lockfile, "lock");
    await expect(store.read("alpha")).resolves.toEqual({ type: "api_key", key: "new" });
    expect(spy.mock.calls.length).toBe(1);
    spy.mockClear();
    await expect(store.read("alpha")).resolves.toEqual({ type: "api_key", key: "new" });
    await expect(store.list()).resolves.toEqual([{ providerId: "alpha", type: "api_key" }]);
    expect(spy.mock.calls.length).toBe(0);
  });

  it("corrupt external change must reject rather than return stale cache", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, { alpha: { type: "api_key", key: "good" } });
    const store = new FileCredentialStore(authPath);
    await expect(store.read("alpha")).resolves.toEqual({ type: "api_key", key: "good" });
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, "{not-json", { mode: 0o600 });
    await expect(store.read("alpha")).rejects.toThrow("Failed to read auth.json");
    await expect(store.list()).rejects.toThrow("Failed to read auth.json");
    await expect(readFile(authPath, "utf8")).resolves.toBe("{not-json");
    await writeAuth(authPath, { alpha: { type: "api_key", key: "recovered" } });
    await expect(store.read("alpha")).resolves.toEqual({ type: "api_key", key: "recovered" });
  });

  it("a reader joining before the last reader leaves keeps the shared reload alive", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, { alpha: { type: "api_key", key: "secret" } });
    const heldRelease = await lockfile.lock(authPath, { realpath: false });
    const store = new FileCredentialStore(authPath);
    const controller = new AbortController();
    const first = store.read("alpha", { signal: controller.signal });
    controller.abort();
    const second = store.read("alpha");
    await expect(first).rejects.toThrow();
    await heldRelease();
    await expect(second).resolves.toEqual({ type: "api_key", key: "secret" });
  });

  it("retires an abandoned reload before starting its replacement", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, {});
    const heldRelease = await lockfile.lock(authPath, { realpath: false });
    const store = new FileCredentialStore(authPath);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = store.read("alpha", { signal: c1.signal });
    const p2 = store.read("alpha", { signal: c2.signal });
    c1.abort();
    c2.abort();
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();

    const spy = vi.spyOn(lockfile, "lock");
    const replacementAbort = new AbortController();
    const cancelledReplacement = store.read("alpha", {
      signal: replacementAbort.signal,
    });
    replacementAbort.abort();
    await expect(cancelledReplacement).rejects.toThrow();
    const newRead = store.read("alpha");
    expect(spy).not.toHaveBeenCalled();

    await heldRelease();
    await expect(newRead).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ModelRuntime create/refresh with modelsPath:null and cached store does bounded locks", async () => {
    const authPath = await makeAuthPath();
    await writeAuth(authPath, {});
    const store = new FileCredentialStore(authPath);
    const spy = vi.spyOn(lockfile, "lock");
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const beforeCreate = spy.mock.calls.length;
    const runtime = await ModelRuntime.create({
      credentials: store,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const afterCreate = spy.mock.calls.length;
    const createLocks = afterCreate - beforeCreate;
    expect(createLocks).toBeGreaterThanOrEqual(1);
    expect(createLocks).toBeLessThan(5);
    const beforeRefresh = spy.mock.calls.length;
    await runtime.refresh({ allowNetwork: false });
    const afterRefresh = spy.mock.calls.length;
    const refreshLocks = afterRefresh - beforeRefresh;
    expect(refreshLocks).toBeLessThan(5);
  });
});
