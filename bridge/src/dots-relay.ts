import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DotMessage {
  id: string;
  appId: string;
  requestId: string;
  text: string;
  status: "queued" | "processing" | "completed" | "failed" | "uncertain";
  createdAt: number;
  updatedAt: number;
  reply?: string;
  error?: string;
}
interface StoredMessage extends DotMessage { lease?: string }
export interface DotJob { id: string; text: string; lease: string }

function lockHistory(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const identity = JSON.stringify({ pid: process.pid, id: randomUUID() });
  if (existsSync(lock)) {
    const owner = JSON.parse(readFileSync(lock, "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid dots history lock");
    let running = true;
    try { process.kill(owner.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") running = false; }
    if (running) throw new Error("Dots history is already open in another bridge");
    throw new Error("Stale dots history lock; confirm the previous bridge exited before removing the .lock file");
  }
  writeFileSync(lock, identity, { flag: "wx", mode: 0o600 });
  return () => { if (existsSync(lock) && readFileSync(lock, "utf8") === identity) unlinkSync(lock); };
}

/** Reverse transport: an explicitly connected dot pulls input and posts its reply. */
export class DotsRelay {
  private records: StoredMessage[] = [];
  private waiting?: { finish(job: DotJob | null): void };
  private active?: string;
  private lastPoll = 0;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly releaseLock: () => void;
  private readonly listeners = new Set<(message: DotMessage) => void>();

  constructor(private readonly path: string, private readonly timeoutMs = 10 * 60_000) {
    this.releaseLock = lockHistory(path);
    try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(data) || data.length > 512 || data.some(row =>
        !row || typeof row.id !== "string" || typeof row.appId !== "string"
        || typeof row.requestId !== "string" || typeof row.text !== "string"
        || !["queued", "processing", "completed", "failed", "uncertain"].includes(row.status)
        || !Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt))) {
        throw new Error("Invalid dots relay history");
      }
      this.records = data;
      for (const row of this.records) {
        if (row.status === "queued" || row.status === "processing") {
          row.status = row.status === "processing" ? "uncertain" : "failed";
          row.error = "Bridge restarted; input was not automatically replayed";
          row.updatedAt = Date.now();
          delete row.lease;
        }
      }
      this.save(this.records);
    }
    this.timer = setInterval(() => this.expire(), 1000);
    this.timer.unref();
    } catch (error) { this.releaseLock(); throw error; }
  }

  get status() {
    return { mode: "reverse-relay", workerOnline: !this.closed &&
      (Boolean(this.active) || Boolean(this.waiting) || this.lastPoll > Date.now() - 45_000),
    queued: this.records.filter(row => row.status === "queued").length,
    processing: Boolean(this.active) };
  }

  subscribe(listener: (message: DotMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private public(row: StoredMessage): DotMessage {
    const { lease: _lease, ...message } = row;
    return { ...message };
  }

  private save(records: StoredMessage[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private update(row: StoredMessage, patch: Partial<StoredMessage>): StoredMessage {
    const updated = { ...row, ...patch, updatedAt: Date.now() };
    const records = this.records.map(record => record === row ? updated : record);
    this.save(records);
    this.records = records;
    for (const listener of this.listeners) listener(this.public(updated));
    return updated;
  }

  send(appId: string, requestId: string, text: string): DotMessage {
    if (this.closed) throw new Error("Dots relay is closed");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(appId)
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
      || typeof text !== "string" || !text.trim() || [...text].length > 12_000) {
      throw new Error("Invalid appId, requestId or text (maximum 12000 code points)");
    }
    const prior = this.records.find(row => row.appId === appId && row.requestId === requestId);
    if (prior) {
      if (prior.text !== text) throw new Error("requestId was already used with different text");
      return this.public(prior);
    }
    this.expire();
    if (!this.status.workerOnline) throw new Error("Dot worker is offline; input was not accepted");
    if (this.status.queued >= 16) throw new Error("Dots queue is full");
    // Keep IDs for at least 24 hours; never evict an unfinished operation.
    const records = this.records.filter(row => ["queued", "processing"].includes(row.status)
      || row.updatedAt > Date.now() - 24 * 60 * 60_000);
    if (records.length >= 512) throw new Error("Dots history is full; retry after older entries expire");
    const row: StoredMessage = { id: randomUUID(), appId, requestId, text,
      status: "queued", createdAt: Date.now(), updatedAt: Date.now() };
    this.save([...records, row]);
    this.records = [...records, row];
    this.deliver();
    return this.read(appId, requestId);
  }

  /** Accepted inputs retained by this Mac; does not replay any operation. */
  inputHistory(): DotMessage[] { return this.records.map(row => this.public(row)); }

  read(appId: string, requestId: string): DotMessage {
    const row = this.records.find(record => record.appId === appId && record.requestId === requestId);
    if (!row) throw new Error("Unknown message for this app");
    return this.public(row);
  }

  deliveryStatus(id: string): { status: DotMessage["status"]; error?: string } {
    const row = this.records.find(record => record.id === id);
    if (!row) throw new Error("Unknown delivery");
    return { status: row.status, error: row.error };
  }

  async next(signal: AbortSignal, waitMs = 25_000): Promise<DotJob | null> {
    if (this.closed || signal.aborted) throw new Error("Dots relay is unavailable");
    this.expire();
    if (this.waiting || this.active) throw new Error("A dot worker is already waiting or processing");
    this.lastPoll = Date.now();
    return new Promise(resolve => {
      const abort = () => finish(null);
      const finish = (job: DotJob | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (this.waiting?.finish === finish) this.waiting = undefined;
        if (!job && signal.aborted && !this.active) this.lastPoll = 0;
        resolve(job);
      };
      const timer = setTimeout(() => finish(null), Math.min(25_000, Math.max(1, waitMs)));
      this.waiting = { finish };
      signal.addEventListener("abort", abort, { once: true });
      this.deliver();
    });
  }

  private deliver(): void {
    if (!this.waiting || this.active || this.closed) return;
    const row = this.records.find(record => record.status === "queued");
    if (!row) return;
    const lease = randomUUID();
    const waiting = this.waiting;
    // Persist before exposing input. Lost delivery must not cause a duplicate action.
    this.update(row, { status: "processing", lease });
    this.active = row.id;
    waiting.finish({ id: row.id, text: row.text, lease });
  }

  reply(id: string, lease: string, text: string): void {
    this.expire();
    if (this.closed || typeof text !== "string" || !text.trim() || [...text].length > 24_000) {
      throw new Error("Invalid reply (maximum 24000 code points)");
    }
    const row = this.records.find(record => record.id === id && record.lease === lease);
    if (!row) throw new Error("Unknown or expired delivery lease");
    if (row.status === "completed" && row.reply === text) return;
    if (row.status !== "processing") throw new Error("Message no longer accepts a reply");
    this.update(row, { status: "completed", reply: text });
    this.active = undefined;
    this.lastPoll = Date.now();
  }

  abandon(id: string, lease: string, sent: boolean, reason: string): void {
    const row = this.records.find(record => record.id === id && record.lease === lease);
    if (!row || row.status !== "processing") throw new Error("Unknown or inactive delivery lease");
    this.update(row, { status: sent ? "uncertain" : "failed", lease: undefined,
      error: reason.slice(0, 1000) || "Browser worker disconnected; input was not replayed" });
    this.active = undefined;
    this.lastPoll = 0;
  }

  private expire(): void {
    for (const row of this.records) {
      const since = row.status === "processing" ? row.updatedAt : row.createdAt;
      if (!["queued", "processing"].includes(row.status) || since > Date.now() - this.timeoutMs) continue;
      this.update(row, { status: row.status === "processing" ? "uncertain" : "failed",
        error: "Timed out; input was not automatically replayed", lease: undefined });
      if (this.active === row.id) { this.active = undefined; this.lastPoll = 0; }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.waiting?.finish(null);
    this.listeners.clear();
    this.releaseLock();
    // Unfinished records are conservatively resolved when the next process starts.
  }
}
