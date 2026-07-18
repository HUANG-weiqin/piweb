import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "./serial-task-queue.js";

describe("SerialTaskQueue", () => {
  it("runs tasks in arrival order", async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = queue.run(() => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after a failed task", async () => {
    const queue = new SerialTaskQueue();
    const failed = queue.run(() => {
      throw new Error("expected");
    });
    const next = queue.run(() => "ok");

    await expect(failed).rejects.toThrow("expected");
    await expect(next).resolves.toBe("ok");
  });
});
