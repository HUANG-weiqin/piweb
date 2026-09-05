import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function targetKey(target) {
  return JSON.stringify([target.cwd, target.conversationId]);
}

export function isPreparedReloadTargets(value) {
  return Array.isArray(value) && value.every((target) => (
    isRecord(target)
    && hasOnlyKeys(target, ["cwd", "conversationId", "continueTask"])
    && typeof target.cwd === "string"
    && target.cwd.length > 0
    && isUuid(target.conversationId)
    && typeof target.continueTask === "boolean"
  ));
}

function isManifestTarget(target) {
  if (
    !isRecord(target)
    || !hasOnlyKeys(target, [
      "cwd",
      "conversationId",
      "continueTask",
      "state",
      "continuationRunId",
      "adoptedRunId",
    ])
    || typeof target.cwd !== "string"
    || target.cwd.length === 0
    || !isUuid(target.conversationId)
    || typeof target.continueTask !== "boolean"
    || (target.state !== "unadopted" && target.state !== "adopted")
    || (target.continueTask && !isUuid(target.continuationRunId))
    || (!target.continueTask && target.continuationRunId !== undefined)
    || (target.state === "adopted" && !isUuid(target.adoptedRunId))
    || (target.state === "unadopted" && target.adoptedRunId !== undefined)
  ) return false;
  return true;
}

export function isReloadResumeDispositions(value) {
  return Array.isArray(value) && value.every((result) => {
    if (
      !isRecord(result)
      || typeof result.cwd !== "string"
      || result.cwd.length === 0
      || !isUuid(result.conversationId)
    ) return false;
    if (result.disposition === "adopted") {
      return hasOnlyKeys(result, [
        "cwd",
        "conversationId",
        "disposition",
        "runId",
      ]) && isUuid(result.runId);
    }
    return (
      result.disposition === "completed"
      || result.disposition === "retry"
    ) && hasOnlyKeys(result, ["cwd", "conversationId", "disposition"]);
  });
}

function isReloadManifest(value, repoRoot, appPort) {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "version",
      "repoCwd",
      "appPort",
      "requestId",
      "targets",
    ])
    && value.version === 2
    && value.repoCwd === repoRoot
    && value.appPort === appPort
    && isUuid(value.requestId)
    && Array.isArray(value.targets)
    && value.targets.every(isManifestTarget)
    && new Set(value.targets.map(targetKey)).size === value.targets.length;
}

function isLegacyReloadManifest(value, repoRoot, appPort) {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "version",
      "repoCwd",
      "appPort",
      "requestId",
      "pending",
    ])
    && value.version === 1
    && value.repoCwd === repoRoot
    && value.appPort === appPort
    && isUuid(value.requestId)
    && isPreparedReloadTargets(value.pending)
    && new Set(value.pending.map(targetKey)).size === value.pending.length;
}

export async function readReloadManifest(path, repoRoot, appPort) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (isReloadManifest(value, repoRoot, appPort)) return value;
  if (!isLegacyReloadManifest(value, repoRoot, appPort)) {
    throw new Error("The Pi Web reload manifest is invalid.");
  }

  // A v1 pending target had no adoption identity. Persist its v2
  // continuation identity before exposing it to a child so every later read
  // observes the same crash-safe handoff authority.
  const manifest = {
    version: 2,
    repoCwd: value.repoCwd,
    appPort: value.appPort,
    requestId: value.requestId,
    targets: mergeTargets([], value.pending),
  };
  if (manifest.targets.length === 0) {
    await rm(path, { force: true });
    return undefined;
  }
  await writeReloadManifest(path, manifest);
  return manifest;
}

function mergeTargets(previous, current) {
  const targets = new Map(previous.map((target) => [targetKey(target), target]));
  for (const target of current) {
    const key = targetKey(target);
    const existing = targets.get(key);
    if (!existing) {
      targets.set(key, {
        ...target,
        state: "unadopted",
        ...(target.continueTask
          ? { continuationRunId: randomUUID() }
          : {}),
      });
      continue;
    }
    if (target.continueTask && !existing.continueTask) {
      targets.set(key, {
        ...existing,
        continueTask: true,
        state: "unadopted",
        continuationRunId: randomUUID(),
        adoptedRunId: undefined,
      });
    }
  }
  return [...targets.values()].map((target) => {
    if (target.adoptedRunId !== undefined) return target;
    const { adoptedRunId: _adoptedRunId, ...withoutAdoptedRunId } = target;
    return withoutAdoptedRunId;
  });
}

