import type { DirectoryListing } from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

export function DirectoryBrowserDialog({
  listing,
  loading,
  error,
  online,
  covered = false,
  onNavigate,
  onOpenStartup,
  onSelect,
  onClose,
}: {
  listing?: DirectoryListing;
  loading: boolean;
  error?: string;
  online: boolean;
  covered?: boolean;
  onNavigate(path: string): void;
  onOpenStartup(): void;
  onSelect(path: string): void;
  onClose(): void;
}) {
  const focusRef = useModalFocus<HTMLElement>(
    true,
    "directory-browser",
    onClose,
  );

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
      className="modal directory-browser-modal"
      role={covered ? undefined : "dialog"}
      aria-modal={covered ? undefined : "true"}
      aria-hidden={covered ? "true" : undefined}
      aria-labelledby="directory-browser-title"
      aria-busy={loading}
      tabIndex={-1}
    >
      <header className="modal-header">
        <div>
          <p className="eyebrow">PROJECT</p>
          <h2 id="directory-browser-title">选择项目目录</h2>
          <p className="modal-description">进入文件夹，然后选择当前目录。</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭目录选择"
          data-modal-autofocus
          onClick={onClose}
        >×</button>
      </header>

      <div className="directory-browser-location">
        <button
          type="button"
          className="ghost"
          disabled={!online || loading || !listing?.parentPath}
          onClick={() => listing?.parentPath && onNavigate(listing.parentPath)}
        >
          ← 上一级
        </button>
        <code title={listing?.path}>{listing?.path ?? "正在定位…"}</code>
      </div>

      {error && <div className="directory-browser-error">
        <p role="alert">{error}</p>
        {!listing && <button
          type="button"
          className="ghost"
          disabled={!online || loading}
          onClick={onOpenStartup}
        >
          打开启动目录
        </button>}
      </div>}

      <div
        className="directory-browser-list"
        role="group"
        aria-label="子文件夹"
        aria-busy={loading}
      >
        {!listing && loading && <p className="progress" role="status">
          正在读取目录…
        </p>}
        {listing?.directories.map((directory) => <button
          type="button"
          className="directory-browser-entry"
          aria-label={`打开文件夹 ${directory.name}`}
          title={directory.path}
          disabled={!online || loading}
          key={directory.path}
          onClick={() => onNavigate(directory.path)}
        >
          <span className="directory-browser-folder" aria-hidden="true" />
          <span>{directory.name}</span>
          <span aria-hidden="true">›</span>
        </button>)}
        {listing && !loading && listing.directories.length === 0 && <p className="directory-browser-empty">
          这个目录中没有子文件夹
        </p>}
      </div>

      {listing?.truncated && <p className="directory-browser-note">
        子文件夹过多，仅显示前 500 项。
      </p>}

      <div className="directory-browser-actions">
        <button type="button" className="ghost" onClick={onClose}>取消</button>
        <button
          type="button"
          disabled={!online || loading || !listing}
          onClick={() => listing && onSelect(listing.path)}
        >
          选择当前文件夹
        </button>
      </div>
    </section>
  </div>;
}
