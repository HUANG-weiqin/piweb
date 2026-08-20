import type { PiRuntimeLike } from "./pi-runtime.js";

export const MODEL_REFRESH_TIMEOUT_MS = 15_000;

function timeoutError(): Error {
  return new Error("Automatic model refresh timed out");
}

export async function refreshModelCatalogOnStartup(
  runtime: PiRuntimeLike,
  lifecycleSignal: AbortSignal,
  onError: (error: unknown) => void,
): Promise<void> {
  if (process.env.PI_OFFLINE !== undefined || lifecycleSignal.aborted) return;

  const controller = new AbortController();
  let timedOut = false;
  const onLifecycleAbort = () => controller.abort();
  lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MODEL_REFRESH_TIMEOUT_MS);
  timer.unref?.();

  try {
    await runtime.refreshConfiguration({
      allowNetwork: true,
      force: true,
      signal: controller.signal,
    });
    if (timedOut) throw timeoutError();
  } catch (error) {
    if (lifecycleSignal.aborted) return;
    try {
      onError(timedOut ? timeoutError() : error);
    } catch {
      // Startup diagnostics must not make the refresh task fail.
    }
  } finally {
    clearTimeout(timer);
    lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
  }
}
