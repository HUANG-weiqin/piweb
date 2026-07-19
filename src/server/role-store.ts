import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const ROLE_STORE_VERSION = 2;
export const MAX_ROLE_COUNT = 64;
export const MAX_ROLE_NAME_CHARACTERS = 80;
export const MAX_ROLE_DESCRIPTION_CHARACTERS = 1_000;
export const MAX_ROLE_SYSTEM_PROMPT_BYTES = 128 * 1024;

const MAX_MODEL_REFERENCE_BYTES = 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RoleModelReference {
  provider: string;
  id: string;
}

export interface RoleDraft {
  name: string;
  description: string;
  systemPrompt: string;
  model: RoleModelReference | null;
  canManageSessions: boolean;
}

export interface RoleTemplateV1 extends RoleDraft {
  id: "default" | string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface RoleStoreDocument {
  version: typeof ROLE_STORE_VERSION;
  roles: RoleTemplateV1[];
}

interface ParsedRoleStoreDocument {
  document: RoleStoreDocument;
  migrated: boolean;
}

export interface RoleStoreSnapshot {
  version: typeof ROLE_STORE_VERSION;
  roles: RoleTemplateV1[];
}

export type RoleStoreListener = (snapshot: RoleStoreSnapshot) => void;

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} has unknown field ${JSON.stringify(key)}`);
    }
  }
}

function assertCanonicalIsoDate(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
}

function assertRoleId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string"
    || (value !== "default" && !UUID_PATTERN.test(value))
  ) {
    throw new Error(`${field} must be "default" or a UUID`);
  }
}

function assertRevision(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function assertBoundedString(
  value: unknown,
  field: string,
  maxCharacters: number,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  if ([...value].length > maxCharacters) {
    throw new Error(`${field} must be at most ${maxCharacters} characters`);
  }
}

function assertBoundedUtf8(
  value: unknown,
  field: string,
  maxBytes: number,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} must be at most ${maxBytes} UTF-8 bytes`);
  }
}

function parseModelReference(
  value: unknown,
  field: string,
): RoleModelReference | null {
  if (value === null) return null;
  assertExactObject(value, ["provider", "id"], field);
  assertBoundedUtf8(
    value.provider,
    `${field}.provider`,
    MAX_MODEL_REFERENCE_BYTES,
  );
  assertBoundedUtf8(value.id, `${field}.id`, MAX_MODEL_REFERENCE_BYTES);
  if (value.provider.trim().length === 0) {
    throw new Error(`${field}.provider must not be empty`);
  }
  if (value.id.trim().length === 0) {
    throw new Error(`${field}.id must not be empty`);
  }
  return {
    provider: value.provider,
    id: value.id,
  };
}

function parseRoleDraft(value: unknown, label: string): RoleDraft {
  assertExactObject(
    value,
    ["name", "description", "systemPrompt", "model", "canManageSessions"],
    label,
  );
  assertBoundedString(
    value.name,
    `${label}.name`,
    MAX_ROLE_NAME_CHARACTERS,
  );
  if (value.name.trim().length === 0) {
    throw new Error(`${label}.name must not be empty`);
  }
  assertBoundedString(
    value.description,
    `${label}.description`,
    MAX_ROLE_DESCRIPTION_CHARACTERS,
  );
  assertBoundedUtf8(
    value.systemPrompt,
    `${label}.systemPrompt`,
    MAX_ROLE_SYSTEM_PROMPT_BYTES,
  );
  if (typeof value.canManageSessions !== "boolean") {
    throw new Error(`${label}.canManageSessions must be a boolean`);
  }
  return {
    name: value.name,
    description: value.description,
    systemPrompt: value.systemPrompt,
    model: parseModelReference(value.model, `${label}.model`),
    canManageSessions: value.canManageSessions,
  };
}

function parseRoleTemplate(
  value: unknown,
  index: number,
): RoleTemplateV1 {
  const label = `roles[${index}]`;
  assertExactObject(
    value,
    [
      "id",
      "revision",
      "name",
      "description",
      "systemPrompt",
      "model",
      "canManageSessions",
      "createdAt",
      "updatedAt",
    ],
    label,
  );
  assertRoleId(value.id, `${label}.id`);
  if (
    typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
  ) {
    throw new Error(`${label}.revision must be a positive safe integer`);
  }
  assertCanonicalIsoDate(value.createdAt, `${label}.createdAt`);
  assertCanonicalIsoDate(value.updatedAt, `${label}.updatedAt`);
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new Error(`${label}.updatedAt must not precede createdAt`);
  }
  return {
    id: value.id,
    revision: value.revision,
    ...parseRoleDraft({
      name: value.name,
      description: value.description,
      systemPrompt: value.systemPrompt,
      model: value.model,
      // Session orchestration is opt-in for roles written before this field.
      canManageSessions: value.canManageSessions ?? false,
    }, label),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizedRoleName(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

function assertUniqueRoles(roles: readonly RoleTemplateV1[]): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const role of roles) {
    if (ids.has(role.id)) {
      throw new Error(`duplicate role id ${JSON.stringify(role.id)}`);
    }
    ids.add(role.id);

    const name = normalizedRoleName(role.name);
    if (names.has(name)) {
      throw new Error(`duplicate role name ${JSON.stringify(role.name)}`);
    }
    names.add(name);
  }
}

