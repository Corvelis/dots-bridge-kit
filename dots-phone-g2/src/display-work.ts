export const DISPLAY_INTERVAL_MS = 100;
export const MAINTENANCE_INTERVAL_MS = 500;
export const SLEEP_MAINTENANCE_INTERVAL_MS = 5_000;

/** Visual work can sleep independently of audio, gestures and connection deadlines. */
export class DisplayWork {
  private awake = true;
  private phoneVisible = true;
  private overlay = false;
  private busy = false;
  private animationEnabled = true;
  private started = false;
  private disposed = false;
  private maintenanceTimer?: number;
  private scheduledMaintenanceMs = 0;
  private displayTimer?: number;
  private checkedAt = -Infinity;
  constructor(private callbacks: {
    maintenance(now: number): void;
    foreground(): void;
    background(): void;
  }, private now = () => Date.now()) {}

  get animating(): boolean { return this.started && !this.disposed && this.animationEnabled && this.awake && this.phoneVisible && !this.overlay; }
  get maintenanceIntervalMs(): number { return this.awake || this.busy ? MAINTENANCE_INTERVAL_MS : SLEEP_MAINTENANCE_INTERVAL_MS; }
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.updateMaintenanceTimer();
    this.updateTimer();
  }
  update(awake: boolean, phoneVisible: boolean, overlay: boolean, busy = false, animationEnabled = true): void {
    this.awake = awake; this.phoneVisible = phoneVisible; this.overlay = overlay; this.busy = busy;
    this.animationEnabled = animationEnabled;
    this.updateMaintenanceTimer();
    this.updateTimer();
  }
  /** Native audio/input events can check overdue deadlines after OS timer suspension. */
  check(force = false): void {
    if (!this.started || this.disposed) return;
    const now = this.now();
    if (!force && now >= this.checkedAt && now - this.checkedAt < this.maintenanceIntervalMs) return;
    this.checkedAt = now;
    this.callbacks.maintenance(now);
    if (this.animationEnabled && this.awake && !this.phoneVisible && !this.overlay) this.callbacks.background();
  }
  private updateMaintenanceTimer(): void {
    if (!this.started || this.disposed || this.scheduledMaintenanceMs === this.maintenanceIntervalMs) return;
    if (this.maintenanceTimer !== undefined) window.clearInterval(this.maintenanceTimer);
    this.scheduledMaintenanceMs = this.maintenanceIntervalMs;
    // Stable intervals, never a recursively rearmed timeout in Even Hub's timer map.
    this.maintenanceTimer = window.setInterval(() => this.check(), this.scheduledMaintenanceMs);
  }
  private updateTimer(): void {
    if (this.animating && this.displayTimer === undefined) {
      // Even Hub virtualizes timers using a live Map. Keep a stable interval;
      // recursively rearming timeouts can run forever during a native tick.
      this.displayTimer = window.setInterval(() => { if (this.animating) this.callbacks.foreground(); }, DISPLAY_INTERVAL_MS);
    } else if (!this.animating && this.displayTimer !== undefined) {
      window.clearInterval(this.displayTimer); this.displayTimer = undefined;
    }
  }
  dispose(): void {
    this.disposed = true;
    if (this.displayTimer !== undefined) window.clearInterval(this.displayTimer);
    if (this.maintenanceTimer !== undefined) window.clearInterval(this.maintenanceTimer);
    this.displayTimer = this.maintenanceTimer = undefined;
  }
}
