export type DisplayTransfer = "page" | "text" | "image";

/** Passive app-side measurements: no polling, extra timer or G2 telemetry request. */
export class PowerDiagnostics {
  private startedAt: number;
  private stateAt: number;
  private awake = true;
  private microphone = false;
  private awakeMs = 0;
  private sleepMs = 0;
  private microphoneMs = 0;
  private transfers: Record<DisplayTransfer, number> = { page: 0, text: 0, image: 0 };
  private sleepTransfers: Record<DisplayTransfer, number> = { page: 0, text: 0, image: 0 };
  private battery?: { from: number; at: number; level: number; observedAt: number };
  private repairs = 0;
  constructor(private now = () => Date.now()) { this.startedAt = this.stateAt = this.now(); }
  state(awake: boolean, microphone: boolean): void {
    const now = this.now(), elapsed = Math.max(0, now - this.stateAt);
    if (this.awake) this.awakeMs += elapsed; else this.sleepMs += elapsed;
    if (this.microphone) this.microphoneMs += elapsed;
    this.awake = awake; this.microphone = microphone; this.stateAt = now;
  }
  transfer(kind: DisplayTransfer, awake: boolean): void {
    this.transfers[kind]++; if (!awake) this.sleepTransfers[kind]++;
  }
  microphoneRepaired(): void { this.repairs++; }
  observeBattery(level: number | undefined, charging?: boolean): void {
    if (charging) { this.battery = undefined; return; }
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 100) return;
    const now = this.now();
    if (!this.battery || level > this.battery.level) this.battery = { from: level, at: now, level, observedAt: now };
    else { this.battery.level = level; this.battery.observedAt = now; }
  }
  snapshot() {
    const now = this.now(), elapsed = Math.max(0, now - this.stateAt), battery = this.battery;
    const batteryMs = battery ? battery.observedAt - battery.at : 0;
    const drop = battery ? battery.from - battery.level : 0;
    return {
      elapsedMs: Math.max(0, now - this.startedAt),
      awakeMs: this.awakeMs + (this.awake ? elapsed : 0),
      sleepMs: this.sleepMs + (!this.awake ? elapsed : 0),
      microphoneMs: this.microphoneMs + (this.microphone ? elapsed : 0),
      transfers: { ...this.transfers }, sleepTransfers: { ...this.sleepTransfers }, repairs: this.repairs,
      battery: battery ? { ...battery, drop, elapsedMs: batteryMs, percentPerHour: batteryMs >= 30 * 60_000 && drop >= 2 ? drop * 3_600_000 / batteryMs : undefined } : undefined,
    };
  }
}
