import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./project-store.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-01-01T00:00:00.000Z";

interface FileFingerprintLike {
  path: string;
  pathKey: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface ProjectStoreRepairInternals {
  fingerprintSafeSessionPath(path: string): Promise<FileFingerprintLike>;
}

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "piweb-session-repair-"));
  temporaryDirectories.push(cwd);
  return cwd;
}

function sessionHeader(id = `session-${randomUUID()}`): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd: "",
  })}\n`;
}

function validEntry(id = "entry-1"): string {
  return JSON.stringify({
    type: "custom",
    id,
    parentId: null,
    timestamp,
    customType: "test.entry",
    data: {},
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((cwd) =>
    rm(cwd, { recursive: true, force: true }),
  ));
});

describe("ProjectStore session repair", () => {
  it("opens existing-only without creating missing project state", async () => {
    const cwd = await createWorkspace();
    const stateDir = join(cwd, ".piweb");

    await expect(ProjectStore.open(cwd, { existingOnly: true }))
      .rejects.toMatchObject({ code: "ENOENT" });

    expect(await pathExists(stateDir)).toBe(false);

    await mkdir(stateDir);
    await expect(ProjectStore.open(cwd, { existingOnly: true }))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await pathExists(join(stateDir, "sessions"))).toBe(false);
    expect(await pathExists(join(stateDir, "project.json"))).toBe(false);
  });

  it("diagnoses an abandoned deletion quarantine without recovering or moving it", async () => {
    const cwd = await createWorkspace();
    const store = await ProjectStore.open(cwd);
    const originalName = "missing.jsonl";
    const quarantinePath = join(
      store.sessionDir,
      `.${originalName}.${randomUUID()}.delete-quarantine`,
    );
    await writeFile(quarantinePath, sessionHeader());
    const readOnlyStore = await ProjectStore.open(cwd, { existingOnly: true });

    const report = await readOnlyStore.inspectSessionRepairs();

    expect(report.recoveryError).toContain("Abandoned conversation deletion quarantine");
    expect(await pathExists(quarantinePath)).toBe(true);
    expect(await pathExists(join(store.sessionDir, originalName))).toBe(false);
  });

  it("repairs NUL padding losslessly and stores the exact original bytes", async () => {
    const cwd = await createWorkspace();
    const store = await ProjectStore.open(cwd);
    const filename = "nul-tail.jsonl";
    const entry = validEntry();
    const header = sessionHeader();
    const original = Buffer.concat([
      Buffer.from(header + entry),
      Buffer.from([0, 0, 0]),
    ]);
    const path = join(store.sessionDir, filename);
    await writeFile(path, original);

    const report = await store.inspectSessionRepairs();
    const issue = report.issues.find(({ fileName }) => fileName === filename)!;
    expect(issue.repair).toEqual({
      kind: "remove_zero_tail",
      removedBytes: 3,
      retainedEntries: 1,
    });

    const result = await store.repairSessionFiles([{
      fileName: filename,
      expectedRevision: issue.revision,
    }], false);

    expect(result.error).toBeUndefined();
    expect(result.backups).toHaveLength(1);
    expect(await readFile(path)).toEqual(Buffer.from(`${header}${entry}\n`));
    expect(await readFile(join(cwd, result.backups[0]!.backupPath))).toEqual(original);
  });

  it("requires consent before discarding an incomplete final fragment", async () => {
    const cwd = await createWorkspace();
    const store = await ProjectStore.open(cwd);
    const filename = "partial-tail.jsonl";
    const prefix = `${sessionHeader()}${validEntry()}\n`;
    const original = Buffer.from(prefix + '{"type":"custom","id":');
    const path = join(store.sessionDir, filename);
    const backupDirectory = join(store.stateDir, "session-repair-backups");
    await writeFile(path, original);

    const report = await store.inspectSessionRepairs();
    const issue = report.issues.find(({ fileName }) => fileName === filename)!;
    expect(issue.repair?.kind).toBe("discard_incomplete_tail");

    await expect(store.repairSessionFiles([{
      fileName: filename,
      expectedRevision: issue.revision,
    }], false)).rejects.toThrow("explicit consent");
    expect(await readFile(path)).toEqual(original);
    expect(await pathExists(backupDirectory)).toBe(false);

    const repaired = await store.repairSessionFiles([{
      fileName: filename,
      expectedRevision: issue.revision,
    }], true);
    expect(repaired.error).toBeUndefined();
    expect(await readFile(path)).toEqual(Buffer.from(prefix));
    expect(await readFile(join(cwd, repaired.backups[0]!.backupPath))).toEqual(original);
  });

  it("rejects stale revisions even when replacement bytes are identical", async () => {
    const cwd = await createWorkspace();
    const store = await ProjectStore.open(cwd);
    const filename = "stale.jsonl";
    const original = Buffer.from(`${sessionHeader()}\0`);
    const path = join(store.sessionDir, filename);
    const replacementPath = join(store.sessionDir, ".same-content.tmp");
    await writeFile(path, original);
    const report = await store.inspectSessionRepairs();
    const issue = report.issues.find(({ fileName }) => fileName === filename)!;

    await writeFile(replacementPath, original);
    await unlink(path);
    await rename(replacementPath, path);
    await expect(store.repairSessionFiles([{
      fileName: filename,
      expectedRevision: issue.revision,
    }], false)).rejects.toThrow("revision is stale");

    expect(await readFile(path)).toEqual(original);
    expect(await pathExists(join(store.stateDir, "session-repair-backups"))).toBe(false);
  });

  it("does not authorize either file in a duplicate-header namespace", async () => {
    const cwd = await createWorkspace();
    const store = await ProjectStore.open(cwd);
    const id = `duplicate-${randomUUID()}`;
    const repairableName = "a-repairable.jsonl";
    const healthyName = "b-healthy.jsonl";
    const original = Buffer.from(`${sessionHeader(id)}{"type":"custom","id":`);
    await writeFile(join(store.sessionDir, repairableName), original);
    await writeFile(join(store.sessionDir, healthyName), sessionHeader(id));

    const report = await store.inspectSessionRepairs();
    const duplicates = report.issues.filter(({ conversationId }) => conversationId === id);
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every(({ repair }) => repair === null)).toBe(true);

    await expect(store.repairSessionFiles([{
      fileName: repairableName,
      expectedRevision: duplicates.find(({ fileName }) => fileName === repairableName)!.revision,
    }], true)).rejects.toThrow("no safe repair proposal");
    expect(await readFile(join(store.sessionDir, repairableName))).toEqual(original);
    expect(await pathExists(join(store.stateDir, "session-repair-backups"))).toBe(false);
  });

  it("returns earlier committed backups when a later target changes concurrently", async () => {
    const cwd = await createWorkspace();
    const store = await ProjectStore.open(cwd);
    const firstName = "a-first.jsonl";
    const secondName = "b-second.jsonl";
    const firstHeader = sessionHeader();
    const secondHeader = sessionHeader();
    const firstOriginal = Buffer.from(`${firstHeader}\0`);
    const secondOriginal = Buffer.from(`${secondHeader}\0`);
    const firstPath = join(store.sessionDir, firstName);
    const secondPath = join(store.sessionDir, secondName);
    await writeFile(firstPath, firstOriginal);
    await writeFile(secondPath, secondOriginal);
    const report = await store.inspectSessionRepairs();
    const issues = [firstName, secondName].map((fileName) =>
      report.issues.find((issue) => issue.fileName === fileName)!,
    );

    const internal = store as unknown as ProjectStoreRepairInternals;
    const originalFingerprint = internal.fingerprintSafeSessionPath.bind(store);
    let changedAfterFirstCommit = false;
    vi.spyOn(internal, "fingerprintSafeSessionPath").mockImplementation(async (path) => {
      if (
        path === secondPath
        && !changedAfterFirstCommit
        && (await readFile(firstPath)).equals(Buffer.from(firstHeader))
      ) {
        changedAfterFirstCommit = true;
        await writeFile(secondPath, Buffer.concat([secondOriginal, Buffer.from("changed")]));
      }
      return originalFingerprint(path);
    });

    const result = await store.repairSessionFiles(issues.map(({ fileName, revision }) => ({
      fileName,
      expectedRevision: revision,
    })), false);

    expect(result.error).toContain("changed while it was being read");
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]?.fileName).toBe(firstName);
    expect(await readFile(join(cwd, result.backups[0]!.backupPath))).toEqual(firstOriginal);
    expect(await readFile(firstPath)).toEqual(Buffer.from(firstHeader));
    expect(await readFile(secondPath)).toEqual(Buffer.concat([secondOriginal, Buffer.from("changed")]));
  });

  it("does not replace a source when its backup cannot be created", async () => {
    const cwd = await createWorkspace();
    const store = await ProjectStore.open(cwd);
    const filename = "backup-failure.jsonl";
    const original = Buffer.from(`${sessionHeader()}\0`);
    const path = join(store.sessionDir, filename);
    const backupDirectory = join(store.stateDir, "session-repair-backups");
    await writeFile(path, original);
    await writeFile(backupDirectory, "not a directory");
    const report = await store.inspectSessionRepairs();
    const issue = report.issues.find(({ fileName }) => fileName === filename)!;

    const result = await store.repairSessionFiles([{
      fileName: filename,
      expectedRevision: issue.revision,
    }], false);

    expect(result.error).toBeDefined();
    expect(result.backups).toEqual([]);
    expect(await readFile(path)).toEqual(original);
  });
});