function parseRoleStoreDocument(
  raw: string,
  rolesPath: string,
): ParsedRoleStoreDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid role store at ${rolesPath}: invalid JSON`, {
      cause: error,
    });
  }

  try {
    assertExactObject(value, ["version", "roles"], "role store");
    if (value.version !== 1 && value.version !== ROLE_STORE_VERSION) {
      throw new Error(`version must be 1 or ${ROLE_STORE_VERSION}`);
    }
    if (!Array.isArray(value.roles)) {
      throw new Error("roles must be an array");
    }
    if (value.roles.length > MAX_ROLE_COUNT) {
      throw new Error(`roles must contain at most ${MAX_ROLE_COUNT} roles`);
    }
    const roles = value.roles.map(parseRoleTemplate);
    assertUniqueRoles(roles);
    return {
      document: {
        version: ROLE_STORE_VERSION,
        roles: value.version === 1 ? migrateV1Roles(roles) : roles,
      },
      migrated: value.version === 1,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid role store at ${rolesPath}: ${detail}`, {
      cause: error,
    });
  }
}

function migrateV1Roles(roles: readonly RoleTemplateV1[]): RoleTemplateV1[] {
  const defaultRole = roles.find(({ id }) => id === "default");
  if (!defaultRole) return roles.map(cloneRole);
  const hasDefaultNameConflict = roles.some((role) => (
    role.id !== "default"
    && normalizedRoleName(role.name) === normalizedRoleName("默认")
  ));
  const shouldMigrateDefault = (
    defaultRole.name === "Default"
    && defaultRole.description === ""
    && defaultRole.revision < Number.MAX_SAFE_INTEGER
    && !hasDefaultNameConflict
  );
  if (!shouldMigrateDefault) return roles.map(cloneRole);

  const migratedAt = new Date().toISOString();
  return roles.map((role) => role.id === "default"
    ? {
        ...role,
        revision: role.revision + 1,
        name: "默认",
        description: "默认角色",
        updatedAt: migratedAt,
      }
    : cloneRole(role));
}

function cloneModel(
  model: RoleModelReference | null,
): RoleModelReference | null {
  return model === null ? null : { ...model };
}

function cloneRole(role: RoleTemplateV1): RoleTemplateV1 {
  return {
    ...role,
    model: cloneModel(role.model),
  };
}

function cloneDocument(document: RoleStoreDocument): RoleStoreDocument {
  return {
    version: ROLE_STORE_VERSION,
    roles: document.roles.map(cloneRole),
  };
}

function draftsAreEqual(
  role: RoleTemplateV1,
  draft: RoleDraft,
): boolean {
  return (
    role.name === draft.name
    && role.description === draft.description
    && role.systemPrompt === draft.systemPrompt
    && modelsAreEqual(role.model, draft.model)
    && role.canManageSessions === draft.canManageSessions
  );
}

function modelsAreEqual(
  first: RoleModelReference | null,
  second: RoleModelReference | null,
): boolean {
  if (first === null || second === null) return first === second;
  return first.provider === second.provider && first.id === second.id;
}

