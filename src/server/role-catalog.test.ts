import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RoleCatalog,
  type RoleCatalogModelSource,
} from "./role-catalog.js";
import type { RoleModelReference } from "./role-store.js";

const temporaryDirectories: string[] = [];

async function rolesPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "piweb-role-catalog-"));
  temporaryDirectories.push(directory);
  return join(directory, "piweb", "roles.json");
}

function model(provider: string, id: string): RoleModelReference {
  return { provider, id };
}

function source(initial: RoleModelReference[]): RoleCatalogModelSource & {
  available: RoleModelReference[];
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
    await catalog.updateRole("default", 1, {
      name: "Updated",
      description: "changed",
      systemPrompt: "new prompt",
      model: model("provider", "model-a"),
      canManageSessions: false,
    });

    expect(snapshot).toMatchObject({
      revision: 1,
      name: "Default",
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

    await expect(catalog.updateRole("default", 1, {
      name: "Default",
      description: "",
      systemPrompt: "",
      model: model("provider", "missing"),
      canManageSessions: true,
    })).rejects.toThrow("unavailable in the current project");

    models.available = [model("provider", "missing")];
    await catalog.updateRole("default", 1, {
      name: "Default",
      description: "",
      systemPrompt: "",
      model: model("provider", "missing"),
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
      canManageSessions: false,
    })).rejects.toThrow("unavailable in the current project");

    const created = await catalog.createRole({
      name: "Project role",
      description: "",
      systemPrompt: "",
      model: model("extension", "project-model"),
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

    await expect(catalog.updateRole(created.id, created.revision, {
      name: "Changed model",
      description: "",
      systemPrompt: "",
      model: model("extension", "missing"),
      canManageSessions: false,
    }, projectModels)).rejects.toThrow("unavailable in the current project");

    await expect(catalog.updateRole(created.id, created.revision, {
      name: "Renamed project role",
      description: "The project provider is temporarily unavailable.",
      systemPrompt: "Keep the frozen model.",
      model: model("extension", "project-model"),
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
      canManageSessions: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({ id: created.id, available: true }),
    );

    models.available = [];
    models.notify();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0]).toContainEqual(
      expect.objectContaining({ id: created.id, available: false }),
    );

    catalog.dispose();
    models.available = [model("provider", "model-a")];
    models.notify();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
