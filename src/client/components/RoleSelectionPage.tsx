import type { RoleTemplate } from "../../shared/protocol";

export interface RoleSelectionPageProps {
  roles: RoleTemplate[];
  pending?: boolean;
  onStart(roleId: string): void;
  onManageRole?(roleId: string): void;
  onAddRole?(): void;
  onSettings?(): void;
}

function roleModelLabel(role: RoleTemplate): string {
  if (role.model === null) return "尚未选择模型";
  return role.model.id;
}

export function RoleSelectionPage({
  roles,
  pending = false,
  onStart,
  onManageRole,
  onAddRole,
  onSettings,
}: RoleSelectionPageProps) {
  return <main className="role-selection-page">
    <header className="role-selection-header">
      <div>
        <p className="eyebrow">NEW CONVERSATION</p>
        <h1>选择这个会话的角色</h1>
        <p>角色和模型会作为会话的初始配置；会话空闲时可在角色详情中更换。</p>
      </div>
      {onSettings && <div className="role-selection-header-actions">
        <button
          type="button"
          className="ghost"
          disabled={pending}
          onClick={onSettings}
        >
          模型连接
        </button>
      </div>}
    </header>

    <section className="role-card-grid" aria-label="可选角色">
      {roles.map((role) => {
        const unavailable = !role.available;
        const className = [
          "role-card",
          unavailable ? "unavailable" : "",
        ].filter(Boolean).join(" ");
        return <article
          key={role.id}
          className={className}
          aria-label={`角色 ${role.name}`}
        >
          <span className="role-card-heading">
            <strong>{role.name}</strong>
          </span>
          <span className="role-card-description">
            {role.description || "暂无角色简介"}
          </span>
          <small className="role-card-model">
            {roleModelLabel(role)} · {
              role.toolMode === "full_access" ? "全部授权" : "只读"
            }
          </small>
          {unavailable && <span className="inline-status error">
            {role.unavailableReason ?? "此角色当前不可用"}
          </span>}
          <span className="role-card-actions">
            {onManageRole && <button
              type="button"
              className="role-card-action ghost"
              aria-label={`管理角色 ${role.name}`}
              title="管理角色"
              disabled={pending}
              onClick={() => onManageRole(role.id)}
            >
              <span aria-hidden="true">⚙</span>
            </button>}
            <button
              type="button"
              className="role-card-action role-card-start"
              aria-label={`使用 ${role.name} 开始会话`}
              title={unavailable
                ? role.unavailableReason ?? "此角色当前不可用"
                : "开始会话"}
              disabled={pending || unavailable}
              onClick={() => onStart(role.id)}
            >
              <span aria-hidden="true">▶</span>
            </button>
          </span>
        </article>;
      })}
      {onAddRole && <button
        type="button"
        className="role-card role-card-add"
        aria-label="添加角色"
        disabled={pending}
        onClick={onAddRole}
      >
        <span className="role-card-add-icon" aria-hidden="true">＋</span>
        <strong>添加角色</strong>
      </button>}
      {roles.length === 0 && !onAddRole && <div className="setting-empty">
        <strong>还没有可选择的角色</strong>
        <p>先在角色管理中配置一个可用角色和模型。</p>
      </div>}
    </section>
  </main>;
}
