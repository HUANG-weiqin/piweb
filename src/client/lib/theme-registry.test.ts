// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { COLOR_SCHEMES } from "../../shared/protocol";
import { applyTheme, isThemeId, THEME_LIST, THEMES } from "./theme-registry";

describe("theme registry", () => {
  it("registers every wire color scheme under its own id, in wire order", () => {
    expect(THEME_LIST.map((theme) => theme.id)).toEqual([...COLOR_SCHEMES]);
    for (const id of COLOR_SCHEMES) expect(THEMES[id].id).toBe(id);
  });

  it("projects palette, skin and tone onto the root element together", () => {
    const root = document.createElement("html");
    applyTheme(root, "classic-rebel");
    expect(root.dataset).toMatchObject({ colorScheme: "classic-rebel", skin: "rebel", tone: "poster" });
    applyTheme(root, "quiet-rebel");
    expect(root.dataset).toMatchObject({ colorScheme: "quiet-rebel", skin: "rebel", tone: "quiet" });
  });

  it("accepts only registered ids", () => {
    expect(isThemeId("quiet-rebel")).toBe(true);
    expect(isThemeId("toString")).toBe(false);
    expect(isThemeId("")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
  });
});
