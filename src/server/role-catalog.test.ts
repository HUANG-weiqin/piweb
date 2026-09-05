import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RoleCatalog,
  type RoleCatalogModel,
  type RoleCatalogModelSource,
} from "./role-catalog.js";
import type { RoleModelReference } from "./role-store.js";

const temporaryDirectories: string[] = [];

async function rolesPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "piweb-role-catalog-"));
  temporaryDirectories.push(directory);
  return join(directory, "piweb", "roles.json");
}

function model(
  provider: string,
  id: string,
  contextWindow = 200_000,
): RoleCatalogModel {
  const reference = { provider, id };
  Object.defineProperty(reference, "contextWindow", { value: contextWindow });
  return reference as RoleCatalogModel;
}

function source(initial: RoleCatalogModel[]): RoleCatalogModelSource & {
  available: RoleCatalogModel[];
  notify(): void;
} {
  const listeners = new Set<() => void>();
  const value = {
    available: initial,
    modelRegistry: {
      getAvailable: () => value.available,
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
  return value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("RoleCatalog", () => {
  it("seeds default from an available model and freezes conversation snapshots", async () => {
    const models = source([model("provider", "model-a")]);
    const catalog = await RoleCatalog.open(models, await rolesPath());

    expect(catalog.listRoles()).toMatchObject([{
      id: "default",
      model: { provider: "provider", id: "model-a" },
      available: true,
    }]);

    const snapshot = catalog.getConversationRole("default");
    await catalog.updateRole("default", 1, "", {
      name: "Updated",
      description: "changed",
      systemPrompt: "new prompt",
      model: model("provider", "model-a"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });

    expect(snapshot).toMatchObject({
      revision: 1,
      name: "默认",
      description: "默认角色",
      systemPrompt: "",
      canManageSessions: false,
    });
    expect(catalog.getConversationRole("default")).toMatchObject({
      revision: 2,
      name: "Updated",
      canManageSessions: false,
    });
  });

  it("reports model-less and disconnected roles without blocking their frozen snapshot", async () => {
    const models = source([]);
    const catalog = await RoleCatalog.open(models, await rolesPath());

    expect(catalog.listRoles()[0]).toMatchObject({
      available: false,
      model: null,
    });
    expect(() => catalog.getConversationRole("default")).toThrow("no model");

    await expect(catalog.updateRole("default", 1, "", {
      name: "Default",
      description: "",
      systemPrompt: "",
      model: model("provider", "missing"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: true,
    })).rejects.toThrow("unavailable in the current project");

    models.available = [model("provider", "missing")];
    await catalog.updateRole("default", 1, "", {
      name: "Default",
      description: "",
      systemPrompt: "",
      model: model("provider", "missing"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: true,
    });
    models.available = [];
    expect(catalog.listRoles()[0]).toMatchObject({
      available: false,
      model: { provider: "provider", id: "missing" },
    });
    expect(catalog.getConversationRole("default")).toMatchObject({
      model: { provider: "provider", id: "missing" },
    });
  });

  it("validates a new model against the supplied project registry but preserves an unchanged invalid model", async () => {
    const baseline = source([model("baseline", "model-a")]);
    const projectModels = {
      getAvailable: () => [model("extension", "project-model")],
    };
    const catalog = await RoleCatalog.open(baseline, await rolesPath());

    await expect(catalog.createRole({
      name: "Project role",
      description: "",
      systemPrompt: "",
      model: model("extension", "project-model"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    })).rejects.toThrow("unavailable in the current project");

    const created = await catalog.createRole({
      name: "Project role",
      description: "",
      systemPrompt: "",
      model: model("extension", "project-model"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    }, projectModels);

    expect(catalog.listRoles(projectModels)).toContainEqual(
      expect.objectContaining({
        id: created.id,
        available: true,
      }),
    );
    expect(catalog.listRoles()).toContainEqual(
      expect.objectContaining({
        id: created.id,
        available: false,
      }),
    );

    await expect(catalog.updateRole(created.id, created.revision, "", {
      name: "Changed model",
      description: "",
      systemPrompt: "",
      model: model("extension", "missing"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    }, projectModels)).rejects.toThrow("unavailable in the current project");

    await expect(catalog.updateRole(created.id, created.revision, "", {
      name: "Renamed project role",
      description: "The project provider is temporarily unavailable.",
      systemPrompt: "Keep the frozen model.",
      model: model("extension", "project-model"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "full_access",
      canManageSessions: true,
    }, { getAvailable: () => [] })).resolves.toMatchObject({
      name: "Renamed project role",
      model: model("extension", "project-model"),
    });
  });

  it("publishes committed role edits and model availability changes", async () => {
    const models = source([model("provider", "model-a")]);
    const catalog = await RoleCatalog.open(models, await rolesPath());
    const listener = vi.fn();
    catalog.subscribe(listener);

    const created = await catalog.createRole({
      name: "Reviewer",
      description: "",
      systemPrompt: "Review.",
      model: model("provider", "model-a"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(catalog.listRoles()).toContainEqual(
      expect.objectContaining({ id: created.id, available: true }),
    );

    models.available = [];
    models.notify();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(catalog.listRoles()).toContainEqual(
      expect.objectContaining({ id: created.id, available: false }),
    );

    catalog.dispose();
    models.available = [model("provider", "model-a")];
    models.notify();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("validates explicit compaction models against available context windows", async () => {
    const main = model("provider", "main", 100_000);
    const compactor = model("provider", "compactor", 200_000);
    const models = source([main, compactor]);
    const catalog = await RoleCatalog.open(models, await rolesPath());
    const input = {
      name: "Compacting reviewer",
      description: "",
      systemPrompt: "",
      model: main,
      compactionModel: compactor,
      defaultThinkingLevel: "off" as const,
      defaultServiceTier: null,
      toolMode: "read_only" as const,
      canManageSessions: false,
    };
    const created = await catalog.createRole(input);
    const snapshot = catalog.getConversationRole(created.id);
    snapshot.model.id = "mutated-main";
    snapshot.compactionModel!.id = "mutated-compactor";
    expect(catalog.getConversationRole(created.id)).toMatchObject({
      model: main,
      compactionModel: compactor,
    });

    models.available = [main];
    expect(catalog.listRoles()).toContainEqual(expect.objectContaining({
      id: created.id,
      available: false,
      unavailableReason: "压缩模型当前不可用：provider/compactor",
    }));
    await expect(catalog.createRole({
      ...input,
      name: "Unavailable compactor",
    })).rejects.toThrow("Role compaction model is unavailable");
    await expect(catalog.updateRole(created.id, created.revision, "", {
      ...input,
      name: "Renamed while compactor is unavailable",
    })).resolves.toMatchObject({
      name: "Renamed while compactor is unavailable",
    });
    models.available = [model("provider", "main", 300_000), compactor];
    expect(catalog.listRoles()).toContainEqual(expect.objectContaining({
      id: created.id,
      unavailableReason:
        "压缩模型上下文窗口不能小于主模型（压缩模型：200000，主模型：300000）",
    }));

    const smallerCompactor = source([
      model("provider", "small-main", 200_000),
      model("provider", "small-compactor", 100_000),
    ]);
    const tooSmall = await RoleCatalog.open(smallerCompactor, await rolesPath());
    await expect(tooSmall.createRole({
      ...input,
      name: "Too small compactor",
      model: model("provider", "small-main", 200_000),
      compactionModel: model("provider", "small-compactor", 100_000),
    })).rejects.toThrow(
      "context window must be at least the primary model (compaction: 100000, primary: 200000)",
    );

    const invalidWindow = await RoleCatalog.open(source([
      model("provider", "invalid-main", Number.POSITIVE_INFINITY),
      model("provider", "invalid-compactor", 200_000),
    ]), await rolesPath());
    await expect(invalidWindow.createRole({
      ...input,
      name: "Invalid context window",
      model: model("provider", "invalid-main", Number.POSITIVE_INFINITY),
      compactionModel: model("provider", "invalid-compactor", 200_000),
    })).rejects.toThrow("context window must be a finite positive number");

    const upgradedModels = source([
      model("provider", "small", 100_000),
      model("provider", "large", 300_000),
      model("provider", "fixed-compactor", 200_000),
    ]);
    const upgraded = await RoleCatalog.open(upgradedModels, await rolesPath());
    const role = await upgraded.createRole({
      ...input,
      name: "Upgradeable",
      model: model("provider", "small", 100_000),
      compactionModel: model("provider", "fixed-compactor", 200_000),
    });
    await expect(upgraded.updateRole(role.id, role.revision, "", {
      ...input,
      name: "Larger primary",
      model: model("provider", "large", 300_000),
      compactionModel: model("provider", "fixed-compactor", 200_000),
    })).rejects.toThrow(
      "context window must be at least the primary model (compaction: 200000, primary: 300000)",
    );
  });

  it("validates role default service tiers by request route and reports drift", async () => {
    const selected = {
      ...model("provider", "codex"),
      api: "openai-codex-responses",
    };
    const models = source([selected]);
    const catalog = await RoleCatalog.open(models, await rolesPath());

    const created = await catalog.createRole({
      name: "Priority",
      description: "",
      systemPrompt: "",
      model: model("provider", "codex"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: "priority",
      toolMode: "read_only",
      canManageSessions: false,
    });
    expect(catalog.getConversationRole(created.id).defaultServiceTier)
      .toBe("priority");

    models.available = [model("provider", "codex")];
    expect(catalog.listRoles()).toContainEqual(expect.objectContaining({
      id: created.id,
      available: false,
      unavailableReason: "模型不支持默认服务层级：priority",
    }));
    await expect(catalog.updateRole(created.id, created.revision, "", {
      name: "Renamed while unavailable",
      description: "",
      systemPrompt: "",
      model: model("provider", "codex"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: "priority",
      toolMode: "read_only",
      canManageSessions: false,
    })).resolves.toMatchObject({ name: "Renamed while unavailable" });

    await expect(catalog.createRole({
      name: "Unsupported priority",
      description: "",
      systemPrompt: "",
      model: model("provider", "codex"),
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: "priority",
      toolMode: "read_only",
      canManageSessions: false,
    })).rejects.toThrow("does not support service tier priority");
  });

  it("rejects a default thinking level unsupported by the role model", async () => {
    const selected = {
      ...model("provider", "limited"),
      reasoning: true,
      thinkingLevelMap: { max: null },
    };
    const models = source([selected]);
    const catalog = await RoleCatalog.open(models, await rolesPath());

    await expect(catalog.createRole({
      name: "Too much thinking",
      description: "",
      systemPrompt: "",
      model: model("provider", "limited"),
      compactionModel: null,
      defaultThinkingLevel: "max",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    })).rejects.toThrow("does not support thinking level max");
    await expect(catalog.createRole({
      name: "Unsupported extended thinking",
      description: "",
      systemPrompt: "",
      model: model("provider", "limited"),
      compactionModel: null,
      defaultThinkingLevel: "xhigh",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    })).rejects.toThrow("does not support thinking level xhigh");

    const created = await catalog.createRole({
      name: "Supported thinking",
      description: "",
      systemPrompt: "",
      model: model("provider", "limited"),
      compactionModel: null,
      defaultThinkingLevel: "high",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    models.available = [{
      ...selected,
      thinkingLevelMap: { high: null, max: null },
    }];
    expect(catalog.listRoles()).toContainEqual(expect.objectContaining({
      id: created.id,
      available: false,
      unavailableReason: "模型不支持默认思考强度：high",
    }));
  });
});
