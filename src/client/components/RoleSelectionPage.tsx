import { useEffect, useState } from "react";
import type { RoleTemplate } from "../../shared/protocol";

export interface RoleSelectionPageProps {
  roles: RoleTemplate[];
  pending?: boolean;
  onStart(roleId: string): void;
  onManageRoles?(): void;
  onSettings?(): void;
  onChangeProject?(): void;
}

function roleModelLabel(role: RoleTemplate): string {
  if (role.model === null) return "尚未选择模型";
  return role.model.id;
}

export function RoleSelectionPage({
  roles,
  pending = false,
  onStart,
  onManageRoles,
  onSettings,
  onChangeProject,
}: RoleSelectionPageProps) {
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const selectedRole = roles.find(({ id }) => id === selectedRoleId);

  useEffect(() => {
    if (selectedRole?.available) return;
    setSelectedRoleId("");
  }, [selectedRole]);

  const start = () => {
    if (!pending && selectedRole?.available) onStart(selectedRole.id);
  };

  return <main className="role-selection-page">
    <header className="role-selection-header">
      <div>
        <p className="eyebrow">NEW CONVERSATION</p>
        <h1>选择这个会话的角色</h1>
        <p>角色和模型会在会话创建时固定，之后不能切换。</p>
      </div>
      <div className="role-selection-header-actions">
        {onChangeProject && <button
          type="button"
          className="ghost"
          disabled={pending}
          onClick={onChangeProject}
        >
          切换项目
        </button>}
        {onSettings && <button
          type="button"
          className="ghost"
          disabled={pending}
          onClick={onSettings}
        >
          模型连接
        </button>}
        {onManageRoles && <button
          type="button"
          className="ghost"
          disabled={pending}
          onClick={onManageRoles}
        >
          管理角色
        </button>}
      </div>
    </header>

    <section className="role-card-grid" aria-label="可选角色">
      {roles.map((role) => {
        const selected = role.id === selectedRoleId;
        const unavailable = !role.available;
        const className = [
          "role-card",
          selected ? "selected" : "",
          unavailable ? "unavailable" : "",
        ].filter(Boolean).join(" ");
        return <button
          type="button"
          key={role.id}
          className={className}
          aria-label={`选择角色 ${role.name}`}
          aria-pressed={selected}
          disabled={pending || unavailable}
          onClick={() => setSelectedRoleId(role.id)}
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
        </button>;
      })}
      {onManageRoles && <button
        type="button"
        className="role-card role-card-add"
        aria-label="添加角色"
        disabled={pending}
        onClick={onManageRoles}
      >
        <span className="role-card-add-icon" aria-hidden="true">＋</span>
        <strong>添加角色</strong>
      </button>}
      {roles.length === 0 && !onManageRoles && <div className="setting-empty">
        <strong>还没有可选择的角色</strong>
        <p>先在角色管理中配置一个可用角色和模型。</p>
      </div>}
    </section>

    <footer className="role-selection-actions">
      <button
        type="button"
        disabled={pending || !selectedRole?.available}
        onClick={start}
      >
        {pending ? "正在创建会话…" : "开始新会话"}
      </button>
    </footer>
  </main>;
}
