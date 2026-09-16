import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import DOMPurify, { type ElementHook } from "dompurify";
import { marked, type Tokens } from "marked";
import { useModalFocus } from "../lib/use-modal-focus";

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

function isWebUrl(value: string): boolean {
  if (!/^(?:https?:|\/\/)/i.test(value.trim())) return false;
  try {
    const protocol = new URL(value, "http://piweb.invalid").protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const decorateWebLink: ElementHook = (currentNode) => {
  if (
    currentNode.localName !== "a"
    || currentNode.namespaceURI !== "http://www.w3.org/1999/xhtml"
  ) return;
  const href = currentNode.getAttribute("href");
  if (href === null || !isWebUrl(href)) return;
  currentNode.setAttribute("target", "_blank");
  currentNode.setAttribute("rel", "noopener noreferrer");
};

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
  DOMPurify.addHook("afterSanitizeAttributes", decorateWebLink);
  try {
    return DOMPurify.sanitize(marked.parse(markdown, {
      async: false,
      renderer,
    }) as string);
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes", decorateWebLink);
  }
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
  const expandButton = document.createElement("button");
  expandButton.type = "button";
  expandButton.className = "ghost mermaid-diagram-expand";
  expandButton.dataset.piwebMermaidExpand = "";
  expandButton.setAttribute("aria-haspopup", "dialog");
  expandButton.setAttribute("aria-label", "全屏查看 Mermaid 图");
  expandButton.title = "全屏查看";
  expandButton.textContent = "全屏查看";

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-diagram-toolbar";
  toolbar.append(expandButton);

  const viewport = document.createElement("div");
  viewport.className = "mermaid-diagram-viewport";
  viewport.append(svgElement);

  const diagram = document.createElement("div");
  diagram.className = "mermaid-diagram";
  diagram.append(toolbar, viewport);
  return diagram;
}

type MermaidViewerMode = "fit" | "actual";

function restoreSvgStyle(svg: SVGSVGElement, style: string | null): void {
  if (style === null) svg.removeAttribute("style");
  else svg.setAttribute("style", style);
}

function MermaidViewer({
  sourceSvg,
  onClose,
}: {
  sourceSvg: SVGSVGElement;
  onClose(): void;
}) {
  const [mode, setMode] = useState<MermaidViewerMode>("fit");
  const canvasRef = useRef<HTMLDivElement>(null);
  const originalStyleRef = useRef(sourceSvg.getAttribute("style"));
  const focusRef = useModalFocus<HTMLElement>(
    true,
    sourceSvg.id || "mermaid-viewer",
    onClose,
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = sourceSvg.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "mermaid-diagram-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.style.width = bounds.width > 0
      ? `${bounds.width}px`
      : sourceSvg.style.width || "100%";
    placeholder.style.height = `${bounds.height}px`;
    sourceSvg.replaceWith(placeholder);
    canvas.append(sourceSvg);

    return () => {
      restoreSvgStyle(sourceSvg, originalStyleRef.current);
      if (placeholder.isConnected) placeholder.replaceWith(sourceSvg);
    };
  }, [sourceSvg]);

  useLayoutEffect(() => {
    restoreSvgStyle(sourceSvg, originalStyleRef.current);
    if (mode !== "fit") return;
    sourceSvg.style.setProperty("width", "100%", "important");
    sourceSvg.style.setProperty("height", "100%", "important");
    sourceSvg.style.setProperty("max-width", "100%", "important");
    sourceSvg.style.setProperty("max-height", "100%", "important");
  }, [mode, sourceSvg]);

  const showingActualSize = mode === "actual";
  return createPortal(<div
    className="mermaid-viewer-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onClose();
    }}
  >
    <section
      ref={focusRef}
      className="mermaid-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid 图全屏查看"
      tabIndex={-1}
    >
      <header className="mermaid-viewer-header">
        <div>
          <p className="eyebrow">DIAGRAM</p>
          <h2>Mermaid 图</h2>
        </div>
        <div className="mermaid-viewer-actions">
          <button
            type="button"
            className="ghost mermaid-viewer-size"
            aria-label={showingActualSize
              ? "适应窗口查看 Mermaid 图"
              : "按原始大小查看 Mermaid 图"}
            onClick={() => setMode(showingActualSize ? "fit" : "actual")}
          >
            {showingActualSize ? "适应窗口" : "原始大小"}
          </button>
          <button
            type="button"
            className="ghost mermaid-viewer-close"
            aria-label="关闭 Mermaid 图全屏查看"
            data-modal-autofocus
            onClick={onClose}
          >×</button>
        </div>
      </header>
      <div
        ref={canvasRef}
        className={`mermaid-viewer-canvas is-${mode}`}
        aria-label="Mermaid 图查看区域"
        tabIndex={0}
      />
    </section>
  </div>, document.body);
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
  const [expandedSvg, setExpandedSvg] = useState<SVGSVGElement | null>(null);
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
  // The rendered diagrams live inside this opaque subtree. Keep the prop stable
  // so opening the viewer does not make React restore the original code fences.
  const dangerousHtml = useMemo(
    () => ({ __html: rendered.html }),
    [rendered.html],
  );

  useEffect(() => {
    setExpandedSvg(null);
  }, [rendered.marker]);

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

  const openMermaidViewer = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLButtonElement>(
      "button[data-piweb-mermaid-expand]",
    );
    if (!trigger || !event.currentTarget.contains(trigger)) return;
    const svg = trigger
      .closest(".mermaid-diagram")
      ?.querySelector<SVGSVGElement>("svg");
    if (svg) setExpandedSvg(svg);
  };

  return <>
    <div
      ref={rootRef}
      className={className}
      onClick={openMermaidViewer}
      dangerouslySetInnerHTML={dangerousHtml}
    />
    {expandedSvg && <MermaidViewer
      sourceSvg={expandedSvg}
      onClose={() => setExpandedSvg(null)}
    />}
  </>;
}

export const MarkdownContent = memo(MarkdownContentView);
