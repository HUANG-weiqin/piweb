import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  PublicProvider,
  RoleModelSelection,
  RoleTemplate,
  ServiceTier,
  ThinkingLevel,
} from "../../shared/protocol";
import { THINKING_LEVEL_LABELS } from "../lib/thinking-level";
import { useModalFocus } from "../lib/use-modal-focus";

const NEW_ROLE_ID = "__new__";

const SERVICE_TIER_LABELS: Record<ServiceTier, string> = {
  auto: "自动",
  default: "默认",
  flex: "弹性",
  scale: "扩展",
  priority: "快速",
};

type RoleOperation =
  | "create_role"
  | "update_role"
  | "delete_role";

export interface RoleDraft {
  name: string;
  description: string;
  systemPrompt: string;
  model: RoleModelSelection | null;
  defaultThinkingLevel: ThinkingLevel;
  defaultServiceTier: ServiceTier | null;
  toolMode: "read_only" | "full_access";
  canManageSessions: boolean;
}

export interface PendingRoleOperation {
  operation: RoleOperation;
  commandId: string;
}

export interface RoleOperationResult extends PendingRoleOperation {
  ok: boolean;
  message: string;
}

interface RoleManagerDialogProps {
  open: boolean;
  roles: RoleTemplate[];
  providers: PublicProvider[];
  initialRoleId?: string | null;
  pending?: PendingRoleOperation;
  result?: RoleOperationResult;
  onClose(): void;
  onCreate(role: RoleDraft): void;
  onUpdate(
    roleId: string,
    expectedRevision: number,
    expectedSystemPrompt: string,
    role: RoleDraft,
  ): void;
  onDelete(roleId: string, expectedRevision: number): void;
}

interface RoleEditBase {
  roleId: string;
  revision: number;
  systemPrompt: string;
}

interface SubmittedRoleUpdate {
  base: RoleEditBase;
  localDraft: RoleDraft;
  sentDraft: RoleDraft;
  commandId?: string;
}

interface ModelOption {
  value: string;
  provider: string;
  id: string;
  label: string;
  thinkingLevels: ThinkingLevel[];
  serviceTiers: ServiceTier[];
}

const emptyDraft: RoleDraft = {
  name: "",
  description: "",
  systemPrompt: "",
  model: null,
  defaultThinkingLevel: "off",
  defaultServiceTier: null,
  toolMode: "read_only",
  canManageSessions: false,
};

function roleDraft(role: RoleTemplate): RoleDraft {
  return {
    name: role.name,
    description: role.description,
    systemPrompt: role.systemPrompt,
    model: role.model === null ? null : { ...role.model },
    defaultThinkingLevel: role.defaultThinkingLevel,
    defaultServiceTier: role.defaultServiceTier,
    toolMode: role.toolMode,
    canManageSessions: role.canManageSessions,
  };
}

function copyDraft(draft: RoleDraft): RoleDraft {
  return {
    ...draft,
    model: draft.model === null ? null : { ...draft.model },
  };
}

function sameDraft(left: RoleDraft, right: RoleDraft): boolean {
  return left.name === right.name
    && left.description === right.description
    && left.systemPrompt === right.systemPrompt
    && (left.model === null
      ? right.model === null
      : right.model !== null && sameModel(left.model, right.model))
    && left.defaultThinkingLevel === right.defaultThinkingLevel
    && left.defaultServiceTier === right.defaultServiceTier
    && left.toolMode === right.toolMode
    && left.canManageSessions === right.canManageSessions;
}

function roleEditBase(role: RoleTemplate): RoleEditBase {
  return {
    roleId: role.id,
    revision: role.revision,
    systemPrompt: role.systemPrompt,
  };
}

function requestedRole(
  roles: readonly RoleTemplate[],
  initialRoleId: string | null | undefined,
): RoleTemplate | undefined {
  if (initialRoleId === null) return undefined;
  return roles.find(({ id }) => id === initialRoleId) ?? roles[0];
}

function modelValue(model: RoleModelSelection): string {
  return JSON.stringify([model.provider, model.id]);
}

function sameModel(
  left: RoleModelSelection,
  right: RoleModelSelection,
): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function availableModelOptions(
  providers: readonly PublicProvider[],
): ModelOption[] {
  return providers.flatMap((provider) => {
    if (!provider.configured) return [];
    return provider.models
      .filter((model) => model.available)
      .map((model) => ({
        value: modelValue(model),
        provider: model.provider,
        id: model.id,
        label: model.name,
        thinkingLevels: [...model.thinkingLevels],
        serviceTiers: [...(model.serviceTiers ?? [])],
      }));
  });
}

