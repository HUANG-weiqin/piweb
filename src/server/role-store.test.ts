import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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
    toolMode: "read_only",
    canManageSessions: false,
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
    ...overrides,
  };
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
      roles: [persistedDefault()],
    });

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
      roles: [persistedDefault({
        revision: 3,
        name: "Default",
        description: "",
      })],
    }, null, 2)}\n`, "utf8");

    const store = await RoleStore.open(rolesPath, initialModel);

    expect(store.getRole("default")).toEqual(persistedDefault({
      revision: 4,
      updatedAt: "2026-07-19T11:00:00.000Z",
    }));
    expect(JSON.parse(await readFile(rolesPath, "utf8"))).toEqual({
      version: ROLE_STORE_VERSION,
      roles: [persistedDefault({
        revision: 4,
        updatedAt: "2026-07-19T11:00:00.000Z",
      })],
    });

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
      roles: [editedDefault],
    }, null, 2)}\n`, "utf8");

    const editedStore = await RoleStore.open(editedRolesPath, initialModel);
    expect(editedStore.getRole("default")).toEqual(editedDefault);
  });

  it("keeps a model-less default when no initial model is available", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-no-model-");

    const store = await RoleStore.open(rolesPath, null);

    expect(store.getRole("default")?.model).toBeNull();
  });

  it("defaults legacy role capabilities and tool permission closed", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-legacy-capability-");
    await mkdir(dirname(rolesPath), { recursive: true });
    const legacyRole = persistedDefault();
    const {
      canManageSessions: _omittedCapability,
      toolMode: _omittedToolMode,
      ...legacyFields
    } = legacyRole;
    await writeFile(rolesPath, `${JSON.stringify({
      version: 2,
      roles: [legacyFields],
    }, null, 2)}\n`, "utf8");

    const store = await RoleStore.open(rolesPath, null);

    expect(store.getRole("default")?.canManageSessions).toBe(false);
    expect(store.getRole("default")?.toolMode).toBe("read_only");
    expect(JSON.parse(await readFile(rolesPath, "utf8"))).toMatchObject({
      version: ROLE_STORE_VERSION,
      roles: [{ toolMode: "read_only" }],
    });
  });

  it("allows editing and deleting the seeded role without recreating it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"));
    const rolesPath = await createRolesPath("piweb-role-store-edit-default-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const before = store.getRole("default")!;

    vi.setSystemTime(new Date("2026-07-19T11:00:00.000Z"));
    const updated = await store.updateRole("default", 1, {
      name: "General",
      description: "General purpose",
      systemPrompt: "Be concise.",
      model: { provider: "other-provider", id: "other-model" },
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
      canManageSessions: false,
      updatedAt: "2026-07-19T11:00:00.000Z",
    });
    expect(store.listRoles()).toHaveLength(1);

    await store.deleteRole("default", updated.revision);
    expect(store.listRoles()).toEqual([]);

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
      store.updateRole("default", 1, draft("REVIEWER")),
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
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const first = store.updateRole("default", 1, draft("First"));
    const firstResult = await first;
    const secondResult = await store.updateRole("default", 2, draft("Second"));

    expect(firstResult.revision).toBe(2);
    expect(secondResult.revision).toBe(3);
    expect(store.getRole("default")).toMatchObject({
      name: "Second",
      revision: 3,
    });
    expect(listener.mock.calls.map(([snapshot]) => (
      snapshot.roles[0]?.revision
    ))).toEqual([2, 3]);

    await store.updateRole("default", 3, draft("Second"));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await store.updateRole("default", 3, draft("Third"));
    expect(listener).toHaveBeenCalledTimes(2);

    const persisted = JSON.parse(await readFile(rolesPath, "utf8")) as {
      roles: RoleTemplateV1[];
    };
    expect(persisted.roles[0]).toMatchObject({
      name: "Third",
      revision: 4,
    });
    expect((await readdir(dirname(rolesPath))).sort()).toEqual(["roles.json"]);
  });

  it("does not publish or mutate memory when the atomic replacement fails", async () => {
    const rolesPath = await createRolesPath("piweb-role-store-atomic-fail-");
    const store = await RoleStore.open(rolesPath, initialModel);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    await unlink(rolesPath);
    await mkdir(rolesPath);

    await expect(
      store.updateRole("default", 1, draft("Must not commit")),
    ).rejects.toThrow();
    expect(store.getSnapshot()).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
    expect((await readdir(dirname(rolesPath))).sort()).toEqual(["roles.json"]);
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
      store.updateRole("default", 1, draft("Default", {
        systemPrompt: exactPrompt,
      })),
    ).resolves.toMatchObject({ systemPrompt: exactPrompt });
    await expect(
      store.updateRole("default", 2, draft("Default", {
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

  it("fails closed on corrupt, unknown, or structurally invalid v1 files", async () => {
    const invalidDocuments: unknown[] = [
      "{",
      { version: 4, roles: [persistedDefault()] },
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
