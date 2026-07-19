import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type {
  ConversationRoleSnapshot,
  RoleTemplate,
} from "../shared/protocol.js";
import {
  RoleStore,
  type RoleDraft,
  type RoleModelReference,
  type RoleTemplateV1,
} from "./role-store.js";

export interface RoleCatalogModelSource {
  readonly modelRegistry: RoleCatalogModelRegistry;
  subscribe(listener: () => void): () => void;
}

export interface RoleCatalogModelRegistry {
  getAvailable(): readonly RoleModelReference[];
}

export type RoleCatalogListener = (roles: readonly RoleTemplate[]) => void;

function modelKey(model: RoleModelReference): string {
  return `${model.provider.length}:${model.provider}:${model.id}`;
}

function modelsAreEqual(
  left: RoleModelReference | null,
  right: RoleModelReference | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.provider === right.provider
      && left.id === right.id;
}

function cloneConversationRole(
  role: RoleTemplateV1 & { model: RoleModelReference },
): ConversationRoleSnapshot {
  return {
    id: role.id,
    revision: role.revision,
    name: role.name,
    description: role.description,
    systemPrompt: role.systemPrompt,
    model: { ...role.model },
  };
}

export class RoleCatalog {
  private readonly listeners = new Set<RoleCatalogListener>();
  private readonly unsubscribeStore: () => void;
  private readonly unsubscribeModels: () => void;
  private disposed = false;

  private constructor(
    private readonly source: RoleCatalogModelSource,
    private readonly store: RoleStore,
  ) {
    this.unsubscribeStore = store.subscribe(() => this.emit());
    this.unsubscribeModels = source.subscribe(() => this.emit());
  }

  static async open(
    source: RoleCatalogModelSource,
    rolesPath = join(getAgentDir(), "piweb", "roles.json"),
  ): Promise<RoleCatalog> {
    const firstAvailable = source.modelRegistry.getAvailable()[0];
    const initialModel = firstAvailable === undefined
      ? null
      : {
          provider: firstAvailable.provider,
          id: firstAvailable.id,
        };
    const store = await RoleStore.open(rolesPath, initialModel);
    return new RoleCatalog(source, store);
  }

  listRoles(
    modelRegistry: RoleCatalogModelRegistry = this.source.modelRegistry,
  ): RoleTemplate[] {
    const available = new Set(
      modelRegistry.getAvailable().map(modelKey),
    );
    return this.store.listRoles().map((role) => {
      const modelAvailable = role.model !== null
        && available.has(modelKey(role.model));
      return {
        ...role,
        model: role.model === null ? null : { ...role.model },
        available: modelAvailable,
        ...(modelAvailable
          ? {}
          : {
              unavailableReason: role.model === null
                ? "尚未为此角色选择模型"
                : `模型当前不可用：${role.model.provider}/${role.model.id}`,
            }),
      };
    });
  }

  getRoleTemplate(roleId: string): RoleTemplate {
    const role = this.listRoles().find(({ id }) => id === roleId);
    if (!role) throw new Error(`Role not found: ${roleId}`);
    return structuredClone(role);
  }

  getConversationRole(roleId: string): ConversationRoleSnapshot {
    const role = this.store.getRole(roleId);
    if (role === undefined) throw new Error(`Role not found: ${roleId}`);
    if (role.model === null) {
      throw new Error(`Role has no model: ${roleId}`);
    }
    return cloneConversationRole(
      role as RoleTemplateV1 & { model: RoleModelReference },
    );
  }

  async createRole(
    input: RoleDraft,
    modelRegistry: RoleCatalogModelRegistry = this.source.modelRegistry,
  ): Promise<RoleTemplateV1> {
    this.assertOpen();
    this.assertSelectedModelAvailable(input.model, modelRegistry);
    return await this.store.createRole(input);
  }

  async updateRole(
    roleId: string,
    expectedRevision: number,
    input: RoleDraft,
    modelRegistry: RoleCatalogModelRegistry = this.source.modelRegistry,
  ): Promise<RoleTemplateV1> {
    this.assertOpen();
    const current = this.store.getRole(roleId);
    if (!current) throw new Error(`Role not found: ${roleId}`);
    if (!modelsAreEqual(current.model, input.model)) {
      this.assertSelectedModelAvailable(input.model, modelRegistry);
    }
    return await this.store.updateRole(roleId, expectedRevision, input);
  }

  deleteRole(roleId: string, expectedRevision: number): Promise<void> {
    this.assertOpen();
    return this.store.deleteRole(roleId, expectedRevision);
  }

  subscribe(listener: RoleCatalogListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeStore();
    this.unsubscribeModels();
    this.listeners.clear();
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.listRoles();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // One observer cannot roll back a durable role or model change.
      }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Role catalog is closed");
  }

  private assertSelectedModelAvailable(
    model: RoleModelReference | null,
    modelRegistry: RoleCatalogModelRegistry,
  ): void {
    if (
      model !== null
      && !modelRegistry.getAvailable()
        .some((candidate) => modelKey(candidate) === modelKey(model))
    ) {
      throw new Error(
        `Role model is unavailable in the current project: ${
          model.provider
        }/${model.id}`,
      );
    }
  }
}
