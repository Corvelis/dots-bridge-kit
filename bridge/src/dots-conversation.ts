import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validDotSource } from "./dots-inbox";

export interface ConversationRow { sourceId: string; text: string; role: "user" | "assistant"; inputId?: string }
export interface ConversationMessage extends ConversationRow { id: string; sequence: 0; receivedAt: number }
interface ConversationData { version: 1; epoch: string; revision: number; ready: boolean; gap: boolean; items: ConversationMessage[] }
export const CONVERSATION_BYTES = 240 * 1024;
const bytes = (items: unknown[]) => Buffer.byteLength(JSON.stringify(items));
function bounded<T>(rows: T[], count: number, budget: number): T[] {
  let start = Math.max(0, rows.length - count), size = 2;
  for (let i = rows.length - 1; i >= start; i--) {
    size += Buffer.byteLength(JSON.stringify(rows[i])) + 1;
    if (size > budget) { start = i + 1; break; }
  }
  return rows.slice(start);
}
export function validConversationRow(value: unknown): value is ConversationRow {
  const row = value as ConversationRow;
  return !!row && validDotSource(row.sourceId) && typeof row.text === "string" && !!row.text.trim()
    && [...row.text].length <= 24000 && (row.role === "user" || row.role === "assistant")
    && (row.inputId === undefined || row.role === "user" && validDotSource(row.inputId))
    && Object.keys(row).every(key => ["sourceId", "text", "role", "inputId"].includes(key));
}
/** DOM order is authoritative. Arrival timestamps are display metadata only. */
export class DotsConversation {
  private data: ConversationData = { version: 1, epoch: randomUUID(), revision: 0, ready: false, gap: false, items: [] };
  private listeners = new Set<(snapshot: ReturnType<DotsConversation["sync"]>) => void>();
  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8")) as ConversationData;
    if (data.version !== 1 || !validDotSource(data.epoch) || !Number.isSafeInteger(data.revision) || data.revision < 0
      || typeof data.ready !== "boolean" || typeof data.gap !== "boolean" || !Array.isArray(data.items) || data.items.length > 1024
      || bytes(data.items) > 2 * 1024 * 1024 || new Set(data.items.map(row => row.sourceId)).size !== data.items.length
      || data.items.some(row => !row || !validConversationRow({ sourceId: row.sourceId, text: row.text, role: row.role,
        ...(row.inputId ? { inputId: row.inputId } : {}) }) || row.id !== `dom:${row.sourceId}` || row.sequence !== 0 || !Number.isFinite(row.receivedAt))) {
      throw new Error("Invalid ordered Dot history");
    }
    this.data = data;
  }
  sync() {
    return { epoch: this.data.epoch, revision: this.data.revision, ready: this.data.ready, gap: this.data.gap,
      items: bounded(this.data.items, 100, CONVERSATION_BYTES).map(row => ({ ...row })) };
  }
  capture(rows: unknown, latest: boolean) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 100 || rows.some(row => !validConversationRow(row))
      || new Set(rows.map(row => row.sourceId)).size !== rows.length || bytes(rows) > CONVERSATION_BYTES) throw new Error("Invalid conversation window");
    const incoming = rows as ConversationRow[], old = this.data.items;
    const positions = new Map(old.map((row, i) => [row.sourceId, i]));
    const anchors = incoming.flatMap(row => positions.has(row.sourceId) ? [positions.get(row.sourceId)!] : []);
    if (anchors.some((position, i) => i > 0 && position <= anchors[i - 1]!)) throw new Error("Conflicting conversation order");
    // A disjoint, scrolled older window cannot be placed reliably. Never guess
    // using arrival time or identical text. A disjoint latest window can rebase.
    if (old.length && !anchors.length && !latest) return { applied: false, revision: this.data.revision };
    const known = new Map(old.map(row => [row.sourceId, row]));
    const items = incoming.map(row => ({ ...row, inputId: row.inputId ?? known.get(row.sourceId)?.inputId,
      id: `dom:${row.sourceId}`, sequence: 0 as const, receivedAt: known.get(row.sourceId)?.receivedAt ?? Date.now() }));
    const ids = new Set(items.map(row => row.sourceId));
    const combined = anchors.length ? [...old.slice(0, anchors[0]).filter(row => !ids.has(row.sourceId)), ...items,
      ...old.slice(anchors.at(-1)! + 1).filter(row => !ids.has(row.sourceId))] : items;
    const retained = bounded(combined, 1024, 2 * 1024 * 1024);
    const gap = this.data.gap || old.length > 0 && !anchors.length || retained.length < combined.length;
    if (this.data.ready && gap === this.data.gap && JSON.stringify(retained) === JSON.stringify(old)) return { applied: true, revision: this.data.revision };
    const data: ConversationData = { ...this.data, revision: this.data.revision + 1, ready: true, gap, items: retained };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 }); renameSync(temporary, this.path); this.data = data;
    for (const listener of this.listeners) listener(this.sync());
    return { applied: true, revision: data.revision };
  }
  subscribe(listener: (snapshot: ReturnType<DotsConversation["sync"]>) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
}
