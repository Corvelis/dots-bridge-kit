import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DotNotification } from "./dots-inbox";
import type { DotsNotificationPage } from "./dots-echo-client";

/** Keeps the server cursor at the last notification actually displayed. */
export class DotsEchoNotifications {
  private cursor = 0;
  private controller?: AbortController;
  private running = false;
  private wake?: () => void;

  constructor(private readonly options: {
    path: string;
    notifications(after: number): Promise<DotsNotificationPage>;
    canDeliver(): boolean;
    deliver(notification: DotNotification, signal: AbortSignal): Promise<boolean>;
    onError?(error: unknown): void;
    retryMs?: number;
  }) {
    if (existsSync(options.path)) {
      const saved = JSON.parse(readFileSync(options.path, "utf8"));
      if (!Number.isSafeInteger(saved.cursor) || saved.cursor < 0) throw new Error("Invalid Dots notification cursor");
      this.cursor = saved.cursor;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(controller.signal);
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.poke();
  }

  poke(): void { this.wake?.(); }

  private save(cursor: number): void {
    mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const temp = `${this.options.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, cursor }), { mode: 0o600 });
    renameSync(temp, this.options.path);
    this.cursor = cursor;
  }

  private pause(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, this.options.retryMs ?? 1_000);
      timer.unref();
      this.wake = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        if (!this.options.canDeliver()) { await this.pause(signal); continue; }
        const page = await this.options.notifications(this.cursor);
        if (page.gap) this.options.onError?.(new Error("Older dot notifications have expired; delivering the remaining notifications"));
        if (!page.items.length && page.nextCursor > this.cursor) { this.save(page.nextCursor); continue; }
        let delivered = false;
        for (const item of page.items) {
          if (signal.aborted) break;
          // Own inputs are synchronized by the conversation inbox. They must
          // never become Dot notifications, speech or a new response turn.
          if (item.role === "user") { this.save(item.sequence); delivered = true; continue; }
          if (!this.options.canDeliver()) break;
          if (!await this.options.deliver(item, signal)) break;
          // Display acknowledgement comes first. Cancellation/disconnect keeps it pending.
          this.save(item.sequence);
          delivered = true;
        }
        if (delivered) continue; // Immediately drain backlog without adding response latency.
      } catch (error) {
        if (!signal.aborted) this.options.onError?.(error);
      }
      await this.pause(signal);
    }
  }
}
