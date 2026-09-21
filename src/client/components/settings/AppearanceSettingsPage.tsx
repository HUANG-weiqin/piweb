import type { ColorScheme } from "../../../shared/protocol";

interface AppearanceSettingsPageProps {
  colorScheme: ColorScheme;
  colorSchemePending: boolean;
  colorSchemeUnsaved: boolean;
  colorSchemeError: string;
  preferencesOnline: boolean;
  onColorSchemeChange(colorScheme: ColorScheme): void;
  onRetryColorScheme(): void;
}

export function AppearanceSettingsPage({
  colorScheme,
  colorSchemePending,
  colorSchemeUnsaved,
  colorSchemeError,
  preferencesOnline,
  onColorSchemeChange,
  onRetryColorScheme,
}: AppearanceSettingsPageProps) {
  return <section
    className="settings-section appearance-settings settings-page"
    aria-labelledby="appearance-settings-heading"
  >
    <div className="settings-section-heading">
      <p className="eyebrow">APPEARANCE</p>
      <h3 id="appearance-settings-heading">配色</h3>
      <p className="setting-note">只改变这个用户的 Pi Web 外观，不写入项目。</p>
    </div>
    <fieldset className="color-scheme-options" disabled={colorSchemePending}>
      <legend>选择配色</legend>
      <label className="color-scheme-option">
        <input
          type="radio"
          name="color-scheme"
          value="quiet-rebel"
          checked={colorScheme === "quiet-rebel"}
          onChange={() => onColorSchemeChange("quiet-rebel")}
        />
        <span className="color-scheme-swatch quiet-rebel-swatch" aria-hidden="true">
          <i /><i /><i />
        </span>
        <span><strong>Quiet Rebel</strong><small>低对比深色，保留克制的氧化红强调</small></span>
      </label>
      <label className="color-scheme-option">
        <input
          type="radio"
          name="color-scheme"
          value="classic-rebel"
          checked={colorScheme === "classic-rebel"}
          onChange={() => onColorSchemeChange("classic-rebel")}
        />
        <span className="color-scheme-swatch classic-rebel-swatch" aria-hidden="true">
          <i /><i /><i />
        </span>
        <span><strong>Classic Rebel</strong><small>原有的高反差暗色与纸张色</small></span>
      </label>
    </fieldset>
    {colorSchemePending && <p className="inline-status" role="status">正在保存配色…</p>}
    {colorSchemeUnsaved && !colorSchemePending && <div className="preference-unsaved">
      <p className="inline-status error" role="alert">
        {colorSchemeError || "当前配色尚未保存。"}
      </p>
      <button
        type="button"
        className="ghost"
        disabled={!preferencesOnline}
        onClick={onRetryColorScheme}
      >重试保存</button>
    </div>}
  </section>;
}