import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { basename, dirname, join } from "node:path";
import {
  MAX_MODEL_REFERENCE_BYTES,
  type ThinkingLevel,
} from "../shared/protocol.js";

export const ROLE_STORE_VERSION = 5;
export const MAX_ROLE_COUNT = 64;
export const MAX_ROLE_NAME_CHARACTERS = 80;
export const MAX_ROLE_DESCRIPTION_CHARACTERS = 1_000;
export const MAX_ROLE_SYSTEM_PROMPT_BYTES = 128 * 1024;

const ROLE_PROMPTS_DIRECTORY = "role-prompts";
const ROLE_PROMPT_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
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
  defaultThinkingLevel: ThinkingLevel;
  toolMode: "read_only" | "full_access";
  canManageSessions: boolean;
}

export interface RoleTemplateV1 extends RoleDraft {
  id: "default" | string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

type RoleMetadata = Omit<RoleDraft, "systemPrompt">;
type PersistedRole = Omit<RoleTemplateV1, "systemPrompt"> & {
  systemPromptFile: string;
};

interface RoleStoreDocument {
  version: typeof ROLE_STORE_VERSION;
  roles: PersistedRole[];
}

interface ParsedCurrentRoleStoreDocument {
  migrated: false;
  document: RoleStoreDocument;
}

interface ParsedLegacyRoleStoreDocument {
  migrated: true;
  legacyRoles: RoleTemplateV1[];
}

type ParsedRoleStoreDocument =
  | ParsedCurrentRoleStoreDocument
  | ParsedLegacyRoleStoreDocument;

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

function assertThinkingLevel(
  value: unknown,
  field: string,
): asserts value is ThinkingLevel {
  if (
    value !== "off"
    && value !== "minimal"
    && value !== "low"
    && value !== "medium"
    && value !== "high"
    && value !== "xhigh"
    && value !== "max"
  ) {
    throw new Error(`${field} must be a supported thinking level`);
  }
}

function parseRoleMetadata(
  value: Record<string, unknown>,
  label: string,
  legacyBehavior: boolean,
  legacyCanManageSessions = legacyBehavior,
): RoleMetadata {
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
  if (legacyBehavior) {
    assertBoundedUtf8(
      value.systemPrompt,
      `${label}.systemPrompt`,
      MAX_ROLE_SYSTEM_PROMPT_BYTES,
    );
  }
  if (value.canManageSessions !== undefined && value.canManageSessions !== null
    && typeof value.canManageSessions !== "boolean") {
    throw new Error(`${label}.canManageSessions must be a boolean`);
  }
  const canManageSessions = legacyCanManageSessions
    ? (value.canManageSessions ?? false)
    : value.canManageSessions;
  if (typeof canManageSessions !== "boolean") {
    throw new Error(`${label}.canManageSessions must be a boolean`);
  }
  const toolMode = value.toolMode
    ?? (legacyBehavior ? "read_only" : undefined);
  if (toolMode !== "read_only" && toolMode !== "full_access") {
    throw new Error(`${label}.toolMode must be read_only or full_access`);
  }
  const defaultThinkingLevel = value.defaultThinkingLevel
    ?? (legacyBehavior ? "off" : undefined);
  assertThinkingLevel(
    defaultThinkingLevel,
    `${label}.defaultThinkingLevel`,
  );
  return {
    name: value.name,
    description: value.description,
    model: parseModelReference(value.model, `${label}.model`),
    defaultThinkingLevel,
    toolMode,
    canManageSessions,
  };
}

function parseRoleDraft(value: unknown, label: string): RoleDraft {
  assertExactObject(
    value,
    [
      "name",
      "description",
      "systemPrompt",
      "model",
      "defaultThinkingLevel",
      "toolMode",
      "canManageSessions",
    ],
    label,
  );
  const metadata = parseRoleMetadata(value, label, false);
  assertBoundedUtf8(
    value.systemPrompt,
    `${label}.systemPrompt`,
    MAX_ROLE_SYSTEM_PROMPT_BYTES,
  );
  return {
    ...metadata,
    systemPrompt: value.systemPrompt,
  };
}

function parseRoleIdentity(
  value: Record<string, unknown>,
  label: string,
): Pick<RoleTemplateV1, "id" | "revision" | "createdAt" | "updatedAt"> {
  assertRoleId(value.id, `${label}.id`);
  assertRevision(value.revision, `${label}.revision`);
  assertCanonicalIsoDate(value.createdAt, `${label}.createdAt`);
  assertCanonicalIsoDate(value.updatedAt, `${label}.updatedAt`);
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new Error(`${label}.updatedAt must not precede createdAt`);
  }
  return {
    id: value.id,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseLegacyRoleTemplate(
  value: unknown,
  index: number,
  legacyBehavior: boolean,
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
      "defaultThinkingLevel",
      "toolMode",
      "canManageSessions",
      "createdAt",
      "updatedAt",
    ],
    label,
  );
  const identity = parseRoleIdentity(value, label);
  const metadata = parseRoleMetadata(value, label, legacyBehavior, true);
  assertBoundedUtf8(
    value.systemPrompt,
    `${label}.systemPrompt`,
    MAX_ROLE_SYSTEM_PROMPT_BYTES,
  );
  return {
    ...identity,
    ...metadata,
    systemPrompt: value.systemPrompt,
  };
}

