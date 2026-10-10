interface QueuedOperation<T = unknown> {
  operation: () => Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

/** Executes display operations one at a time while keeping the queue usable after failures. */
export class SerialOperationQueue {
  private readonly priority: QueuedOperation[] = [];
  private readonly regular: QueuedOperation[] = [];
  private active = false;

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation, false);
  }

  /** Runs immediately after the in-flight operation, ahead of queued image work. */
  runPriority<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation, true);
  }

  private enqueue<T>(operation: () => Promise<T>, priority: boolean): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      const queued: QueuedOperation<T> = { operation, resolve, reject };
      (priority ? this.priority : this.regular).push(queued as QueuedOperation);
    });
    this.scheduleDrain();
    return result;
  }

  private scheduleDrain(): void {
    if (this.active) return;
    this.active = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.priority.length || this.regular.length) {
        const queued = this.priority.shift() ?? this.regular.shift();
        if (!queued) continue;
        try {
          queued.resolve(await queued.operation());
        } catch (error) {
          queued.reject(error);
        }
      }
    } finally {
      this.active = false;
      if (this.priority.length || this.regular.length) this.scheduleDrain();
    }
  }
}