async function writeRoleStoreAtomically(
  rolesPath: string,
  document: RoleStoreDocument,
): Promise<void> {
  const temporaryPath = join(
    dirname(rolesPath),
    `.${basename(rolesPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(document, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    await rename(temporaryPath, rolesPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class RoleStore {
  readonly rolesPath: string;

  private readonly listeners = new Set<RoleStoreListener>();
  private document: RoleStoreDocument;
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(
    rolesPath: string,
    document: RoleStoreDocument,
  ) {
    this.rolesPath = rolesPath;
    this.document = document;
  }

  static async open(
    rolesPath: string,
    initialModel: RoleModelReference | null,
  ): Promise<RoleStore> {
    await mkdir(dirname(rolesPath), { recursive: true });

    let document: RoleStoreDocument;
    try {
      const parsed = parseRoleStoreDocument(
        await readFile(rolesPath, "utf8"),
        rolesPath,
      );
      document = parsed.document;
      if (parsed.migrated) {
        await writeRoleStoreAtomically(rolesPath, document);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const model = parseModelReference(initialModel, "initialModel");
      const timestamp = new Date().toISOString();
      document = {
        version: ROLE_STORE_VERSION,
        roles: [{
          id: "default",
          revision: 1,
          name: "默认",
          description: "默认角色",
          systemPrompt: "",
          model,
          canManageSessions: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
      };
      await writeRoleStoreAtomically(rolesPath, document);
    }

    return new RoleStore(rolesPath, cloneDocument(document));
  }

  getSnapshot(): RoleStoreSnapshot {
    return {
      version: ROLE_STORE_VERSION,
      roles: this.listRoles(),
    };
  }

  listRoles(): RoleTemplateV1[] {
    return this.document.roles.map(cloneRole);
  }

  getRole(roleId: string): RoleTemplateV1 | undefined {
    const role = this.document.roles.find(({ id }) => id === roleId);
    return role === undefined ? undefined : cloneRole(role);
  }

  subscribe(listener: RoleStoreListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  async createRole(input: RoleDraft): Promise<RoleTemplateV1> {
    const draft = parseRoleDraft(input, "role");
    return this.enqueueWrite(async () => {
      if (this.document.roles.length >= MAX_ROLE_COUNT) {
        throw new Error(`Role store supports at most ${MAX_ROLE_COUNT} roles`);
      }
      this.assertNameAvailable(draft.name);

      let id = randomUUID();
      while (this.document.roles.some((role) => role.id === id)) {
        id = randomUUID();
      }
      const timestamp = new Date().toISOString();
      const role: RoleTemplateV1 = {
        id,
        revision: 1,
        ...draft,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next: RoleStoreDocument = {
        version: ROLE_STORE_VERSION,
        roles: [...this.document.roles, role],
      };
      await this.commit(next);
      return cloneRole(role);
    });
  }

  async updateRole(
    roleId: string,
    expectedRevision: number,
    input: RoleDraft,
  ): Promise<RoleTemplateV1> {
    assertRoleId(roleId, "roleId");
    assertRevision(expectedRevision, "expectedRevision");
    const draft = parseRoleDraft(input, "role");
    return this.enqueueWrite(async () => {
      const index = this.document.roles.findIndex(({ id }) => id === roleId);
      if (index < 0) {
        throw new Error(`Role not found: ${roleId}`);
      }
      const current = this.document.roles[index]!;
      if (current.revision !== expectedRevision) {
        throw new Error(
          `Role revision changed: expected ${expectedRevision}, found ${current.revision}`,
        );
      }
      if (draftsAreEqual(current, draft)) return cloneRole(current);
      this.assertNameAvailable(draft.name, roleId);
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error(`Role revision is exhausted: ${roleId}`);
      }

      const updated: RoleTemplateV1 = {
        id: current.id,
        revision: current.revision + 1,
        ...draft,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const roles = [...this.document.roles];
      roles[index] = updated;
      await this.commit({
        version: ROLE_STORE_VERSION,
        roles,
      });
      return cloneRole(updated);
    });
  }

  async deleteRole(roleId: string, expectedRevision: number): Promise<void> {
    assertRoleId(roleId, "roleId");
    assertRevision(expectedRevision, "expectedRevision");
    return this.enqueueWrite(async () => {
      const index = this.document.roles.findIndex(({ id }) => id === roleId);
      if (index < 0) {
        throw new Error(`Role not found: ${roleId}`);
      }
      const current = this.document.roles[index]!;
      if (current.revision !== expectedRevision) {
        throw new Error(
          `Role revision changed: expected ${expectedRevision}, found ${current.revision}`,
        );
      }
      await this.commit({
        version: ROLE_STORE_VERSION,
        roles: this.document.roles.filter(({ id }) => id !== roleId),
      });
    });
  }

  private assertNameAvailable(name: string, exceptRoleId?: string): void {
    const normalized = normalizedRoleName(name);
    if (this.document.roles.some((role) => (
      role.id !== exceptRoleId
      && normalizedRoleName(role.name) === normalized
    ))) {
      throw new Error(`Role name already exists: ${name}`);
    }
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async commit(document: RoleStoreDocument): Promise<void> {
    await writeRoleStoreAtomically(this.rolesPath, document);
    this.document = cloneDocument(document);
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.getSnapshot());
      } catch {
        // A subscriber cannot roll back a durable state change.
      }
    }
  }
}
