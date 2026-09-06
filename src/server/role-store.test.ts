import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ROLE_COUNT,
  MAX_ROLE_DESCRIPTION_CHARACTERS,
  MAX_ROLE_NAME_CHARACTERS,
  MAX_ROLE_SYSTEM_PROMPT_BYTES,
  ROLE_STORE_VERSION,
  RoleStore,
  type RoleDraft,
  type RoleModelReference,
  type RoleTemplateV1,
} from "./role-store.js";

const temporaryDirectories: string[] = [];
const initialModel: RoleModelReference = {
  provider: "test-provider",
  id: "test-model",
};

async function createRolesPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "piweb", "roles.json");
}

function draft(
  name: string,
  overrides: Partial<RoleDraft> = {},
): RoleDraft {
  return {
    name,
    description: "",
    systemPrompt: "",
    model: initialModel,
    compactionModel: null,
    defaultThinkingLevel: "off",
    defaultServiceTier: null,
    toolMode: "read_only",
    canManageSessions: false,
    ...overrides,
  };
}

function persistedDefault(
  overrides: Partial<RoleTemplateV1> = {},
): RoleTemplateV1 {
  return {
    id: "default",
    revision: 1,
    name: "默认",
    description: "默认角色",
    systemPrompt: "",
    model: initialModel,
    compactionModel: null,
    defaultThinkingLevel: "off",
    defaultServiceTier: null,
    toolMode: "read_only",
    canManageSessions: false,
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
    ...overrides,
  };
}

