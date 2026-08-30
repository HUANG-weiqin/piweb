import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type {
  ConversationRoleSnapshot,
  RoleTemplate,
  ThinkingLevel,
} from "../shared/protocol.js";
import {
  RoleStore,
  type RoleDraft,
  type RoleModelReference,
  type RoleTemplateV1,
} from "./role-store.js";
import {
  supportedThinkingLevels,
  type ThinkingCapableModel,
} from "./model-thinking.js";
import { modelServiceTiers } from "./service-tier.js";

export interface RoleCatalogModelSource {
  readonly modelRegistry: RoleCatalogModelRegistry;
  subscribe(listener: () => void): () => void;
}

export interface RoleCatalogModelRegistry {
  getAvailable(): readonly RoleCatalogModel[];
}

export interface RoleCatalogModel
  extends RoleModelReference, ThinkingCapableModel {}

type RoleCatalogListener = () => void;

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

function supportsThinkingLevel(
  model: RoleCatalogModel,
  level: ThinkingLevel,
): boolean {
  return supportedThinkingLevels(model).includes(level);
}

function unavailableReason(
  role: RoleTemplateV1,
  model: RoleCatalogModel | undefined,
): string | undefined {
  if (role.model === null) return "尚未为此角色选择模型";
  if (model === undefined) {
    return `模型当前不可用：${role.model.provider}/${role.model.id}`;
  }
  if (!supportsThinkingLevel(model, role.defaultThinkingLevel)) {
    return `模型不支持默认思考强度：${role.defaultThinkingLevel}`;
  }
  if (
    role.defaultServiceTier !== null
    && !modelServiceTiers(model)?.includes(role.defaultServiceTier)
  ) {
    return `模型不支持默认服务层级：${role.defaultServiceTier}`;
  }
  return undefined;
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
    defaultThinkingLevel: role.defaultThinkingLevel,
    defaultServiceTier: role.defaultServiceTier,
    toolMode: role.toolMode,
    canManageSessions: role.canManageSessions,
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
    const available = new Map(
      modelRegistry.getAvailable().map((model) => [modelKey(model), model]),
    );
    return this.store.listRoles().map((role) => {
      const model = role.model === null
        ? undefined
        : available.get(modelKey(role.model));
      const reason = unavailableReason(role, model);
      return {
        ...role,
        model: role.model === null ? null : { ...role.model },
        available: reason === undefined,
        ...(reason === undefined ? {} : { unavailableReason: reason }),
      };
    });
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
    this.assertDraftAvailable(input, modelRegistry);
    return await this.store.createRole(input);
  }

  async updateRole(
    roleId: string,
    expectedRevision: number,
    expectedSystemPrompt: string,
    input: RoleDraft,
    modelRegistry: RoleCatalogModelRegistry = this.source.modelRegistry,
    signal?: AbortSignal,
  ): Promise<RoleTemplateV1> {
    this.assertOpen();
    const current = this.store.getRole(roleId);
    if (!current) throw new Error(`Role not found: ${roleId}`);
    if (
      !modelsAreEqual(current.model, input.model)
      || current.defaultThinkingLevel !== input.defaultThinkingLevel
      || current.defaultServiceTier !== input.defaultServiceTier
    ) {
      this.assertDraftAvailable(input, modelRegistry);
    }
    return await this.store.updateRole(
      roleId,
      expectedRevision,
      expectedSystemPrompt,
      input,
      signal,
    );
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
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One observer cannot roll back a durable role or model change.
      }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Role catalog is closed");
  }

  private assertDraftAvailable(
    input: RoleDraft,
    modelRegistry: RoleCatalogModelRegistry,
  ): void {
    const model = input.model;
    if (model === null) {
      if (input.defaultServiceTier !== null) {
        throw new Error("Role without a model cannot select a service tier");
      }
      return;
    }
    const selected = modelRegistry.getAvailable()
      .find((candidate) => modelKey(candidate) === modelKey(model));
    if (selected === undefined) {
      throw new Error(
        `Role model is unavailable in the current project: ${
          model.provider
        }/${model.id}`,
      );
    }
    if (!supportsThinkingLevel(selected, input.defaultThinkingLevel)) {
      throw new Error(
        `Role model does not support thinking level ${input.defaultThinkingLevel}: ${
          model.provider
        }/${model.id}`,
      );
    }
    if (
      input.defaultServiceTier !== null
      && !modelServiceTiers(selected)?.includes(input.defaultServiceTier)
    ) {
      throw new Error(
        `Role model does not support service tier ${input.defaultServiceTier}: ${
          model.provider
        }/${model.id}`,
      );
    }
  }
}
