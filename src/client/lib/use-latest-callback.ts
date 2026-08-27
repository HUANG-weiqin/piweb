import { useCallback, useLayoutEffect, useRef } from "react";

/** Returns a stable function that delegates to the callback from the latest render. */
export function useLatestCallback<Arguments extends unknown[], Result>(
  callback: (...args: Arguments) => Result,
): (...args: Arguments) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback(
    (...args: Arguments) => callbackRef.current(...args),
    [],
  );
}
