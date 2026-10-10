/** One clock per connection/reset. Durations come from PCM frames, never the server hop. */
export class ContinuousPcmClock {
  nextTime = 0;
  started = false;
  underruns = 0;

  reset(): void { this.nextTime = 0; this.started = false; this.underruns = 0; }

  schedule(now: number, frames: number, rate: number, leadMs: 80 | 250) {
    const first = !this.started;
    const gapMs = this.started ? Math.max(0, (now - this.nextTime) * 1000) : 0;
    // Rebase only after genuine exhaustion. All samples are retained.
    if (first || gapMs > 0) this.nextTime = now + leadMs / 1000;
    if (gapMs > 0) this.underruns++;
    const startsAt = this.nextTime;
    this.nextTime += frames / rate;
    this.started = true;
    return { startsAt, first, gapMs, bufferBeforeMs: Math.max(0, (startsAt - now) * 1000),
      bufferAfterMs: Math.max(0, (this.nextTime - now) * 1000), underruns: this.underruns };
  }
}
