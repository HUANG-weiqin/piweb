import { memo, useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";

const MERMAID_MAX_SOURCE_LENGTH = 50_000;
export const MERMAID_MAX_BLOCKS_PER_CONTENT = 8;
export const MERMAID_MAX_TOTAL_SOURCE_LENGTH = 100_000;
const MERMAID_RENDER_TIMEOUT_MS = 10_000;
const MERMAID_MAX_DISPLAY_WIDTH = 8_192;
const MERMAID_EXTERNAL_RESOURCE_PATTERN = /(?:@\s*\{|(?:\bimg|["']img["'])\s*:|<\s*(?:img|image|iframe|object|embed|video|audio|source|link)\b|@import\b|(?:url|image-set)\s*\(|(?:https?|ftp|file|blob|data):)/i;
const MERMAID_SECURE_CONFIG_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "theme",
  "themeCSS",
  "themeVariables",
  "fontFamily",
  "htmlLabels",
];

type MermaidApi = typeof import("mermaid").default;
type MermaidTheme = "dark" | "default";
type MermaidRenderResult = Awaited<ReturnType<MermaidApi["render"]>>;

let mermaidApiPromise: Promise<MermaidApi> | undefined;
let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidUnavailable = false;
let mermaidId = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidApiPromise) {
    const load = import("mermaid").then(({ default: mermaid }) => mermaid);
    mermaidApiPromise = load.catch((error: unknown) => {
      mermaidApiPromise = undefined;
      throw error;
    });
  }
  return mermaidApiPromise;
}

function preferredTheme(): MermaidTheme {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "default";
}

function withMermaidWatchdog<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      mermaidUnavailable = true;
      reject(new Error("Mermaid render timed out"));
    }, MERMAID_RENDER_TIMEOUT_MS);
  });
  return Promise.race([operation, watchdog]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

async function performMermaidRender(
  source: string,
  isCurrent: () => boolean,
): Promise<MermaidRenderResult | undefined> {
  const mermaid = await loadMermaid();
  if (!isCurrent() || mermaidUnavailable) return undefined;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: MERMAID_MAX_SOURCE_LENGTH,
    maxEdges: 500,
    secure: MERMAID_SECURE_CONFIG_KEYS,
    theme: preferredTheme(),
  });
  return mermaid.render(`piweb-mermaid-${++mermaidId}`, source);
}

function enqueueMermaidRender(
  source: string,
  isCurrent: () => boolean,
): Promise<MermaidRenderResult | undefined> {
  const render = mermaidRenderQueue.then(() => {
    if (!isCurrent()) return undefined;
    if (mermaidUnavailable) throw new Error("Mermaid renderer is unavailable");
    return withMermaidWatchdog(performMermaidRender(source, isCurrent));
  });
  mermaidRenderQueue = render.then(
    () => undefined,
    () => undefined,
  );
  return render;
}

function isMermaidFence(token: Tokens.Code): boolean {
  return token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\(?:\r\n|[\n\r\f])/g, "")
    .replace(/\\([\da-f]{1,6}[\t\n\f\r ]?|.)/gis, (_match, escaped: string) => {
      const hex = escaped.match(/^[\da-f]{1,6}/i)?.[0];
      if (!hex) return escaped[0] ?? "";
      const codePoint = Number.parseInt(hex, 16);
      return codePoint === 0 || codePoint > 0x10_FFFF
        ? "\uFFFD"
        : String.fromCodePoint(codePoint);
    });
}

function normalizedResourceText(value: string): string {
  return decodeCssEscapes(value).replace(/\/\*[\s\S]*?\*\//g, "");
}

function hasUnsupportedMermaidResource(value: string): boolean {
  return MERMAID_EXTERNAL_RESOURCE_PATTERN.test(normalizedResourceText(value));
}

export function getMermaidSourceAnalysis(markdown: string): {
  hasMermaidFence: boolean;
  sourceLengths: readonly number[];
} {
  let hasMermaidFence = false;
  const sourceLengths: number[] = [];
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type !== "code" || !isMermaidFence(token as Tokens.Code)) return;
    hasMermaidFence = true;
    const source = (token as Tokens.Code).text.replace(/\n$/, "") + "\n";
    if (
      source.length <= MERMAID_MAX_SOURCE_LENGTH
      && !hasUnsupportedMermaidResource(source)
    ) {
      sourceLengths.push(source.length);
    }
  });
  return { hasMermaidFence, sourceLengths };
}

function renderMarkdown(markdown: string, mermaidMarker?: string): string {
  const renderer = new marked.Renderer();
  if (mermaidMarker) {
    const renderCode = renderer.code;
    renderer.code = function renderCodeToken(token) {
      const html = renderCode.call(this, token);
      return isMermaidFence(token)
        ? html.replace("<pre>", `<pre data-piweb-mermaid="${mermaidMarker}">`)
        : html;
    };
  }
  return DOMPurify.sanitize(marked.parse(markdown, {
    async: false,
    renderer,
  }) as string);
}

function createMarker(): string {
  return crypto.randomUUID();
}

