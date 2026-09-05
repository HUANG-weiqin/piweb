import { useLayoutEffect, useMemo, useState } from "react";
import type {
  ConversationRoleSnapshot,
  RoleTemplate,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

interface ConversationRoleDialogProps {
  open: boolean;
  role: ConversationRoleSnapshot;
  roles: RoleTemplate[];
  switchDisabled: boolean;
  switching: boolean;
  onSwitch(roleId: string): void;
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
  useLayoutEffect(() => {
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
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onClose();
    }}
  >
    <section
      ref={focusRef}
      className="modal conversation-role-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="更换会话角色"
      tabIndex={-1}
    >
      <header className="modal-header">
        <div>
          <p className="eyebrow">SWITCH ROLE</p>
          <h2>更换会话角色</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="conversation-role-switch">
        <label htmlFor="conversation-role-select">
          当前角色：{role.name} · {role.model.id}
        </label>
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
        取消
      </button>
    </section>
  </div>;
}
