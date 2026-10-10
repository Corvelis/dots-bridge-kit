export const AUTO_OFF_SECONDS = [0, 15, 30, 60, 120, 300] as const;
export function autoOffSeconds(value: unknown): number {
  return typeof value === "number" && AUTO_OFF_SECONDS.includes(value as typeof AUTO_OFF_SECONDS[number]) ? value : 30;
}

/** Checked by the existing maintenance timer; creates no additional timer. */
export class AutoOff {
  private lastActivity: number;
  constructor(public seconds = 30, private now = () => Date.now()) { this.lastActivity = now(); }
  configure(seconds: number): void { this.seconds = autoOffSeconds(seconds); this.touch(); }
  touch(): void { this.lastActivity = this.now(); }
  due(awake: boolean, busy: boolean, now = this.now()): boolean {
    // A hold, response, review or OS overlay must not expire while in use.
    if (!awake || busy) { this.lastActivity = now; return false; }
    return this.seconds > 0 && now - this.lastActivity >= this.seconds * 1000;
  }
}
