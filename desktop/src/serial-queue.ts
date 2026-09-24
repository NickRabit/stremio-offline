export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // The tail swallows the failure so one rejected task cannot stall the queue.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
