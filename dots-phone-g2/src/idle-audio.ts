/** Late buffered PCM is harmless; a sustained unowned stream keeps the G2 mic alive. */
export class IdleAudioGuard {
  private firstAt?: number;
  private lastAt?: number;
  private retryAt = 0;
  private attempts = 0;
  private pending = false;
  constructor(private callbacks: {
    idle(): boolean;
    close(): Promise<boolean>;
    corrected(): void;
    error(error: unknown): void;
  }) {}
  feed(now = Date.now()): void {
    if (!this.callbacks.idle()) {
      this.firstAt = this.lastAt = undefined; this.attempts = 0; return;
    }
    if (this.lastAt === undefined || now - this.lastAt > 500) this.firstAt = now;
    this.lastAt = now;
    if (this.pending || this.attempts >= 2 || now < this.retryAt || now - this.firstAt! < 1500) return;
    this.pending = true; this.attempts++; this.retryAt = now + 5_000;
    void this.callbacks.close().then(closed => {
      if (closed) this.callbacks.corrected();
      else this.attempts = Math.max(0, this.attempts - 1); // A new PTT won ownership before the repair RPC.
    }).catch(this.callbacks.error).finally(() => { this.pending = false; this.firstAt = undefined; this.lastAt = undefined; });
  }
}
