export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  run<T>(task: () => Promise<T> | T): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error("Serial task queue is closed"));
    }
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    this.accepting = false;
    await this.tail;
  }
}
