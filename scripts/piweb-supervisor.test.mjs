import { describe, expect, it, vi } from "vitest";
import { rejectBlockedReload } from "./piweb-supervisor.mjs";

const REQUEST_ID = "reload-request";
const OTHER_REQUEST_ID = "another-request";

function createOperation(child, phase = "preparing", requestId = REQUEST_ID) {
  let rejectChildAcceptance;
  const childAcceptance = new Promise((_resolve, reject) => {
    rejectChildAcceptance = reject;
  });
  void childAcceptance.catch(() => undefined);
  return {
    child,
    phase,
    requestId,
    childAcceptance,
    rejectChildAcceptance,
  };
}

describe("supervisor blocked reload IPC", () => {
  it("rejects only the matching preparation without killing the old child", async () => {
    const child = { kill: vi.fn() };
    const operation = createOperation(child);
    const acceptance = operation.childAcceptance.catch((error) => error);
    const message = {
      type: "piweb_reload_blocked",
      requestId: REQUEST_ID,
      message: "Bash cleanup is unconfirmed",
    };

    const error = rejectBlockedReload(operation, child, message);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(message.message);
    await expect(acceptance).resolves.toBe(error);
    expect(child.kill).not.toHaveBeenCalled();
    expect(operation.phase).toBe("preparing");
  });

  it.each([
    ["a stale child", "other-child", "preparing", REQUEST_ID],
    ["a stale request", "current-child", "preparing", OTHER_REQUEST_ID],
    ["a non-preparing operation", "current-child", "stopping", REQUEST_ID],
  ])("ignores a blocked response from %s", async (_case, eventChild, phase, requestId) => {
    const currentChild = { id: "current-child" };
    const operation = createOperation(currentChild, phase);
    let settled = false;
    void operation.childAcceptance.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    expect(rejectBlockedReload(operation, { id: eventChild }, {
      type: "piweb_reload_blocked",
      requestId,
      message: "stale cleanup warning",
    })).toBeUndefined();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(operation.phase).toBe(phase);
  });
});
