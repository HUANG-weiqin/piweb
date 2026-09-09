import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReloadResumeDispositions,
  completeReloadTarget,
  readReloadManifest,
  recordReloadTargets,
  reloadTargetsForChild,
} from "./piweb-reload-manifest.mjs";

const REPO_ROOT = "E:\\piweb";
const APP_PORT = 31415;
const REQUEST_ID = "026eb668-6796-4b4a-9ad9-2923596f57b4";
const NEXT_REQUEST_ID = "8eef8297-d7ff-4e61-bba2-289621c1961d";
const CONVERSATION_ID = "0f744403-04e6-49c4-b025-116279708328";
const ADOPTED_RUN_ID = "08acb58d-fec2-47ee-a69f-d17a1e99c825";
const NEXT_ADOPTED_RUN_ID = "ec6283e6-9d52-4744-a09f-5ff99a3e53f4";
const OTHER_CONVERSATION_ID = "f57915ee-a00c-4d92-a202-ec902e329af7";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function manifestPath() {
  const directory = await mkdtemp(join(tmpdir(), "piweb-reload-manifest-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "reload.json");
}

describe("reload manifest v2", () => {
  it("rejects a legacy v1 handoff without changing the file", async () => {
    const path = await manifestPath();
    const legacy = `${JSON.stringify({
      version: 1,
      repoCwd: REPO_ROOT,
      appPort: APP_PORT,
      requestId: REQUEST_ID,
      pending: [{
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        continueTask: true,
      }],
    })}\n`;
    await writeFile(path, legacy, "utf8");

    await expect(readReloadManifest(path, REPO_ROOT, APP_PORT))
      .rejects.toThrow("reload manifest is invalid");
    expect(await readFile(path, "utf8")).toBe(legacy);
  });

  it("retains a stable continuation through a lost response and child reconciliation", async () => {
    const path = await manifestPath();
    await recordReloadTargets(path, REPO_ROOT, APP_PORT, REQUEST_ID, [{
      cwd: REPO_ROOT,
      conversationId: CONVERSATION_ID,
      continueTask: true,
    }]);

    const beforeLostResponse = await readReloadManifest(
      path,
      REPO_ROOT,
      APP_PORT,
    );
    const firstSend = reloadTargetsForChild(beforeLostResponse, true);
    const continuationRunId = firstSend[0].continuationRunId;
    expect(continuationRunId).toMatch(/^[0-9a-f-]{36}$/);

    // No response mutation occurs: a replacement child receives the same
    // durable continuation identity rather than minting another browser run.
    const afterLostResponse = await readReloadManifest(
      path,
      REPO_ROOT,
      APP_PORT,
    );
    expect(reloadTargetsForChild(afterLostResponse, true)[0].continuationRunId)
      .toBe(continuationRunId);

    await applyReloadResumeDispositions(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      firstSend,
      [{
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        disposition: "adopted",
        runId: ADOPTED_RUN_ID,
      }],
    );
    const adopted = await readReloadManifest(path, REPO_ROOT, APP_PORT);
    expect(adopted.targets).toEqual([expect.objectContaining({
      state: "adopted",
      continuationRunId,
      adoptedRunId: ADOPTED_RUN_ID,
    })]);
    expect(reloadTargetsForChild(adopted, false)).toEqual([]);
    const adoptedSnapshot = reloadTargetsForChild(adopted, true);
    expect(adoptedSnapshot).toEqual([{
      cwd: REPO_ROOT,
      conversationId: CONVERSATION_ID,
      continueTask: true,
      continuationRunId,
      adoptedRunId: ADOPTED_RUN_ID,
    }]);

    // A delayed result from the pre-adoption snapshot cannot demote or replace
    // the newer adoption.
    await expect(applyReloadResumeDispositions(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      firstSend,
      [{
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        disposition: "retry",
      }],
    )).resolves.toEqual({ stale: true });
    expect((await readReloadManifest(path, REPO_ROOT, APP_PORT)).targets[0])
      .toMatchObject({ state: "adopted", adoptedRunId: ADOPTED_RUN_ID });

    await applyReloadResumeDispositions(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      adoptedSnapshot,
      [{
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        disposition: "retry",
      }],
    );
    const retrying = await readReloadManifest(path, REPO_ROOT, APP_PORT);
    expect(retrying.targets).toEqual([expect.objectContaining({
      state: "unadopted",
      continuationRunId,
    })]);
    expect(retrying.targets[0]).not.toHaveProperty("adoptedRunId");
    const retrySend = reloadTargetsForChild(retrying, false);
    expect(retrySend).toHaveLength(1);
    await applyReloadResumeDispositions(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      retrySend,
      [{
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        disposition: "adopted",
        runId: NEXT_ADOPTED_RUN_ID,
      }],
    );

    await recordReloadTargets(path, REPO_ROOT, APP_PORT, NEXT_REQUEST_ID, [{
      cwd: REPO_ROOT,
      conversationId: CONVERSATION_ID,
      continueTask: true,
    }]);
    const merged = await readReloadManifest(path, REPO_ROOT, APP_PORT);
    expect(merged.requestId).toBe(REQUEST_ID);
    expect(merged.targets[0]).toMatchObject({
      continuationRunId,
      adoptedRunId: NEXT_ADOPTED_RUN_ID,
    });
  });

  it("rejects a partial disposition set without changing target state", async () => {
    const path = await manifestPath();
    await recordReloadTargets(path, REPO_ROOT, APP_PORT, REQUEST_ID, [
      {
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        continueTask: true,
      },
      {
        cwd: REPO_ROOT,
        conversationId: OTHER_CONVERSATION_ID,
        continueTask: false,
      },
    ]);
    const manifest = await readReloadManifest(path, REPO_ROOT, APP_PORT);
    const sent = reloadTargetsForChild(manifest, true);

    await expect(applyReloadResumeDispositions(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      sent,
      [{
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        disposition: "adopted",
        runId: ADOPTED_RUN_ID,
      }],
    )).rejects.toThrow("exact reload target set");

    const unchanged = await readReloadManifest(path, REPO_ROOT, APP_PORT);
    expect(unchanged.targets.map(({ state }) => state)).toEqual([
      "unadopted",
      "unadopted",
    ]);
  });

  it("removes a terminal unadopted target after exact reconciliation", async () => {
    const path = await manifestPath();
    await recordReloadTargets(path, REPO_ROOT, APP_PORT, REQUEST_ID, [{
      cwd: REPO_ROOT,
      conversationId: CONVERSATION_ID,
      continueTask: true,
    }]);

    const manifest = await readReloadManifest(path, REPO_ROOT, APP_PORT);
    const sent = reloadTargetsForChild(manifest, false);
    await expect(applyReloadResumeDispositions(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      sent,
      [{
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        disposition: "completed",
      }],
    )).resolves.toMatchObject({
      stale: false,
      manifest: { targets: [] },
    });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores stale completion identity and unlinks only the exact completed target", async () => {
    const path = await manifestPath();
    await recordReloadTargets(path, REPO_ROOT, APP_PORT, REQUEST_ID, [{
      cwd: REPO_ROOT,
      conversationId: CONVERSATION_ID,
      continueTask: false,
    }]);

    const manifest = await readReloadManifest(path, REPO_ROOT, APP_PORT);
    const sent = reloadTargetsForChild(manifest, true);
    await expect(completeReloadTarget(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      {
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        runId: ADOPTED_RUN_ID,
      },
    )).resolves.toBe(false);
    await applyReloadResumeDispositions(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      sent,
      [{
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        disposition: "adopted",
        runId: ADOPTED_RUN_ID,
      }],
    );

    await expect(completeReloadTarget(
      path,
      REPO_ROOT,
      APP_PORT,
      NEXT_REQUEST_ID,
      {
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        runId: ADOPTED_RUN_ID,
      },
    )).resolves.toBe(false);
    await expect(completeReloadTarget(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      {
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        runId: NEXT_ADOPTED_RUN_ID,
      },
    )).resolves.toBe(false);
    await expect(access(path)).resolves.toBeUndefined();

    await expect(completeReloadTarget(
      path,
      REPO_ROOT,
      APP_PORT,
      REQUEST_ID,
      {
        cwd: REPO_ROOT,
        conversationId: CONVERSATION_ID,
        runId: ADOPTED_RUN_ID,
      },
    )).resolves.toBe(true);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
