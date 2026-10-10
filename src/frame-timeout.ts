export interface FrameDeadlineScheduler {
  now(): number;
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

const browserFrameScheduler: FrameDeadlineScheduler = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * Rejects stalled Even Hub operations using animation frames. The Even Hub SDK
 * virtualizes window timers, so a setTimeout watchdog can stall with the
 * operation it is supposed to protect.
 */
export function withFrameTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
  scheduler: FrameDeadlineScheduler = browserFrameScheduler,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = scheduler.now() + timeoutMs;
    let settled = false;
    let frameId = 0;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (frameId) scheduler.cancel(frameId);
      callback();
    };
    const check = (): void => {
      if (settled) return;
      if (scheduler.now() >= deadline) {
        finish(() => reject(new Error(`${label} timed out`)));
        return;
      }
      frameId = scheduler.request(check);
    };

    frameId = scheduler.request(check);
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