function hasNonLocalCssResource(value: string): boolean {
  const withoutLocalFragments = normalizedResourceText(value).replace(
    /url\(\s*(["']?)#[^)"']+\1\s*\)/gi,
    "",
  );
  return /@import\b|(?:url|image-set)\s*\(/i.test(withoutLocalFragments);
}

function preserveReadableSvgWidth(svg: SVGSVGElement): void {
  const viewBox = svg.getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const naturalWidth = viewBox?.length === 4 ? viewBox[2] : undefined;
  if (naturalWidth === undefined || !Number.isFinite(naturalWidth) || naturalWidth <= 0) {
    return;
  }
  svg.style.removeProperty("min-width");
  svg.style.setProperty(
    "width",
    `${Math.min(Math.ceil(naturalWidth), MERMAID_MAX_DISPLAY_WIDTH)}px`,
    "important",
  );
  svg.style.setProperty("max-width", "none", "important");
}

function createDiagram(svg: string): HTMLDivElement {
  if (/<(?:foreignObject|image)\b/i.test(svg)) {
    throw new Error("Mermaid returned unsupported embedded content");
  }
  const safeSvg = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "image"],
  });
  const template = document.createElement("template");
  template.innerHTML = safeSvg;
  const svgElement = template.content.querySelector("svg");
  if (!svgElement) throw new Error("Mermaid did not return an SVG");

  for (const element of [svgElement, ...svgElement.querySelectorAll("*")]) {
    for (const attribute of ["href", "xlink:href", "src"]) {
      const value = element.getAttribute(attribute);
      if (value !== null && !value.trim().startsWith("#")) {
        element.removeAttribute(attribute);
      }
    }
    if (
      Array.from(element.attributes).some((attribute) => (
        hasNonLocalCssResource(attribute.value)
      ))
      || (element.localName === "style" && hasNonLocalCssResource(element.textContent ?? ""))
    ) {
      throw new Error("Mermaid returned an external CSS resource");
    }
  }
  preserveReadableSvgWidth(svgElement);
  svgElement.setAttribute("role", "img");
  if (
    !svgElement.hasAttribute("aria-label")
    && !svgElement.hasAttribute("aria-labelledby")
  ) {
    svgElement.setAttribute("aria-label", "Mermaid 图");
  }
  const diagram = document.createElement("div");
  diagram.className = "mermaid-diagram";
  diagram.append(svgElement);
  return diagram;
}

function showFallback(pre: HTMLPreElement, message: string): void {
  if (pre.nextElementSibling?.classList.contains("mermaid-error")) return;
  pre.classList.add("mermaid-fallback");
  const note = document.createElement("small");
  note.className = "mermaid-error";
  note.setAttribute("role", "note");
  note.textContent = message;
  pre.insertAdjacentElement("afterend", note);
}

interface MarkdownContentProps {
  markdown: string;
  className: string;
  renderMermaid?: boolean;
  mermaidMaxBlocks?: number;
  mermaidMaxTotalSourceLength?: number;
  onRenderSettled?(): void;
}

function MarkdownContentView({
  markdown,
  className,
  renderMermaid = false,
  mermaidMaxBlocks = MERMAID_MAX_BLOCKS_PER_CONTENT,
  mermaidMaxTotalSourceLength = MERMAID_MAX_TOTAL_SOURCE_LENGTH,
  onRenderSettled,
}: MarkdownContentProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => {
    const marker = renderMermaid ? createMarker() : undefined;
    return {
      html: renderMarkdown(markdown, marker),
      marker,
    };
  }, [
    markdown,
    mermaidMaxBlocks,
    mermaidMaxTotalSourceLength,
    renderMermaid,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !rendered.marker) return;
    let cancelled = false;
    const isCurrent = () => !cancelled;
    const blocks = Array.from(
      root.querySelectorAll<HTMLPreElement>("pre[data-piweb-mermaid]"),
    ).filter((pre) => pre.dataset.piwebMermaid === rendered.marker);
    let renderedBlockCount = 0;
    let totalSourceLength = 0;

    for (const pre of blocks) {
      const source = pre.textContent ?? "";
      let fallbackMessage: string | undefined;
      if (source.length > MERMAID_MAX_SOURCE_LENGTH) {
        fallbackMessage = "Mermaid 图内容过大，已显示源码。";
      } else if (!fallbackMessage && hasUnsupportedMermaidResource(source)) {
        fallbackMessage = "Mermaid 图包含不支持的资源或扩展语法，已显示源码。";
      } else if (
        renderedBlockCount >= mermaidMaxBlocks
        || totalSourceLength + source.length > mermaidMaxTotalSourceLength
      ) {
        fallbackMessage = "Mermaid 图数量或总内容超出限制，已显示源码。";
      }
      if (fallbackMessage) {
        showFallback(pre, fallbackMessage);
        onRenderSettled?.();
        continue;
      }
      renderedBlockCount += 1;
      totalSourceLength += source.length;
      void enqueueMermaidRender(source, isCurrent).then((result) => {
        if (!result || cancelled || !pre.isConnected) return;
        pre.replaceWith(createDiagram(result.svg));
        onRenderSettled?.();
      }).catch(() => {
        if (cancelled || !pre.isConnected) return;
        showFallback(pre, "Mermaid 图无法渲染，已显示源码。");
        onRenderSettled?.();
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    mermaidMaxBlocks,
    mermaidMaxTotalSourceLength,
    onRenderSettled,
    rendered,
  ]);

  return <div
    ref={rootRef}
    className={className}
    dangerouslySetInnerHTML={{ __html: rendered.html }}
  />;
}

export const MarkdownContent = memo(MarkdownContentView);
