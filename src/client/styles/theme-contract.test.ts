import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_LIST } from "../lib/theme-registry";

const stylesDir = new URL("./", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, stylesDir), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Custom properties declared in the top-level block whose selector list contains `selector`. */
function blockTokens(css: string, selector: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of match[2].matchAll(/(--[\w-]+)\s*:/g)) tokens.add(decl[1]);
  }
  return tokens;
}

const componentFiles = readdirSync(stylesDir).filter((file) => file.endsWith(".css") && file !== "tokens.css");
const referencePalette = blockTokens(read("themes/quiet-rebel.css"), 'html[data-color-scheme="quiet-rebel"]');
const referenceCore = [...blockTokens(read("skins/rebel.css"), 'html[data-skin="rebel"]')]
  .filter((token) => !token.startsWith("--decor-"));

describe("theme CSS contract", () => {
  it("has a reference palette and skin to compare against", () => {
    expect(referencePalette.size).toBeGreaterThan(50);
    expect(referenceCore).toContain("--font-ui");
    expect(referenceCore).toContain("--type-scale");
  });

  it.each(THEME_LIST.map((theme) => [theme.id]))("palette %s defines every palette token", (id) => {
    const tokens = blockTokens(read(`themes/${id}.css`), `html[data-color-scheme="${id}"]`);
    expect([...referencePalette].filter((token) => !tokens.has(token))).toEqual([]);
    expect([...tokens].filter((token) => !referencePalette.has(token))).toEqual([]);
  });

  it.each([...new Set(THEME_LIST.map((theme) => theme.skin))].map((skin) => [skin]))(
    "skin %s defines the full skin contract",
    (skin) => {
      const tokens = blockTokens(read(`skins/${skin}.css`), `html[data-skin="${skin}"]`);
      expect(referenceCore.filter((token) => !tokens.has(token))).toEqual([]);
    },
  );

  it("loads every palette and skin from the stylesheet entry", () => {
    const entry = readFileSync(new URL("../styles.css", stylesDir), "utf8");
    for (const theme of THEME_LIST) {
      expect(entry).toContain(`@import "./styles/themes/${theme.id}.css";`);
      expect(entry).toContain(`@import "./styles/skins/${theme.skin}.css";`);
    }
  });

  it("gives every decoration token a neutral fallback at its use site", () => {
    const bare: string[] = [];
    for (const file of componentFiles) {
      for (const match of stripComments(read(file)).matchAll(/var\((--decor-[\w-]+)\s*\)/g)) {
        bare.push(`${file}: ${match[1]}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("keeps theme-specific selectors out of component CSS", () => {
    const offenders = componentFiles.filter((file) => /data-color-scheme|data-skin=/.test(stripComments(read(file))));
    expect(offenders).toEqual([]);
  });
});