function matchesPending(
  pending: PendingRoleOperation | undefined,
  result: RoleOperationResult | undefined,
): result is RoleOperationResult {
  return Boolean(
    pending
    && result
    && pending.operation === result.operation
    && pending.commandId === result.commandId,
  );
}

export function RoleManagerDialog({
  open,
  roles,
  providers,
  initialRoleId,
  pending,
  result,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: RoleManagerDialogProps) {
  const initialRole = requestedRole(roles, initialRoleId);
  const [selectedRoleId, setSelectedRoleId] = useState(
    initialRole?.id ?? NEW_ROLE_ID,
  );
  const [draft, setDraft] = useState<RoleDraft>(
    initialRole ? roleDraft(initialRole) : emptyDraft,
  );
  const [base, setBase] = useState<RoleEditBase | undefined>(
    initialRole ? roleEditBase(initialRole) : undefined,
  );
  const submittedUpdateRef = useRef<SubmittedRoleUpdate | undefined>(undefined);
  const selectedRole = roles.find(({ id }) => id === selectedRoleId);
  const creating = selectedRoleId === NEW_ROLE_ID;
  const draftSourceKey = creating
    ? NEW_ROLE_ID
    : selectedRole
      ? selectedRole.id
      : `missing:${selectedRoleId}:${roles[0]?.id ?? ""}`;
  const modelOptions = useMemo(
    () => availableModelOptions(providers),
    [providers],
  );
  const exactResult = matchesPending(pending, result) ? result : undefined;
  const operationBusy = Boolean(pending && !exactResult);

  useEffect(() => {
    if (creating) {
      setBase(undefined);
      setDraft(emptyDraft);
      return;
    }
    if (selectedRole) {
      setBase(roleEditBase(selectedRole));
      setDraft(roleDraft(selectedRole));
      return;
    }
    const next = roles[0];
    setSelectedRoleId(next?.id ?? NEW_ROLE_ID);
    setBase(next ? roleEditBase(next) : undefined);
    setDraft(next ? roleDraft(next) : emptyDraft);
  }, [draftSourceKey]);

  useEffect(() => {
    if (!open) return;
    const nextRole = requestedRole(roles, initialRoleId);
    setSelectedRoleId(nextRole?.id ?? NEW_ROLE_ID);
    setBase(nextRole ? roleEditBase(nextRole) : undefined);
    setDraft(nextRole ? roleDraft(nextRole) : emptyDraft);
  }, [open, initialRoleId]);

  useEffect(() => {
    const submitted = submittedUpdateRef.current;
    if (!submitted) return;
    if (
      !submitted.commandId
      && pending?.operation === "update_role"
    ) {
      submitted.commandId = pending.commandId;
    }
    if (
      !submitted.commandId
      || exactResult?.operation !== "update_role"
      || exactResult.commandId !== submitted.commandId
      || !exactResult.ok
      || !selectedRole
      || selectedRole.id !== submitted.base.roleId
      || !sameDraft(roleDraft(selectedRole), submitted.sentDraft)
    ) return;

    submittedUpdateRef.current = undefined;
    setBase(roleEditBase(selectedRole));
    setDraft((current) => (
      sameDraft(current, submitted.localDraft)
        ? roleDraft(selectedRole)
        : current
    ));
  }, [exactResult, pending, selectedRole]);

  const close = operationBusy ? undefined : onClose;
  const focusRef = useModalFocus<HTMLElement>(
    open,
    "role-manager",
    close,
  );
  if (!open) return null;

  const selectRole = (role: RoleTemplate) => {
    if (operationBusy) return;
    setSelectedRoleId(role.id);
    setBase(roleEditBase(role));
    setDraft(roleDraft(role));
  };
  const selectNewRole = () => {
    if (operationBusy) return;
    setSelectedRoleId(NEW_ROLE_ID);
    setBase(undefined);
    setDraft(emptyDraft);
  };
  const updateDraft = <K extends keyof RoleDraft>(
    key: K,
    value: RoleDraft[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (operationBusy || !draft.name.trim() || draft.model === null) return;
    const nextDraft: RoleDraft = {
      ...draft,
      name: draft.name.trim(),
      model: { ...draft.model },
    };
    if (creating) {
      onCreate(nextDraft);
    } else if (selectedRole && base?.roleId === selectedRole.id) {
      submittedUpdateRef.current = {
        base: { ...base },
        localDraft: copyDraft(draft),
        sentDraft: copyDraft(nextDraft),
      };
      onUpdate(
        base.roleId,
        base.revision,
        base.systemPrompt,
        nextDraft,
      );
    }
  };
  const selectModel = (value: string) => {
    const model = modelOptions.find((option) => option.value === value);
    if (!model) return;
    setDraft((current) => ({
      ...current,
      model: { provider: model.provider, id: model.id },
      defaultThinkingLevel: model.thinkingLevels.includes(
        current.defaultThinkingLevel,
      )
        ? current.defaultThinkingLevel
        : model.thinkingLevels[0] ?? "off",
      defaultServiceTier: current.defaultServiceTier !== null
        && model.serviceTiers.includes(current.defaultServiceTier)
        ? current.defaultServiceTier
        : null,
    }));
  };
  const currentModelOption = draft.model === null
    ? undefined
    : modelOptions.find((option) => sameModel(option, draft.model!));
  const currentModelAvailable = currentModelOption !== undefined;
  const availableThinkingLevels = currentModelOption?.thinkingLevels ?? [];
  const currentThinkingLevelAvailable = availableThinkingLevels.includes(
    draft.defaultThinkingLevel,
  );
  const thinkingLevelSelectable = availableThinkingLevels.length > 1;
  const availableServiceTiers = currentModelOption?.serviceTiers ?? [];
  const currentServiceTierAvailable = draft.defaultServiceTier === null
    || availableServiceTiers.includes(draft.defaultServiceTier);
  const modelSelectValue = draft.model === null ? "" : modelValue(draft.model);

  return <div
    className="modal-backdrop"
    role="presentation"
    onMouseDown={(event) => event.target === event.currentTarget && close?.()}
  >
    <section
      ref={focusRef}
      className="modal role-manager-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="管理角色"
      aria-busy={operationBusy}
      tabIndex={-1}
    >
      <header className="modal-header">
        <div>
          <p className="eyebrow">AGENT ROLES</p>
          <h2>管理角色</h2>
          <p>角色模板会在新会话创建时复制为不可变快照。</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭角色管理"
          disabled={operationBusy}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="role-manager-layout">
        <aside className="role-manager-list" aria-label="角色列表">
          <button
            type="button"
            className={creating ? "role-manager-new selected" : "role-manager-new"}
            disabled={operationBusy}
            aria-pressed={creating}
            onClick={selectNewRole}
          >
            新建角色
          </button>
          {roles.map((role) => <button
            type="button"
            key={role.id}
            className={[
              "role-manager-item",
              role.id === selectedRoleId ? "selected" : "",
              role.available ? "" : "unavailable",
            ].filter(Boolean).join(" ")}
            aria-label={`编辑角色 ${role.name}`}
            aria-pressed={role.id === selectedRoleId}
            disabled={operationBusy}
            onClick={() => selectRole(role)}
          >
            <span><strong>{role.name}</strong></span>
            {!role.available && <small>{role.unavailableReason ?? "当前不可用"}</small>}
          </button>)}
        </aside>

        <form className="role-manager-form" onSubmit={submit}>
          <div className="setting-field">
            <label htmlFor="role-name">角色名称</label>
            <input
              id="role-name"
              value={draft.name}
              maxLength={80}
              disabled={operationBusy}
              onChange={(event) => updateDraft("name", event.target.value)}
            />
          </div>
          <div className="setting-field">
            <label htmlFor="role-description">角色简介</label>
            <textarea
              id="role-description"
              value={draft.description}
              maxLength={1_000}
              disabled={operationBusy}
              onChange={(event) => updateDraft("description", event.target.value)}
            />
          </div>
          <div className="setting-field">
            <label htmlFor="role-system-prompt">专属提示词</label>
            <textarea
              id="role-system-prompt"
              className="role-system-prompt"
              value={draft.systemPrompt}
              disabled={operationBusy}
              onChange={(event) => updateDraft("systemPrompt", event.target.value)}
            />
          </div>
          <div className="setting-field">
            <label htmlFor="role-model">角色模型</label>
            <select
              id="role-model"
              value={modelSelectValue}
              disabled={operationBusy}
              onChange={(event) => selectModel(event.target.value)}
            >
              {draft.model === null && <option value="">选择模型…</option>}
              {draft.model !== null && !currentModelAvailable && <option
                value={modelValue(draft.model)}
                disabled
              >
                当前不可用 · {draft.model.id}
              </option>}
              {providers.map((provider) => {
                const options = modelOptions.filter(
                  (option) => option.provider === provider.id,
                );
                if (options.length === 0) return null;
                return <optgroup key={provider.id} label={provider.name}>
                  {options.map((option) => <option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>)}
                </optgroup>;
              })}
            </select>
            <p className="setting-note">仅列出已配置提供商当前可用的模型。</p>
          </div>
          <div className="setting-field">
            <label htmlFor="role-thinking-level">默认思考强度</label>
            <select
              id="role-thinking-level"
              value={draft.defaultThinkingLevel}
              disabled={operationBusy || !thinkingLevelSelectable}
              onChange={(event) => updateDraft(
                "defaultThinkingLevel",
                event.target.value as ThinkingLevel,
              )}
            >
              {!currentThinkingLevelAvailable && <option
                value={draft.defaultThinkingLevel}
                disabled
              >
                当前不支持 · {THINKING_LEVEL_LABELS[draft.defaultThinkingLevel]}
              </option>}
              {availableThinkingLevels.map((level) => <option
                key={level}
                value={level}
              >
                {availableThinkingLevels.length === 1
                  ? "模型默认"
                  : THINKING_LEVEL_LABELS[level]}
              </option>)}
            </select>
            <p className="setting-note">
              {availableThinkingLevels.length === 1
                ? "此模型没有可调思考强度，将使用模型默认行为。"
                : "创建会话或切换到此角色时采用；聊天页调整只影响当前运行会话。"}
            </p>
          </div>
          <div className="setting-field">
            <label htmlFor="role-service-tier">默认服务层级</label>
            <select
              id="role-service-tier"
              value={draft.defaultServiceTier === null
                ? ""
                : draft.defaultServiceTier}
              disabled={operationBusy || draft.model === null}
              onChange={(event) => updateDraft(
                "defaultServiceTier",
                event.target.value === ""
                  ? null
                  : event.target.value as ServiceTier,
              )}
            >
              <option value="">供应商默认</option>
              {!currentServiceTierAvailable && draft.defaultServiceTier !== null
                && <option value={draft.defaultServiceTier} disabled>
                  当前不支持 · {SERVICE_TIER_LABELS[draft.defaultServiceTier]}
                </option>}
              {availableServiceTiers.map((tier) => <option
                key={tier}
                value={tier}
              >
                {SERVICE_TIER_LABELS[tier]}
              </option>)}
            </select>
            <p className="setting-note">
              创建会话或切换到此角色时采用；聊天页可覆盖当前会话。
            </p>
          </div>
          <div className="setting-field">
            <label htmlFor="role-tool-mode">工具权限</label>
            <select
              id="role-tool-mode"
              value={draft.toolMode}
              disabled={operationBusy}
              onChange={(event) => {
                const mode = event.target.value as RoleDraft["toolMode"];
                updateDraft("toolMode", mode);
                if (mode === "read_only") {
                  updateDraft("canManageSessions", false);
                }
              }}
            >
              <option value="read_only">只读</option>
              <option value="full_access">全部授权</option>
            </select>
            <p className="setting-note">
              新角色默认只读；权限会随角色复制到新会话并固定。
            </p>
          </div>
          <label className="role-capability-switch">
            <span>
              <strong>允许管理会话</strong>
              <small>
                开启后可查看和控制项目中的其他会话；关闭后不会向此角色提供任何会话管理工具。
                {draft.toolMode === "read_only" &&
                  " 只读模式下不提供角色控制工具，已自动禁用。"}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={draft.canManageSessions}
              disabled={operationBusy || draft.toolMode === "read_only"}
              onChange={(event) =>
                updateDraft("canManageSessions", event.target.checked)}
            />
          </label>

          {exactResult && <p
            className={exactResult.ok ? "inline-status success" : "inline-status error"}
            role={exactResult.ok ? "status" : "alert"}
          >
            {exactResult.message || (exactResult.ok ? "角色已保存" : "操作失败")}
          </p>}

          <div className="role-manager-actions">
            {!creating && <button
              type="button"
              className="danger-button"
              disabled={operationBusy}
              onClick={() => selectedRole
                && base?.roleId === selectedRole.id
                && onDelete(base.roleId, base.revision)}
            >
              {operationBusy && pending?.operation === "delete_role"
                ? "正在删除…"
                : "删除角色"}
            </button>}
            <button
              type="submit"
              disabled={
                operationBusy
                || !draft.name.trim()
                || draft.model === null
              }
            >
              {operationBusy && pending?.operation === "create_role"
                ? "正在创建…"
                : operationBusy && pending?.operation === "update_role"
                  ? "正在保存…"
                  : creating
                    ? "创建角色"
                    : "保存角色"}
            </button>
          </div>
        </form>
      </div>
    </section>
  </div>;
}
