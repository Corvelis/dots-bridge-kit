function clockText(now: number): string {
  const date = new Date(now);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Phone-local minute clock and coarse G2 battery; the app owns scheduling. */
export class GlassesHud {
  private clock: string;
  private battery?: number;
  constructor(now = Date.now()) { this.clock = clockText(now); }
  get batteryText(): string {
    if (this.battery === undefined) return "--%";
    if (this.battery === 0) return "0%";
    if (this.battery < 10) return "<10%";
    return `~${Math.round(this.battery / 10) * 10}%`;
  }
  get text(): string { return `${this.clock}  ${this.batteryText}`; }
  tick(now = Date.now()): boolean {
    const clock = clockText(now);
    if (clock === this.clock) return false;
    this.clock = clock; return true;
  }
  observeBattery(level: unknown): boolean {
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 100) return false;
    const before = this.batteryText;
    this.battery = level;
    return before !== this.batteryText;
  }
}
