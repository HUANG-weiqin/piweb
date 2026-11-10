import { COLOR_SCHEMES, type ColorScheme } from "../../shared/protocol";

/**
 * Shape language of a theme. Each skin owns `styles/skins/<skin>.css`: fonts,
 * size/radius/stroke/tracking dials, motion and elevation, plus any decoration
 * of its own. Decoration tokens a skin leaves undefined fall back to neutral.
 */
export type ThemeSkin = "rebel" | "code";

/**
 * How work surfaces and run states are colored.
 * - `quiet`: dark raised surfaces; running/waiting/done/failed use the
 *   palette's intent/warning/success/danger roles.
 * - `poster`: the high-contrast paper-and-oxide poster mapping.
 */
export type ThemeTone = "quiet" | "poster";

export interface ThemeDefinition {
  id: ColorScheme;
  name: string;
  description: string;
  skin: ThemeSkin;
  tone: ThemeTone;
  /** Fixed preview colors for the settings picker: frame, then three chips. */
  swatch: { frame: string; chips: readonly [string, string, string] };
}

export const THEMES: Readonly<Record<ColorScheme, ThemeDefinition>> = {
  "quiet-rebel": {
    id: "quiet-rebel",
    name: "Quiet Rebel",
    description: "低对比深色，保留克制的氧化红强调",
    skin: "rebel",
    tone: "quiet",
    swatch: { frame: "#141719", chips: ["#181c1e", "#1d2225", "#d97965"] },
  },
  "classic-rebel": {
    id: "classic-rebel",
    name: "Classic Rebel",
    description: "原有的高反差暗色与纸张色",
    skin: "rebel",
    tone: "poster",
    swatch: { frame: "#171a1b", chips: ["#1d2222", "#d8d1c1", "#b94f43"] },
  },
  "code-dark": {
    id: "code-dark",
    name: "Code Dark",
    description: "编辑器式平直深色：直角、细线、无装饰，蓝色强调",
    skin: "code",
    tone: "quiet",
    swatch: { frame: "#1e1e1e", chips: ["#252526", "#cccccc", "#007acc"] },
  },
};

/** Themes in the order the settings picker lists them. */
export const THEME_LIST: readonly ThemeDefinition[] = COLOR_SCHEMES.map((id) => THEMES[id]);

export function isThemeId(value: unknown): value is ColorScheme {
  return typeof value === "string" && Object.hasOwn(THEMES, value);
}

/** Projects a theme onto the root element; CSS selects palette, skin and tone from these. */
export function applyTheme(root: HTMLElement, id: ColorScheme): void {
  const theme = THEMES[id];
  root.dataset.colorScheme = theme.id;
  root.dataset.skin = theme.skin;
  root.dataset.tone = theme.tone;
}