function expectedSystemPromptFile(roleId: string, revision: number): string {
  return `${ROLE_PROMPTS_DIRECTORY}/${roleId}.${revision}.md`;
}

function assertSystemPromptFile(
  value: unknown,
  roleId: string,
  revision: number,
  field: string,
): asserts value is string {
  const expected = expectedSystemPromptFile(roleId, revision);
  if (value !== expected) {
    throw new Error(`${field} must be exactly ${JSON.stringify(expected)}`);
  }
}

function parsePersistedRoleTemplate(
  value: unknown,
  index: number,
): PersistedRole {
  const label = `roles[${index}]`;
  assertExactObject(
    value,
    [
      "id",
      "revision",
      "name",
      "description",
      "systemPromptFile",
      "model",
      "defaultThinkingLevel",
      "toolMode",
      "canManageSessions",
      "createdAt",
      "updatedAt",
    ],
    label,
  );
  const identity = parseRoleIdentity(value, label);
  assertSystemPromptFile(
    value.systemPromptFile,
    identity.id,
    identity.revision,
    `${label}.systemPromptFile`,
  );
  return {
    ...identity,
    ...parseRoleMetadata(value, label, false),
    systemPromptFile: value.systemPromptFile,
  };
}

function normalizedRoleName(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

function assertUniqueRoles(
  roles: readonly Pick<RoleTemplateV1, "id" | "name">[],
): void {
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
    const version = value.version;
    if (
      typeof version !== "number"
      || ![1, 2, 3, 4, ROLE_STORE_VERSION].includes(version)
    ) {
      throw new Error(`version must be 1, 2, 3, 4 or ${ROLE_STORE_VERSION}`);
    }
    if (!Array.isArray(value.roles)) {
      throw new Error("roles must be an array");
    }
    if (value.roles.length > MAX_ROLE_COUNT) {
      throw new Error(`roles must contain at most ${MAX_ROLE_COUNT} roles`);
    }

    if (version === ROLE_STORE_VERSION) {
      const roles = value.roles.map((role, index) =>
        parsePersistedRoleTemplate(role, index));
      assertUniqueRoles(roles);
      return {
        migrated: false,
        document: {
          version: ROLE_STORE_VERSION,
          roles,
        },
      };
    }

    const roles = value.roles.map((role, index) =>
      parseLegacyRoleTemplate(role, index, version !== 4));
    assertUniqueRoles(roles);
    return {
      migrated: true,
      legacyRoles: version === 1 ? migrateV1Roles(roles) : roles.map(cloneRole),
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

function clonePersistedRole(role: PersistedRole): PersistedRole {
  return {
    ...role,
    model: cloneModel(role.model),
  };
}

function cloneDocument(document: RoleStoreDocument): RoleStoreDocument {
  return {
    version: ROLE_STORE_VERSION,
    roles: document.roles.map(clonePersistedRole),
  };
}

function toPersistedRole(role: RoleTemplateV1): PersistedRole {
  return {
    id: role.id,
    revision: role.revision,
    name: role.name,
    description: role.description,
    systemPromptFile: expectedSystemPromptFile(role.id, role.revision),
    model: cloneModel(role.model),
    defaultThinkingLevel: role.defaultThinkingLevel,
    toolMode: role.toolMode,
    canManageSessions: role.canManageSessions,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

function documentFromLegacyRoles(
  roles: readonly RoleTemplateV1[],
): RoleStoreDocument {
  return {
    version: ROLE_STORE_VERSION,
    roles: roles.map(toPersistedRole),
  };
}

function promptDirectoryPath(rolesPath: string): string {
  return join(dirname(rolesPath), ROLE_PROMPTS_DIRECTORY);
}

function promptPathFor(rolesPath: string, role: PersistedRole): string {
  const expected = expectedSystemPromptFile(role.id, role.revision);
  if (role.systemPromptFile !== expected) {
    throw new Error(
      `Role ${role.id} has invalid systemPromptFile ${JSON.stringify(role.systemPromptFile)}`,
    );
  }
  return join(dirname(rolesPath), ROLE_PROMPTS_DIRECTORY, `${role.id}.${role.revision}.md`);
}

function readRolePrompt(
  rolesPath: string,
  role: PersistedRole,
): string {
  const promptDirectory = promptDirectoryPath(rolesPath);
  const promptPath = promptPathFor(rolesPath, role);

  let directoryStats;
  try {
    directoryStats = lstatSync(promptDirectory);
  } catch (error) {
    throw new Error(`Unable to read role system prompt at ${promptPath}`, {
      cause: error,
    });
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`Role system prompt directory is not a regular directory: ${promptDirectory}`);
  }

  let promptStats;
  try {
    promptStats = lstatSync(promptPath);
  } catch (error) {
    throw new Error(`Unable to read role system prompt at ${promptPath}`, {
      cause: error,
    });
  }
  if (!promptStats.isFile()) {
    throw new Error(`Role system prompt is not a regular file: ${promptPath}`);
  }
  if (promptStats.size > MAX_ROLE_SYSTEM_PROMPT_BYTES) {
    throw new Error(
      `Role system prompt must be at most ${MAX_ROLE_SYSTEM_PROMPT_BYTES} UTF-8 bytes: ${promptPath}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(promptPath);
  } catch (error) {
    throw new Error(`Unable to read role system prompt at ${promptPath}`, {
      cause: error,
    });
  }
  if (bytes.byteLength > MAX_ROLE_SYSTEM_PROMPT_BYTES) {
    throw new Error(
      `Role system prompt must be at most ${MAX_ROLE_SYSTEM_PROMPT_BYTES} UTF-8 bytes: ${promptPath}`,
    );
  }
  try {
    return ROLE_PROMPT_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`Role system prompt is not valid UTF-8: ${promptPath}`, {
      cause: error,
    });
  }
}

function validateRolePrompts(
  rolesPath: string,
  document: RoleStoreDocument,
): void {
  for (const role of document.roles) {
    readRolePrompt(rolesPath, role);
  }
}

async function ensurePromptDirectory(rolesPath: string): Promise<void> {
  const promptDirectory = promptDirectoryPath(rolesPath);
  await mkdir(promptDirectory, { recursive: true });
  const directoryStats = await lstat(promptDirectory);
  if (!directoryStats.isDirectory()) {
    throw new Error(`Role prompt directory is not a regular directory: ${promptDirectory}`);
  }
}

async function writeRolePromptAtomically(
  rolesPath: string,
  role: PersistedRole,
  prompt: string,
): Promise<void> {
  const promptPath = promptPathFor(rolesPath, role);
  await ensurePromptDirectory(rolesPath);
  const temporaryPath = join(
    dirname(promptPath),
    `.${basename(promptPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, Buffer.from(prompt, "utf8"), {
      flag: "wx",
    });
    await rename(temporaryPath, promptPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function writeRolePromptsForRoles(
  rolesPath: string,
  roles: readonly RoleTemplateV1[],
): Promise<void> {
  for (const role of roles) {
    await writeRolePromptAtomically(rolesPath, toPersistedRole(role), role.systemPrompt);
  }
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

interface PromptWrite {
  role: PersistedRole;
  content: string;
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
    let existingRaw: string | undefined;
    try {
      existingRaw = await readFile(rolesPath, "utf8");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    if (existingRaw !== undefined) {
      const parsed = parseRoleStoreDocument(existingRaw, rolesPath);
      if (parsed.migrated) {
        document = documentFromLegacyRoles(parsed.legacyRoles);
        await writeRolePromptsForRoles(rolesPath, parsed.legacyRoles);
        await writeRoleStoreAtomically(rolesPath, document);
      } else {
        document = parsed.document;
        try {
          validateRolePrompts(rolesPath, document);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Invalid role store at ${rolesPath}: ${detail}`, {
            cause: error,
          });
        }
      }
    } else {
      const model = parseModelReference(initialModel, "initialModel");
      const timestamp = new Date().toISOString();
      const role: RoleTemplateV1 = {
        id: "default",
        revision: 1,
        name: "默认",
        description: "默认角色",
        systemPrompt: "",
        model,
        defaultThinkingLevel: "off",
        toolMode: "read_only",
        canManageSessions: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const persistedRole = toPersistedRole(role);
      document = {
        version: ROLE_STORE_VERSION,
        roles: [persistedRole],
      };
      await writeRolePromptAtomically(rolesPath, persistedRole, role.systemPrompt);
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
    return this.document.roles.map((role) => readHydratedRole(this.rolesPath, role));
  }

  getRole(roleId: string): RoleTemplateV1 | undefined {
    const role = this.document.roles.find(({ id }) => id === roleId);
    return role === undefined
      ? undefined
      : readHydratedRole(this.rolesPath, role);
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
      const persistedRole = toPersistedRole(role);
      const next: RoleStoreDocument = {
        version: ROLE_STORE_VERSION,
        roles: [...this.document.roles, persistedRole],
      };
      await this.commit(next, {
        role: persistedRole,
        content: role.systemPrompt,
      });
      return readHydratedRole(this.rolesPath, persistedRole);
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
      const currentHydrated = readHydratedRole(this.rolesPath, current);
      if (draftsAreEqual(currentHydrated, draft)) return cloneRole(currentHydrated);
      this.assertNameAvailable(draft.name, roleId);
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error(`Role revision is exhausted: ${roleId}`);
      }

      const updatedRole: RoleTemplateV1 = {
        id: current.id,
        revision: current.revision + 1,
        ...draft,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const updated = toPersistedRole(updatedRole);
      const roles = [...this.document.roles];
      roles[index] = updated;
      const oldPromptPath = promptPathFor(this.rolesPath, current);
      await this.commit({
        version: ROLE_STORE_VERSION,
        roles,
      }, {
        role: updated,
        content: updatedRole.systemPrompt,
      }, oldPromptPath);
      return readHydratedRole(this.rolesPath, updated);
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
      }, undefined, promptPathFor(this.rolesPath, current));
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

  private async commit(
    document: RoleStoreDocument,
    promptWrite?: PromptWrite,
    cleanupPromptPath?: string,
  ): Promise<void> {
    if (promptWrite !== undefined) {
      await writeRolePromptAtomically(
        this.rolesPath,
        promptWrite.role,
        promptWrite.content,
      );
    }
    await writeRoleStoreAtomically(this.rolesPath, document);
    this.document = cloneDocument(document);
    this.emit();
    if (cleanupPromptPath !== undefined) {
      await unlink(cleanupPromptPath).catch(() => undefined);
    }
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

function draftsAreEqual(
  role: RoleTemplateV1,
  draft: RoleDraft,
): boolean {
  return (
    role.name === draft.name
    && role.description === draft.description
    && role.systemPrompt === draft.systemPrompt
    && modelsAreEqual(role.model, draft.model)
    && role.defaultThinkingLevel === draft.defaultThinkingLevel
    && role.toolMode === draft.toolMode
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

function readHydratedRole(
  rolesPath: string,
  role: PersistedRole,
): RoleTemplateV1 {
  return {
    id: role.id,
    revision: role.revision,
    name: role.name,
    description: role.description,
    systemPrompt: readRolePrompt(rolesPath, role),
    model: cloneModel(role.model),
    defaultThinkingLevel: role.defaultThinkingLevel,
    toolMode: role.toolMode,
    canManageSessions: role.canManageSessions,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}
