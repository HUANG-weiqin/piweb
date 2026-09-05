import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const modalStack: symbol[] = [];
const modalContainers = new Map<symbol, HTMLElement>();

function isFocusable(element: HTMLElement): boolean {
  return element.matches(FOCUSABLE)
    && !element.hidden
    && element.getAttribute("aria-hidden") !== "true";
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter(isFocusable);
}

function focusSafest(container: HTMLElement): void {
  const preferred = container.querySelector<HTMLElement>(
    "[data-modal-autofocus]:not([disabled])",
  );
  (preferred ?? focusableElements(container)[0] ?? container).focus();
}

/**
 * Keeps keyboard focus inside an active modal and restores the launcher when
 * the modal closes. `identity` re-focuses the safest available action when the
 * modal changes from one request to the next.
 */
export function useModalFocus<T extends HTMLElement>(
  active: boolean,
  identity: string,
  onEscape?: () => void,
): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  const tokenRef = useRef(Symbol("modal-focus-scope"));
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const token = tokenRef.current;
    const container = containerRef.current;
    modalStack.push(token);
    if (container) modalContainers.set(token, container);
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return () => {
      const index = modalStack.lastIndexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      modalContainers.delete(token);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected && isFocusable(previous)) {
        previous.focus();
        if (document.activeElement === previous) return;
      }
      const parentToken = modalStack.at(-1);
      const parent = parentToken && modalContainers.get(parentToken);
      if (parent?.isConnected) focusSafest(parent);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    focusSafest(container);
  }, [active, identity]);

  useEffect(() => {
    if (!active) return;
    const keepFocusInside = (event: FocusEvent) => {
      if (modalStack.at(-1) !== tokenRef.current) return;
      const container = containerRef.current;
      if (!container || container.contains(event.target as Node)) return;
      (focusableElements(container)[0] ?? container).focus();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== tokenRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      if (event.key === "Escape") {
        const escape = escapeRef.current;
        if (!escape) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        escape();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements(container);
      if (elements.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const current = document.activeElement;
      const index = elements.indexOf(current as HTMLElement);
      const nextIndex = event.shiftKey
        ? (index <= 0 ? elements.length - 1 : index - 1)
        : (index < 0 || index === elements.length - 1 ? 0 : index + 1);
      event.preventDefault();
      elements[nextIndex]?.focus();
    };
    document.addEventListener("focusin", keepFocusInside, true);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("focusin", keepFocusInside, true);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [active]);

  return containerRef;
}
