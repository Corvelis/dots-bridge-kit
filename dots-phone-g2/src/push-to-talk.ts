export const PTT_MAX_HOLD_MS = 60_000;
export interface PttTiming {
  source: string; requestedAt: number; queueMs: number; ensureCallMs: number;
  inputGateMs: number; nativeMicMs: number; totalMs: number;
  result: "ready" | "cancelled" | "error";
}
export interface TalkRoute {
  ensureCall(): Promise<void>;
  owned(): boolean;
  setInput(enabled: boolean): Promise<unknown>;
  microphone(enabled: boolean): Promise<void>;
  changed(open: boolean): void;
  error(error: unknown): void;
  preparing?(pending: boolean): void;
  timing?(timing: PttTiming): void;
}
/** Serializes microphone transitions; a released hold cannot open a late microphone. */
export class PhonePushToTalk {
  private sources = new Set<string>();
  private work: Promise<void> = Promise.resolve();
  private open = false;
  private gate = false;
  private nativeAttempted = false;
  private deadline = 0;
  private preparing = false;
  private attempt?: PttTiming;
  private scheduled = 0;
  constructor(private route: TalkRoute, private now = () => performance.now()) {}
  get recording(): boolean { return this.open && this.sources.size > 0 && this.route.owned(); }
  hold(source: string): void {
    if (this.sources.has(source)) return;
    if (!this.sources.size) this.deadline = Date.now() + PTT_MAX_HOLD_MS;
    this.sources.add(source);
    if (!this.open && !this.preparing) {
      this.attempt = { source, requestedAt: this.now(), queueMs: 0, ensureCallMs: 0, inputGateMs: 0, nativeMicMs: 0, totalMs: 0, result: "cancelled" };
      this.setPreparing(true); // Stop display transfers synchronously at the gesture.
    }
    this.schedule();
  }
  release(source: string): Promise<void> { this.sources.delete(source); if (!this.sources.size && this.open) this.setPreparing(true); return this.schedule(); }
  clear(): Promise<void> { this.sources.clear(); if (this.open) this.setPreparing(true); return this.schedule(); }
  tick(now: number): void { if (this.sources.size && now >= this.deadline) void this.clear(); }
  private schedule(): Promise<void> {
    this.scheduled++;
    this.work = this.work.then(() => this.reconcile()).catch(async error => {
      this.sources.clear();
      await this.close().catch(() => {});
      this.route.error(error);
    }).finally(() => { if (--this.scheduled === 0) this.setPreparing(false); });
    return this.work;
  }
  private async reconcile(): Promise<void> {
    if (!this.sources.size) {
      await this.close();
      if (this.attempt) { this.attempt.totalMs = this.now() - this.attempt.requestedAt; this.route.timing?.({ ...this.attempt }); this.attempt = undefined; }
      return;
    }
    if (this.open) return;
    const attempt = this.attempt;
    if (attempt) attempt.queueMs = this.now() - attempt.requestedAt;
    const measure = async (stage: "ensureCallMs" | "inputGateMs" | "nativeMicMs", operation: () => Promise<unknown>) => {
      const at = this.now(); try { await operation(); } finally { if (attempt) attempt[stage] = this.now() - at; }
    };
    try {
      await measure("ensureCallMs", () => this.route.ensureCall());
      if (!this.sources.size || !this.route.owned()) return;
      await measure("inputGateMs", () => this.route.setInput(true)); this.gate = true;
      if (!this.sources.size || !this.route.owned()) { await this.close(); return; }
      this.nativeAttempted = true;
      await measure("nativeMicMs", () => this.route.microphone(true)); this.open = true;
      if (!this.sources.size || !this.route.owned()) { await this.close(); return; }
      if (attempt) attempt.result = "ready";
      this.route.changed(true);
    } catch (error) { if (attempt) attempt.result = "error"; throw error; }
    finally {
      if (attempt) { attempt.totalMs = this.now() - attempt.requestedAt; this.route.timing?.({ ...attempt }); }
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }
  private setPreparing(value: boolean): void { if (this.preparing !== value) { this.preparing = value; this.route.preparing?.(value); } }
  private async close(): Promise<void> {
    if (!this.nativeAttempted && !this.open && !this.gate) return;
    // Always close the native source, including after a lost socket or failed open.
    try { if (this.nativeAttempted) { await this.route.microphone(false); this.nativeAttempted = false; } }
    finally {
      this.open = false; this.route.changed(false);
      if (this.gate && this.route.owned()) {
        try { await this.route.setInput(false); } finally { this.gate = false; }
      } else this.gate = false;
    }
  }
}