export async function recordReloadTargets(
  path,
  repoRoot,
  appPort,
  requestId,
  current,
) {
  if (!isUuid(requestId) || !isPreparedReloadTargets(current)) {
    throw new Error("The server child returned invalid reload targets.");
  }
  const previous = await readReloadManifest(path, repoRoot, appPort);
  const manifest = {
    version: 2,
    repoCwd: repoRoot,
    appPort,
    requestId: previous?.requestId ?? requestId,
    targets: mergeTargets(previous?.targets ?? [], current),
  };
  await replaceReloadManifest(path, manifest);
  return manifest;
}

function targetForChild(target) {
  return {
    cwd: target.cwd,
    conversationId: target.conversationId,
    continueTask: target.continueTask,
    ...(target.continuationRunId === undefined
      ? {}
      : { continuationRunId: target.continuationRunId }),
    ...(target.adoptedRunId === undefined
      ? {}
      : { adoptedRunId: target.adoptedRunId }),
  };
}

export function reloadTargetsForChild(manifest, includeAdopted) {
  return manifest.targets
    .filter((target) => includeAdopted || target.state === "unadopted")
    .map(targetForChild);
}

function matchesSentTarget(current, sent) {
  const snapshot = targetForChild(current);
  return snapshot.cwd === sent.cwd
    && snapshot.conversationId === sent.conversationId
    && snapshot.continueTask === sent.continueTask
    && snapshot.continuationRunId === sent.continuationRunId
    && snapshot.adoptedRunId === sent.adoptedRunId;
}

export async function applyReloadResumeDispositions(
  path,
  repoRoot,
  appPort,
  requestId,
  sentTargets,
  dispositions,
) {
  if (!isReloadResumeDispositions(dispositions)) {
    throw new Error("The server child returned invalid reload dispositions.");
  }
  const manifest = await readReloadManifest(path, repoRoot, appPort);
  if (!manifest || manifest.requestId !== requestId) return { stale: true };

  const sentKeys = new Set(sentTargets.map(targetKey));
  const results = new Map(dispositions.map((result) => [targetKey(result), result]));
  if (
    sentKeys.size !== sentTargets.length
    || results.size !== dispositions.length
    || results.size !== sentKeys.size
    || [...results.keys()].some((key) => !sentKeys.has(key))
  ) {
    throw new Error("The server child did not reconcile the exact reload target set.");
  }

  const current = new Map(manifest.targets.map((target) => [targetKey(target), target]));
  if (sentTargets.some((sent) => {
    const target = current.get(targetKey(sent));
    return !target || !matchesSentTarget(target, sent);
  })) {
    return { stale: true };
  }

  const targets = [];
  for (const target of manifest.targets) {
    const result = results.get(targetKey(target));
    if (!result) {
      targets.push(target);
    } else if (result.disposition === "adopted") {
      targets.push({
        ...target,
        state: "adopted",
        adoptedRunId: result.runId,
      });
    } else if (result.disposition === "retry") {
      const { adoptedRunId: _adoptedRunId, ...withoutAdoptedRunId } = target;
      targets.push({ ...withoutAdoptedRunId, state: "unadopted" });
    }
  }
  await replaceReloadManifest(path, { ...manifest, targets });
  return { stale: false, manifest: { ...manifest, targets } };
}

export async function completeReloadTarget(
  path,
  repoRoot,
  appPort,
  requestId,
  target,
) {
  const manifest = await readReloadManifest(path, repoRoot, appPort);
  if (!manifest || manifest.requestId !== requestId) return false;
  const key = targetKey(target);
  const targets = manifest.targets.filter((candidate) => !(
    targetKey(candidate) === key
    && candidate.state === "adopted"
    && candidate.adoptedRunId === target.runId
  ));
  if (targets.length === manifest.targets.length) return false;
  await replaceReloadManifest(path, { ...manifest, targets });
  return true;
}

async function replaceReloadManifest(path, manifest) {
  if (manifest.targets.length === 0) {
    await rm(path, { force: true });
  } else {
    await writeReloadManifest(path, manifest);
  }
}

async function writeReloadManifest(path, manifest) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    try {
      await chmod(path, 0o600);
    } catch {
      // Windows may not enforce POSIX modes.
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
