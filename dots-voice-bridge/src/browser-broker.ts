import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { parseSnapshot, type CallAction, type CallController, type CallSnapshot } from "./protocol";

export class BrowserBroker implements CallController {
  private worker?: WebSocket;
  private pending = new Map<string, { resolve(value: CallSnapshot): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private lastSeen = 0;
  private lastSnapshotAt = 0;
  private snapshotStale = false;
  private watchdog: NodeJS.Timeout;
  snapshot?: CallSnapshot;
  onChange?: (snapshot?: CallSnapshot, reason?: string) => void;
  onDiagnostic?: (event: string, detail: Record<string, string | number>) => void;
  constructor(readonly dotUrl: string, private timeoutMs = 20_000) {
    this.watchdog = setInterval(() => {
      if (!this.worker) return;
      if (Date.now() - this.lastSeen > 12_000) {
        this.onDiagnostic?.("browser-transport-timeout", {}); this.worker.terminate(); return;
      }
      // A throttled page monitor does not mean the native control socket died.
      // Node answers Ping independently of Chrome's content-script timers.
      if (this.worker.readyState === WebSocket.OPEN) this.worker.ping();
      if (!this.snapshotStale && Date.now() - this.lastSnapshotAt > 12_000) {
        this.snapshotStale = true;
        this.onDiagnostic?.("browser-monitor-stale", {}); this.onChange?.(undefined, "browser-monitor-stale");
      }
    }, 3000);
    this.watchdog.unref();
  }
  get online() { return this.worker?.readyState === WebSocket.OPEN && Date.now() - this.lastSeen < 12_000; }
  attach(worker: WebSocket): boolean {
    if (this.worker) return false;
    this.worker = worker; this.lastSeen = this.lastSnapshotAt = Date.now(); this.snapshotStale = false;
    this.onDiagnostic?.("browser-worker-connected", {});
    worker.on("pong", () => { if (this.worker === worker) this.lastSeen = Date.now(); });
    worker.on("message", (data, binary) => {
      try {
        if (binary || Buffer.byteLength(data.toString()) > 8000) throw new Error("Invalid worker frame");
        const message = JSON.parse(data.toString());
        if (message.type === "voice.state") {
          this.snapshot = parseSnapshot(message.snapshot, this.dotUrl);
          this.lastSeen = this.lastSnapshotAt = Date.now(); this.snapshotStale = false; this.onChange?.(this.snapshot, `browser-state-${this.snapshot.state}`);
        } else if (message.type === "voice.result") {
          const item = this.pending.get(message.id);
          if (!item) return; // Never replay a timed-out command.
          this.pending.delete(message.id); clearTimeout(item.timer);
          this.lastSeen = Date.now();
          if (typeof message.error === "string") item.reject(new Error(message.error.slice(0, 1000)));
          else {
            try { this.snapshot = parseSnapshot(message.snapshot, this.dotUrl); this.lastSnapshotAt = Date.now(); this.snapshotStale = false; item.resolve(this.snapshot); this.onChange?.(this.snapshot, `browser-state-${this.snapshot.state}`); }
            catch (error) { item.reject(error as Error); throw error; }
          }
        } else throw new Error("Unsupported worker message");
      } catch { this.onDiagnostic?.("browser-invalid-frame", {}); worker.close(4400, "Invalid dot worker response"); }
    });
    worker.on("error", () => worker.terminate());
    worker.once("close", code => {
      if (this.worker !== worker) return;
      this.worker = undefined; this.snapshot = undefined;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Dot browser disconnected")); }
      this.pending.clear(); this.onDiagnostic?.("browser-worker-closed", { closeCode: code }); this.onChange?.(undefined, "browser-disconnected");
    });
    return true;
  }
  command(action: CallAction, sessionId?: string): Promise<CallSnapshot> {
    if (!this.online || !this.worker) return Promise.reject(new Error("Dot browser is offline. Reload Dots Bridge Kit and the existing dot page."));
    if (this.pending.size >= 4) return Promise.reject(new Error("Too many pending call commands"));
    const id = randomUUID(), worker = this.worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.onDiagnostic?.("browser-command-timeout", { stage: action }); reject(new Error(`Dot ${action} confirmation timed out; command was not replayed`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.send(JSON.stringify({ type: "voice.command", id, action, sessionId, url: this.dotUrl }), error => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  close() {
    clearInterval(this.watchdog); this.worker?.terminate();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Voice bridge shutting down")); }
    this.pending.clear();
  }
}
