import type { ColorScheme } from "../../../shared/protocol";
import { THEME_LIST } from "../../lib/theme-registry";

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
      {THEME_LIST.map((theme) => <label className="color-scheme-option" key={theme.id}>
        <input
          type="radio"
          name="color-scheme"
          value={theme.id}
          checked={colorScheme === theme.id}
          onChange={() => onColorSchemeChange(theme.id)}
        />
        <span
          className="color-scheme-swatch"
          style={{ background: theme.swatch.frame }}
          aria-hidden="true"
        >
          {theme.swatch.chips.map((chip, index) => <i key={index} style={{ background: chip }} />)}
        </span>
        <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
      </label>)}
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