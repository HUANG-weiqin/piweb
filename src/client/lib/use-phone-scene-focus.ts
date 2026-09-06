import { useLayoutEffect, useRef, type RefObject } from "react";

const PHONE_SCENE_HEADER = [
  ".mobile-page-header",
  ".mobile-chat-header",
  ".workspace-placeholder-content[role='status']",
].join(", ");

function visibleSceneHeader(root: HTMLElement): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>(PHONE_SCENE_HEADER)].find(
    (header) => header.closest("[hidden], [aria-hidden='true']") === null,
  );
}

/**
 * Moves focus to a newly revealed phone scene without changing the initial
 * document focus. Scene headers become programmatically focusable only when
 * they are the destination of an in-app phone navigation.
 */
export function usePhoneSceneFocus(
  active: boolean,
  sceneKey: string,
  rootRef: RefObject<HTMLElement | null>,
): void {
  const previousSceneKeyRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    if (!active) {
      previousSceneKeyRef.current = undefined;
      return;
    }
    const previousSceneKey = previousSceneKeyRef.current;
    previousSceneKeyRef.current = sceneKey;
    if (previousSceneKey === undefined || previousSceneKey === sceneKey) return;

    const header = rootRef.current && visibleSceneHeader(rootRef.current);
    if (!header) return;
    header.tabIndex = -1;
    header.focus();
  }, [active, rootRef, sceneKey]);
}
