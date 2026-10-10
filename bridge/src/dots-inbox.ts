import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface DotNotification {
  id: string;
  sequence: number;
  sourceId: string;
  text: string;
  receivedAt: number;
  role?: "user" | "assistant";
  inputId?: string;
}
interface InboxData {
  version: 1;
  sequence: number;
  items: DotNotification[];
  seen: string[];
}
export const validDotSource = (id: unknown): id is string => typeof id === "string" && id.length > 0
  && id.length <= 512 && !/[\x00-\x1f]/.test(id);

/** Single writer, protected by the enclosing gateway's history lock. */
export class DotsInbox {
  private data: InboxData = { version: 1, sequence: 0, items: [], seen: [] };
  private listeners = new Set<(notification: DotNotification) => void>();
  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.version !== 1 || !Number.isSafeInteger(data.sequence) || data.sequence < 0
      || !Array.isArray(data.items) || data.items.length > 1024
      || !Array.isArray(data.seen) || data.seen.length > 4096 || data.seen.some((id: unknown) => !validDotSource(id))
      || data.items.some((n: DotNotification, i: number) => !n || typeof n.id !== "string"
        || !validDotSource(n.sourceId) || typeof n.text !== "string" || !n.text.trim() || [...n.text].length > 24000
        || (n.role !== undefined && n.role !== "user" && n.role !== "assistant")
        || (n.inputId !== undefined && (!validDotSource(n.inputId) || n.role !== "user"))
        || !Number.isSafeInteger(n.sequence) || n.sequence < 1 || n.sequence > data.sequence
        || (i > 0 && n.sequence !== data.items[i - 1].sequence + 1) || !Number.isFinite(n.receivedAt))
      || (data.items.length && data.items.at(-1).sequence !== data.sequence)) throw new Error("Invalid dots notification history");
    this.data = data;
  }
  private save(data: InboxData) {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    renameSync(temp, this.path);
    this.data = data;
  }
  seen(sourceId: string): void {
    if (!validDotSource(sourceId)) throw new Error("Invalid notification sourceId");
    if (!this.data.seen.includes(sourceId)) this.save({ ...this.data, seen: [...this.data.seen, sourceId].slice(-4096) });
  }
  publish(sourceId: string, text: string, metadata: { role?: "user" | "assistant"; inputId?: string; receivedAt?: number } = {}): DotNotification | null {
    if (!validDotSource(sourceId) || typeof text !== "string" || !text.trim() || [...text].length > 24000
      || metadata.role !== undefined && metadata.role !== "user" && metadata.role !== "assistant"
      || metadata.inputId !== undefined && (!validDotSource(metadata.inputId) || metadata.role !== "user")
      || metadata.receivedAt !== undefined && !Number.isFinite(metadata.receivedAt)) {
      throw new Error("Invalid dot notification");
    }
    if (this.data.seen.includes(sourceId)) return this.data.items.find(n => n.sourceId === sourceId) ?? null;
    const item: DotNotification = { id: randomUUID(), sequence: this.data.sequence + 1, sourceId, text, receivedAt: metadata.receivedAt ?? Date.now(),
      ...(metadata.role === "user" ? { role: "user" as const } : {}), ...(metadata.inputId ? { inputId: metadata.inputId } : {}) };
    this.save({ version: 1, sequence: item.sequence, items: [...this.data.items, item].slice(-1024),
      seen: [...this.data.seen, sourceId].slice(-4096) });
    for (const listener of this.listeners) listener({ ...item });
    return { ...item };
  }
  sync(after = 0, limit = 100, includeInputs = true) {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.data.sequence
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid notification cursor or limit");
    const items = this.data.items.filter(n => n.sequence > after && (includeInputs || n.role !== "user")).slice(0, limit).map(n => ({ ...n }));
    const nextCursor = items.length < limit ? this.data.sequence : items.at(-1)?.sequence ?? after;
    const oldest = this.data.items[0]?.sequence ?? this.data.sequence + 1;
    return { items, nextCursor, hasMore: nextCursor < this.data.sequence, gap: after < oldest - 1 };
  }
  subscribe(listener: (notification: DotNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
