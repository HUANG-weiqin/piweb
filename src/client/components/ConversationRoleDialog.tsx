import { useEffect, useMemo, useState } from "react";
import type {
  ConversationRoleSnapshot,
  RoleTemplate,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

export interface ConversationRoleDialogProps {
  open: boolean;
  role: ConversationRoleSnapshot;
  roles: RoleTemplate[];
  switchDisabled: boolean;
  switching: boolean;
  onSwitch(roleId: string): boolean;
  onClose(): void;
}

export function ConversationRoleDialog({
  open,
  role,
  roles,
  switchDisabled,
  switching,
  onSwitch,
  onClose,
}: ConversationRoleDialogProps) {
  const availableRoles = useMemo(
    () => roles.filter((candidate) =>
      candidate.available && candidate.model !== null
    ),
    [roles],
  );
  const [selectedRoleId, setSelectedRoleId] = useState("");
  useEffect(() => {
    if (!open) return;
    setSelectedRoleId(
      availableRoles.find(({ id }) => id === role.id)?.id
      ?? availableRoles[0]?.id
      ?? "",
    );
  }, [availableRoles, open, role.id, role.revision]);
  const selectedRole = availableRoles.find(
    ({ id }) => id === selectedRoleId,
  );
  const selectedRoleIsCurrent = (
    selectedRole?.id === role.id
    && selectedRole.revision === role.revision
  );
  const focusRef = useModalFocus<HTMLElement>(
    open,
    `${role.id}:${role.revision}`,
    onClose,
  );
  if (!open) return null;

  return <div
    className="modal-backdrop"
    role="presentation"
    onMouseDown={(event) => event.target === event.currentTarget && onClose()}
  >
    <section
      ref={focusRef}
      className="modal conversation-role-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="会话角色"
      tabIndex={-1}
    >
      <header className="modal-header">
        <div>
          <p className="eyebrow">CONVERSATION ROLE</p>
          <h2>{role.name}</h2>
          <p>会话空闲时可从角色模板应用新的角色快照。</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭会话角色详情"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <dl className="conversation-role-details">
        <div>
          <dt>简介</dt>
          <dd>{role.description || "暂无角色简介"}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{role.model.id}</dd>
        </div>
        <div>
          <dt>模板版本</dt>
          <dd>修订 {role.revision}</dd>
        </div>
        <div>
          <dt>会话管理</dt>
          <dd>{role.canManageSessions ? "允许" : "不允许"}</dd>
        </div>
        <div>
          <dt>工具权限</dt>
          <dd>{role.toolMode === "full_access" ? "全部授权" : "只读"}</dd>
        </div>
        <div>
          <dt>专属提示词</dt>
          <dd className="role-prompt-preview">{role.systemPrompt || "未设置专属提示词"}</dd>
        </div>
      </dl>

      <div className="conversation-role-switch">
        <label htmlFor="conversation-role-select">更换角色</label>
        <select
          id="conversation-role-select"
          aria-label="选择新的会话角色"
          value={selectedRoleId}
          disabled={switchDisabled || switching || availableRoles.length === 0}
          onChange={(event) => setSelectedRoleId(event.target.value)}
        >
          {availableRoles.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name} · {candidate.model?.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={
            switchDisabled
            || switching
            || !selectedRoleId
            || selectedRoleIsCurrent
          }
          onClick={() => onSwitch(selectedRoleId)}
        >
          {switching ? "正在更换…" : "应用角色"}
        </button>
        <small>
          {switchDisabled
            ? "请等待当前会话和待提交消息全部空闲。"
            : "更换后，下一轮将使用新角色的模型、提示词和权限。"}
        </small>
      </div>

      <button type="button" className="ghost" onClick={onClose}>
        关闭
      </button>
    </section>
  </div>;
}
