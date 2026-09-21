import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortableExtensionUI } from "./extension-ui.js";
import { ConversationExtensionUIRouter } from "./conversation-extension-ui-router.js";

function extensionUI(
  overrides: Partial<PortableExtensionUI> = {},
): PortableExtensionUI {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    notify: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationExtensionUIRouter", () => {
  it("queues until a delegate attaches and passes the remaining timeout", async () => {
    vi.useFakeTimers();
    const unavailable = vi.fn();
    const router = new ConversationExtensionUIRouter(unavailable);
    const controller = new AbortController();
    const result = router.ui.select("Choose", ["first", "second"], {
      signal: controller.signal,
      timeout: 100,
    });

    expect(unavailable).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);

    const select = vi.fn(async () => "second");
    router.attach(extensionUI({ select }));

    await expect(result).resolves.toBe("second");
    expect(select).toHaveBeenCalledWith(
      "Choose",
      ["first", "second"],
      { signal: controller.signal, timeout: 75 },
    );
  });

  it("settles in-flight dialogs with their defaults on abort and timeout", async () => {
    vi.useFakeTimers();
    const router = new ConversationExtensionUIRouter(vi.fn());
    const controller = new AbortController();
    const resolveConfirmations: Array<(value: boolean) => void> = [];
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveConfirmations.push(resolve);
    }));
    router.attach(extensionUI({ confirm }));

    const aborted = router.ui.confirm("Confirm", "Abort", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).resolves.toBe(false);

    const timedOut = router.ui.confirm("Confirm", "Timeout", { timeout: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(timedOut).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);

    for (const resolve of resolveConfirmations) resolve(true);
    await Promise.resolve();
  });

  it("clears both in-flight and queued dialogs with their defaults", async () => {
    const unavailable = vi.fn();
    const router = new ConversationExtensionUIRouter(unavailable);
    let resolveConfirmation!: (value: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    }));
    const detach = router.attach(extensionUI({ confirm }));
    const inFlight = router.ui.confirm("Confirm", "Continue?");
    detach();
    const queued = router.ui.input("Input");

    expect(confirm).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledOnce();

    router.clear();

    await expect(inFlight).resolves.toBe(false);
    await expect(queued).resolves.toBeUndefined();
    resolveConfirmation(true);
    await Promise.resolve();
  });

  it("uses the latest delegate and ignores repeated detaches", async () => {
    const unavailable = vi.fn();
    const router = new ConversationExtensionUIRouter(unavailable);
    const firstConfirm = vi.fn(async () => true);
    const secondConfirm = vi.fn(async () => false);
    const detachFirst = router.attach(extensionUI({ confirm: firstConfirm }));
    const detachSecond = router.attach(extensionUI({ confirm: secondConfirm }));

    await expect(router.ui.confirm("Confirm", "Latest delegate")).resolves.toBe(false);
    expect(firstConfirm).not.toHaveBeenCalled();
    expect(secondConfirm).toHaveBeenCalledOnce();

    detachSecond();
    detachSecond();
    await expect(router.ui.confirm("Confirm", "First delegate")).resolves.toBe(true);
    expect(firstConfirm).toHaveBeenCalledOnce();

    detachFirst();
    detachFirst();
    const queued = router.ui.confirm("Confirm", "No delegate");
    expect(unavailable).toHaveBeenCalledOnce();

    const thirdConfirm = vi.fn(async () => true);
    router.attach(extensionUI({ confirm: thirdConfirm }));
    await expect(queued).resolves.toBe(true);
    expect(thirdConfirm).toHaveBeenCalledOnce();
  });

  it("rejects delegate failures and reports unavailable notifications", async () => {
    const unavailable = vi.fn();
    const router = new ConversationExtensionUIRouter(unavailable);
    router.ui.notify("Waiting for a delegate");
    expect(unavailable).toHaveBeenCalledOnce();

    const synchronousError = new Error("synchronous delegate failure");
    const rejection = new Error("asynchronous delegate failure");
    const notify = vi.fn();
    router.attach(extensionUI({
      input: () => {
        throw synchronousError;
      },
      editor: () => Promise.reject(rejection),
      notify,
    }));

    await expect(router.ui.input("Input")).rejects.toBe(synchronousError);
    await expect(router.ui.editor("Editor")).rejects.toBe(rejection);
    router.ui.notify("Forwarded notification", "warning");
    expect(notify).toHaveBeenCalledWith("Forwarded notification", "warning");
  });
});
