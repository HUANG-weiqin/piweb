import type { ConversationRoleSnapshot } from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

export interface ConversationRoleDialogProps {
  open: boolean;
  role: ConversationRoleSnapshot;
  onClose(): void;
}

export function ConversationRoleDialog({
  open,
  role,
  onClose,
}: ConversationRoleDialogProps) {
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
          <p>此角色快照在会话创建时固定。</p>
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

      <button type="button" className="ghost" onClick={onClose}>
        关闭
      </button>
    </section>
  </div>;
}