function persistedRole(role: RoleTemplateV1) {
  return {
    id: role.id,
    revision: role.revision,
    name: role.name,
    description: role.description,
    systemPromptFile: `role-prompts/${role.id}.${role.revision}.md`,
    model: role.model,
    compactionModel: role.compactionModel,
    defaultThinkingLevel: role.defaultThinkingLevel,
    defaultServiceTier: role.defaultServiceTier,
    toolMode: role.toolMode,
    canManageSessions: role.canManageSessions,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

function withoutServiceTier(role: RoleTemplateV1) {
  const {
    compactionModel: _compactionModel,
    defaultServiceTier: _defaultServiceTier,
    ...legacy
  } = role;
  return legacy;
}

function withoutPersistedServiceTier(role: RoleTemplateV1) {
  const {
    compactionModel: _compactionModel,
    defaultServiceTier: _defaultServiceTier,
    ...legacy
  } = persistedRole(role);
  return legacy;
}

function withoutPersistedCompactionModel(role: RoleTemplateV1) {
  const { compactionModel: _compactionModel, ...legacy } = persistedRole(role);
  return legacy;
}

function promptPath(rolesPath: string, role: RoleTemplateV1): string {
  return join(
    dirname(rolesPath),
    "role-prompts",
    `${role.id}.${role.revision}.md`,
  );
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("RoleStore", () => {
  it("creates and reopens the stable default role with an injected initial model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"));
    const rolesPath = await createRolesPath("piweb-role-store-default-");
    const mutableModel = { ...initialModel };

    const store = await RoleStore.open(rolesPath, mutableModel);
    mutableModel.id = "mutated-after-open";

    expect(store.listRoles()).toEqual([persistedDefault()]);
    expect(store.getRole("default")).toMatchObject({
      id: "default",
      revision: 1,
      model: initialModel,
    });

    const persisted = JSON.parse(await readFile(rolesPath, "utf8")) as unknown;
    expect(persisted).toEqual({
      version: ROLE_STORE_VERSION,
      roles: [persistedRole(persistedDefault())],
    });
    await expect(
      readFile(promptPath(rolesPath, persistedDefault()), "utf8"),
    ).resolves.toBe("");

    const reopened = await RoleStore.open(rolesPath, {
      provider: "ignored",
      id: "ignored",
    });
    expect(reopened.listRoles()).toEqual([persistedDefault()]);
  });

  it("migrates the untouched v1 default copy without overwriting later edits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T11:00:00.000Z"));
    const rolesPath = await createRolesPath("piweb-role-store-v1-default-");
    await mkdir(dirname(rolesPath), { recursive: true });
    await writeFile(rolesPath, `${JSON.stringify({
      version: 1,
      roles: [withoutServiceTier(persistedDefault({
        revision: 3,
        name: "Default",
        description: "",
      }))],
    }, null, 2)}\n`, "utf8");

    const store = await RoleStore.open(rolesPath, initialModel);

    expect(store.getRole("default")).toEqual(persistedDefault({
      revision: 4,
      updatedAt: "2026-07-19T11:00:00.000Z",
    }));
    const migratedDefault = persistedDefault({
      revision: 4,
      updatedAt: "2026-07-19T11:00:00.000Z",
    });
    expect(JSON.parse(await readFile(rolesPath, "utf8"))).toEqual({
      version: ROLE_STORE_VERSION,
      roles: [persistedRole(migratedDefault)],
    });
    await expect(
      readFile(promptPath(rolesPath, migratedDefault), "utf8"),
    ).resolves.toBe("");

    const editedRolesPath = await createRolesPath(
      "piweb-role-store-v1-edited-default-",
    );
    await mkdir(dirname(editedRolesPath), { recursive: true });
    const editedDefault = persistedDefault({
      name: "General",
      description: "",
    });
    await writeFile(editedRolesPath, `${JSON.stringify({
      version: 1,
      roles: [withoutServiceTier(editedDefault)],
    }, null, 2)}\n`, "utf8");

    const editedStore = await RoleStore.open(editedRolesPath, initialModel);
    expect(editedStore.getRole("default")).toEqual(editedDefault);
  });

  it("migrates v4 prompts byte-for-byte and reopens the v5 store", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-v4-prompt-");
    const systemPrompt = "\uFEFF  first line\r\nsecond line with é\n\u0000trailing  ";
    const legacyRole = persistedDefault({
      revision: 7,
      systemPrompt,
      updatedAt: "2026-07-19T10:01:00.000Z",
    });
    await mkdir(dirname(rolesPath), { recursive: true });
    await writeFile(rolesPath, `${JSON.stringify({
      version: 4,
      roles: [withoutServiceTier(legacyRole)],
    }, null, 2)}\n`, "utf8");

    const store = await RoleStore.open(rolesPath, initialModel);

    expect(store.listRoles()).toEqual([legacyRole]);
    expect(JSON.parse(await readFile(rolesPath, "utf8"))).toEqual({
      version: ROLE_STORE_VERSION,
      roles: [persistedRole(legacyRole)],
    });
    await expect(
      readFile(promptPath(rolesPath, legacyRole), "utf8"),
    ).resolves.toBe(systemPrompt);

    const reopened = await RoleStore.open(rolesPath, initialModel);
    expect(reopened.getRole("default")).toEqual(legacyRole);
  });

  it("migrates a v5 manifest default service tier without rewriting its prompt", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-v5-tier-");
    const role = persistedDefault({ systemPrompt: "external prompt" });
    await mkdir(join(dirname(rolesPath), "role-prompts"), { recursive: true });
    const rolePromptPath = promptPath(rolesPath, role);
    await writeFile(rolePromptPath, role.systemPrompt, "utf8");
    const promptIdentity = await stat(rolePromptPath, { bigint: true });
    await writeFile(rolesPath, `${JSON.stringify({
      version: 5,
      roles: [withoutPersistedServiceTier(role)],
    }, null, 2)}\n`, "utf8");

    const store = await RoleStore.open(rolesPath, initialModel);

    expect(store.getRole("default")?.defaultServiceTier).toBeNull();
    expect(store.getRole("default")?.compactionModel).toBeNull();
    expect(JSON.parse(await readFile(rolesPath, "utf8"))).toEqual({
      version: ROLE_STORE_VERSION,
      roles: [persistedRole(role)],
    });
    await expect(readFile(rolePromptPath, "utf8"))
      .resolves.toBe("external prompt");
    const migratedPromptIdentity = await stat(rolePromptPath, { bigint: true });
    expect({
      dev: migratedPromptIdentity.dev,
      ino: migratedPromptIdentity.ino,
    }).toEqual({
      dev: promptIdentity.dev,
      ino: promptIdentity.ino,
    });
  });

  it("migrates a v6 manifest compaction model without changing role revision", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-v6-compactor-");
    const role = persistedDefault({
      revision: 7,
      systemPrompt: "external prompt",
      updatedAt: "2026-07-19T10:01:00.000Z",
    });
    await mkdir(join(dirname(rolesPath), "role-prompts"), { recursive: true });
    await writeFile(promptPath(rolesPath, role), role.systemPrompt, "utf8");
    await writeFile(rolesPath, `${JSON.stringify({
      version: 6,
      roles: [withoutPersistedCompactionModel(role)],
    }, null, 2)}\n`, "utf8");

    const store = await RoleStore.open(rolesPath, initialModel);

    expect(store.getRole("default")).toEqual({
      ...role,
      compactionModel: null,
    });
    expect(JSON.parse(await readFile(rolesPath, "utf8"))).toEqual({
      version: ROLE_STORE_VERSION,
      roles: [persistedRole({ ...role, compactionModel: null })],
    });
  });

  it("reads an externally edited prompt on every public read", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-external-prompt-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const role = persistedDefault();
    const promptFile = promptPath(rolesPath, role);

    await writeFile(promptFile, "edited outside the store", "utf8");

    expect(store.listRoles()[0]?.systemPrompt).toBe("edited outside the store");
    expect(store.getRole("default")?.systemPrompt).toBe("edited outside the store");
  });

  it("rejects role IDs that differ only by case in every supported store version", async () => {
    const id = "f23db1e6-c657-4dac-8b7e-a14fdecc5f21";
    const lower = persistedDefault({ id, name: "Lower" });
    const upper = persistedDefault({ id: id.toUpperCase(), name: "Upper" });

    for (const version of [1, 2, 3, 4, ROLE_STORE_VERSION]) {
      const rolesPath = await createRolesPath(
        `piweb-role-store-case-id-${version}-`,
      );
      await mkdir(dirname(rolesPath), { recursive: true });
      if (version === ROLE_STORE_VERSION) {
        await mkdir(join(dirname(rolesPath), "role-prompts"), {
          recursive: true,
        });
        await writeFile(promptPath(rolesPath, lower), lower.systemPrompt);
        await writeFile(promptPath(rolesPath, upper), upper.systemPrompt);
      }
      const raw = `${JSON.stringify({
        version,
        roles: version === ROLE_STORE_VERSION
          ? [persistedRole(lower), persistedRole(upper)]
          : [withoutServiceTier(lower), withoutServiceTier(upper)],
      }, null, 2)}\n`;
      await writeFile(rolesPath, raw, "utf8");

      await expect(RoleStore.open(rolesPath, initialModel)).rejects.toThrow(
        "duplicate role id",
      );
      await expect(readFile(rolesPath, "utf8")).resolves.toBe(raw);
    }
  });

  it("rejects a stale prompt base and saves after reloading the current prompt", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-prompt-conflict-");
    const store = await RoleStore.open(rolesPath, initialModel);
    await writeFile(promptPath(rolesPath, persistedDefault()), "B", "utf8");

    await expect(
      store.updateRole("default", 1, "", draft("Saved", {
        systemPrompt: "C",
      })),
    ).rejects.toThrow("Role system prompt changed");
    expect(store.getRole("default")).toMatchObject({
      revision: 1,
      systemPrompt: "B",
    });

    await expect(
      store.updateRole("default", 1, "B", draft("Saved", {
        systemPrompt: "C",
      })),
    ).resolves.toMatchObject({
      revision: 2,
      name: "Saved",
      systemPrompt: "C",
    });
  });

  it("rejects an aborted role update before committing", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-aborted-update-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const before = store.listRoles();
    const controller = new AbortController();
    controller.abort();

    await expect(
      store.updateRole(
        "default",
        1,
        "",
        draft("Must not commit", { systemPrompt: "Must not commit" }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(store.listRoles()).toEqual(before);
    expect(await readFile(rolesPath, "utf8")).toContain("default.1.md");
  });

  it("keeps a model-less default when no initial model is available", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-no-model-");

    const store = await RoleStore.open(rolesPath, null);

    expect(store.getRole("default")?.model).toBeNull();
  });

  it("defaults legacy role behavior closed", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-legacy-capability-");
    await mkdir(dirname(rolesPath), { recursive: true });
    const legacyRole = persistedDefault();
    const {
      canManageSessions: _omittedCapability,
      toolMode: _omittedToolMode,
      compactionModel: _omittedCompactionModel,
      defaultThinkingLevel: _omittedThinkingLevel,
      defaultServiceTier: _omittedServiceTier,
      ...legacyFields
    } = legacyRole;
    await writeFile(rolesPath, `${JSON.stringify({
      version: 2,
      roles: [legacyFields],
    }, null, 2)}\n`, "utf8");

    const store = await RoleStore.open(rolesPath, null);

    expect(store.getRole("default")?.canManageSessions).toBe(false);
    expect(store.getRole("default")?.toolMode).toBe("read_only");
    expect(store.getRole("default")?.defaultThinkingLevel).toBe("off");
    expect(store.getRole("default")?.compactionModel).toBeNull();
    expect(store.getRole("default")?.defaultServiceTier).toBeNull();
    expect(JSON.parse(await readFile(rolesPath, "utf8"))).toMatchObject({
      version: ROLE_STORE_VERSION,
      roles: [{
        defaultThinkingLevel: "off",
        defaultServiceTier: null,
        toolMode: "read_only",
      }],
    });
  });

  it("allows editing and deleting the seeded role without recreating it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"));
    const rolesPath = await createRolesPath("piweb-role-store-edit-default-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const before = store.getRole("default")!;
    expect(await readdir(join(dirname(rolesPath), "role-prompts"))).toEqual([
      "default.1.md",
    ]);

    vi.setSystemTime(new Date("2026-07-19T11:00:00.000Z"));
    const updated = await store.updateRole("default", 1, "", {
      name: "General",
      description: "General purpose",
      systemPrompt: "Be concise.",
      model: { provider: "other-provider", id: "other-model" },
      compactionModel: null,
      defaultThinkingLevel: "high",
      defaultServiceTier: "priority",
      toolMode: "read_only",
      canManageSessions: false,
    });

    expect(updated).toEqual({
      ...before,
      revision: 2,
      name: "General",
      description: "General purpose",
      systemPrompt: "Be concise.",
      model: { provider: "other-provider", id: "other-model" },
      defaultThinkingLevel: "high",
      defaultServiceTier: "priority",
      canManageSessions: false,
      updatedAt: "2026-07-19T11:00:00.000Z",
    });
    expect(store.listRoles()).toHaveLength(1);
    await expect(
      readFile(promptPath(rolesPath, persistedDefault({ revision: 2 })), "utf8"),
    ).resolves.toBe("Be concise.");
    await expect(
      readdir(join(dirname(rolesPath), "role-prompts")),
    ).resolves.toEqual(["default.2.md"]);

    await store.deleteRole("default", updated.revision);
    expect(store.listRoles()).toEqual([]);
    await expect(
      readdir(join(dirname(rolesPath), "role-prompts")),
    ).resolves.toEqual([]);

    const reopened = await RoleStore.open(rolesPath, null);
    expect(reopened.listRoles()).toEqual([]);
  });

  it("creates UUID roles and enforces case-insensitive unique names", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-names-");
    const store = await RoleStore.open(rolesPath, initialModel);

    const created = await store.createRole(draft("Reviewer"));

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(created.revision).toBe(1);
    await expect(store.createRole(draft(" reviewer "))).rejects.toThrow(
      "Role name already exists",
    );
    await expect(
      store.updateRole("default", 1, "", draft("REVIEWER")),
    ).rejects.toThrow("Role name already exists");

    await store.deleteRole(created.id, created.revision);
    await expect(store.createRole(draft("REVIEWER"))).resolves.toMatchObject({
      name: "REVIEWER",
      revision: 1,
    });
  });

  it("serializes concurrent writes and publishes only committed snapshots", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-serial-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const publishedRevisions: number[] = [];
    const listener = vi.fn(() => {
      publishedRevisions.push(store.getRole("default")!.revision);
    });
    const unsubscribe = store.subscribe(listener);

    const first = store.updateRole("default", 1, "", draft("First"));
    const firstResult = await first;
    const secondResult = await store.updateRole("default", 2, "", draft("Second"));

    expect(firstResult.revision).toBe(2);
    expect(secondResult.revision).toBe(3);
    expect(store.getRole("default")).toMatchObject({
      name: "Second",
      revision: 3,
    });
    expect(publishedRevisions).toEqual([2, 3]);

    await store.updateRole("default", 3, "", draft("Second"));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await store.updateRole("default", 3, "", draft("Third"));
    expect(listener).toHaveBeenCalledTimes(2);

    const persisted = JSON.parse(await readFile(rolesPath, "utf8")) as {
      roles: Array<Record<string, unknown>>;
    };
    expect(persisted.roles[0]).toMatchObject({
      name: "Third",
      revision: 4,
    });
    expect((await readdir(dirname(rolesPath))).sort()).toEqual([
      "role-prompts",
      "roles.json",
    ]);
    expect(await readdir(join(dirname(rolesPath), "role-prompts"))).toEqual([
      "default.4.md",
    ]);
  });

  it("does not publish or mutate memory when the atomic replacement fails", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-atomic-fail-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.listRoles();

    await unlink(rolesPath);
    await mkdir(rolesPath);

    await expect(
      store.updateRole("default", 1, "", draft("Must not commit")),
    ).rejects.toThrow();
    expect(store.listRoles()).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
    expect((await readdir(dirname(rolesPath))).sort()).toEqual([
      "role-prompts",
      "roles.json",
    ]);
    expect(await readdir(join(dirname(rolesPath), "role-prompts"))).toEqual([
      "default.1.md",
      "default.2.md",
    ]);
  });

  it("recovers a prompt orphan left by a failed manifest commit on reopen", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-orphan-recovery-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const originalManifest = await readFile(rolesPath, "utf8");
    await writeFile(
      join(dirname(rolesPath), "role-prompts", "default.42.md"),
      "orphan",
      "utf8",
    );
    await writeFile(
      join(dirname(rolesPath), "role-prompts", "default.01.md"),
      "keep",
      "utf8",
    );
    await mkdir(join(dirname(rolesPath), "role-prompts", "default.43.md"));
    await writeFile(
      join(dirname(rolesPath), "role-prompts", "notes.md"),
      "keep",
      "utf8",
    );
    if (process.platform === "linux") {
      await writeFile(
        join(dirname(rolesPath), "role-prompts", "DEFAULT.1.md"),
        "case-variant orphan",
        "utf8",
      );
    }

    await unlink(rolesPath);
    await mkdir(rolesPath);
    await expect(
      store.updateRole("default", 1, "", draft("Orphaned")),
    ).rejects.toThrow();
    expect(await readdir(join(dirname(rolesPath), "role-prompts"))).toContain(
      "default.2.md",
    );

    await rm(rolesPath, { force: true, recursive: true });
    await writeFile(rolesPath, originalManifest, "utf8");
    await expect(RoleStore.open(rolesPath, initialModel)).resolves.toBeDefined();

    const remaining = (await readdir(
      join(dirname(rolesPath), "role-prompts"),
    )).sort();
    expect(remaining).toEqual([
      "default.01.md",
      "default.1.md",
      "default.43.md",
      "notes.md",
    ]);
  });

  it("does not publish or mutate memory when prompt replacement fails", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-prompt-fail-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const before = store.listRoles();
    const blockedPromptPath = promptPath(
      rolesPath,
      persistedDefault({ revision: 2 }),
    );
    await mkdir(blockedPromptPath);

    await expect(
      store.updateRole("default", 1, "", draft("Prompt write failure")),
    ).rejects.toThrow();
    expect(store.listRoles()).toEqual(before);
    expect(await readFile(rolesPath, "utf8")).toContain("default.1.md");
  });

  it("commits deletion when best-effort prompt cleanup cannot remove the file", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-delete-cleanup-");
    const store = await RoleStore.open(rolesPath, initialModel);
    await unlink(promptPath(rolesPath, persistedDefault()));

    await expect(store.deleteRole("default", 1)).resolves.toBeUndefined();
    expect(store.listRoles()).toEqual([]);
    await expect(RoleStore.open(rolesPath, null)).resolves.toBeDefined();
  });

  it("enforces role capacity and text limits without silently truncating", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-limits-");
    const store = await RoleStore.open(rolesPath, initialModel);

    await expect(
      store.createRole(draft("x".repeat(MAX_ROLE_NAME_CHARACTERS + 1))),
    ).rejects.toThrow("name");
    await expect(
      store.createRole(draft("Description", {
        description: "x".repeat(MAX_ROLE_DESCRIPTION_CHARACTERS + 1),
      })),
    ).rejects.toThrow("description");
    await expect(
      store.createRole(draft("Missing provider", {
        model: { provider: " ", id: "model" },
      })),
    ).rejects.toThrow("provider");
    await expect(
      store.createRole(draft("Missing model ID", {
        model: { provider: "provider", id: "" },
      })),
    ).rejects.toThrow("model.id");

    const exactPrompt = "é".repeat(MAX_ROLE_SYSTEM_PROMPT_BYTES / 2);
    await expect(
      store.updateRole("default", 1, "", draft("Default", {
        systemPrompt: exactPrompt,
      })),
    ).resolves.toMatchObject({ systemPrompt: exactPrompt });
    await expect(
      store.updateRole("default", 2, exactPrompt, draft("Default", {
        systemPrompt: `${exactPrompt}é`,
      })),
    ).rejects.toThrow("systemPrompt");

    await Promise.all(
      Array.from(
        { length: MAX_ROLE_COUNT - 1 },
        (_, index) => store.createRole(draft(`Role ${index + 1}`)),
      ),
    );
    expect(store.listRoles()).toHaveLength(MAX_ROLE_COUNT);
    await expect(store.createRole(draft("One too many"))).rejects.toThrow(
      `at most ${MAX_ROLE_COUNT} roles`,
    );
  });

  it("returns defensive copies to callers and subscribers", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-clones-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const listed = store.listRoles();
    const fetched = store.getRole("default")!;

    listed[0]!.name = "mutated list";
    fetched.name = "mutated role";
    fetched.model!.id = "mutated model";

    expect(store.getRole("default")).toMatchObject({
      name: "默认",
      model: initialModel,
    });
  });

  it("fails closed on invalid v5 prompt references and files", async () => {
    for (const kind of [
      "missing",
      "invalid-utf8",
      "oversize",
      "symlink",
      "directory",
      "path-traversal",
    ] as const) {
      const rolesPath = await createRolesPath(
        `piweb-role-store-v5-prompt-${kind}-`,
      );
      const role = persistedDefault();
      const manifest = withoutPersistedServiceTier(role) as Record<
        string,
        unknown
      >;
      await mkdir(dirname(rolesPath), { recursive: true });
      const promptDirectory = join(dirname(rolesPath), "role-prompts");
      await mkdir(promptDirectory, { recursive: true });
      if (kind === "path-traversal") {
        manifest.systemPromptFile = "role-prompts/../outside.md";
      }
      const raw = `${JSON.stringify({
        version: 5,
        roles: [manifest],
      }, null, 2)}\n`;
      await writeFile(rolesPath, raw, "utf8");

      const file = promptPath(rolesPath, role);
      if (kind === "invalid-utf8") {
        await writeFile(file, Buffer.from([0xff, 0xfe]));
      } else if (kind === "oversize") {
        await writeFile(file, Buffer.alloc(MAX_ROLE_SYSTEM_PROMPT_BYTES + 1, 0x61));
      } else if (kind === "symlink") {
        const outside = join(dirname(rolesPath), "outside.md");
        await writeFile(outside, "outside", "utf8");
        try {
          await symlink(outside, file);
        } catch (error) {
          if (
            process.platform === "win32"
            && error instanceof Error
            && "code" in error
            && ((error as NodeJS.ErrnoException).code === "EPERM"
              || (error as NodeJS.ErrnoException).code === "EACCES")
          ) {
            continue;
          }
          throw error;
        }
      } else if (kind === "directory") {
        await mkdir(file);
      }

      await expect(RoleStore.open(rolesPath, initialModel)).rejects.toThrow();
      await expect(readFile(rolesPath, "utf8")).resolves.toBe(raw);
    }
  });

  it("fails closed on corrupt, unknown, or structurally invalid v1 files", async () => {
    const {
      defaultThinkingLevel: _omittedThinkingLevel,
      ...missingThinkingLevel
    } = persistedDefault();
    const {
      compactionModel: _omittedCompactionModel,
      ...missingCompactionModel
    } = persistedRole(persistedDefault());
    const invalidDocuments: unknown[] = [
      "{",
      { version: 5, roles: [persistedDefault()] },
      { version: ROLE_STORE_VERSION, roles: [missingThinkingLevel] },
      { version: ROLE_STORE_VERSION, roles: [missingCompactionModel] },
      { version: 1, roles: [persistedDefault()], extra: true },
      {
        version: 1,
        roles: [{ ...persistedDefault(), extra: true }],
      },
      {
        version: 1,
        roles: [persistedDefault({
          model: {
            ...initialModel,
            available: true,
          } as unknown as RoleModelReference,
        })],
      },
      {
        version: 1,
        roles: [persistedDefault({ id: "not-default" })],
      },
      {
        version: 1,
        roles: [
          persistedDefault(),
          persistedDefault({ name: "Duplicate default" }),
        ],
      },
    ];

    for (const [index, document] of invalidDocuments.entries()) {
      const rolesPath = await createRolesPath(
        `piweb-role-store-corrupt-${index}-`,
      );
      await mkdir(dirname(rolesPath), { recursive: true });
      const raw = typeof document === "string"
        ? document
        : `${JSON.stringify(document, null, 2)}\n`;
      await writeFile(rolesPath, raw, "utf8");

      await expect(RoleStore.open(rolesPath, initialModel)).rejects.toThrow(
        "Invalid role store",
      );
      await expect(readFile(rolesPath, "utf8")).resolves.toBe(raw);
    }
  });
});
