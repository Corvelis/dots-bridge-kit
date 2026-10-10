import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DotsConversation, CONVERSATION_BYTES } from "../bridge/src/dots-conversation";
import { DotsGateway } from "../bridge/src/dots-gateway";
import { DotsModel, type ConversationSnapshot } from "../dots-phone-g2/src/model";
import { synchronizeInbox } from "../dots-phone-g2/src/inbox";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "dots-conversation-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return join(dir, "history.json"); }
const row = (sourceId: string, role: "user" | "assistant" = "assistant", text = sourceId) => ({ sourceId, role, text });
const ids = (items: { sourceId?: string }[]) => items.map(row => row.sourceId);
const window = (...sourceIds: string[]) => sourceIds.map(id => row(id, id.startsWith("u") ? "user" : "assistant"));
const snapshot = (items = window("d1", "u1", "d2", "d3", "u2", "d4"), revision = 1): ConversationSnapshot => ({ epoch: "epoch", revision, ready: true, gap: false,
  items: items.map((row, i) => ({ ...row, id: `dom:${row.sourceId}`, sequence: 0, receivedAt: 100 - i })) });
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; messages: any[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); } close() { this.emit("close"); }
  receive(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
}
function setup() {
  const gateway = new DotsGateway({ historyPath: temp(), workerToken: "worker", tokenMatches: token => token === "phone" }); cleanups.push(() => gateway.close());
  const connect = () => { const socket = new Socket(); gateway.accept(socket as unknown as WebSocket); socket.receive({ type: "dots.hello", version: 1, appId: "history-test", token: "phone" }); return socket; };
  return { gateway, connect };
}
async function http(gateway: DotsGateway) {
  const server = createServer((req, res) => gateway.handleHttp(req, res));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return async (data: unknown, token = "worker", origin?: string) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/dots/worker/history`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() as any };
  };
}
describe("authoritative Dot DOM order", () => {
  it("persists replies omitted from notifications, in DOM order rather than timestamp or alternating authors", () => {
    const path = temp(), conversation = new DotsConversation(path);
    conversation.capture(window("d1", "u1", "d2", "d3", "u2", "d4"), true);
    expect(ids(conversation.sync().items)).toEqual(["d1", "u1", "d2", "d3", "u2", "d4"]);
    expect(ids(new DotsConversation(path).sync().items)).toEqual(ids(conversation.sync().items));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("merges new tail, virtualized windows and older loaded history using shared message IDs", () => {
    const c = new DotsConversation(temp()); c.capture(window("u1", "d1", "d2", "u2"), true);
    c.capture(window("d2", "u2", "d3"), true); c.capture(window("d0", "u1", "d1"), false);
    expect(ids(c.sync().items)).toEqual(["d0", "u1", "d1", "d2", "u2", "d3"]);
    c.capture(window("u2", "d3"), false); expect(c.sync().items).toHaveLength(6);
  });
  it("does not guess placement of disjoint scrollback and rebases a disjoint latest window", () => {
    const c = new DotsConversation(temp()); c.capture(window("u1", "d1"), true);
    expect(c.capture(window("ancient1", "ancient2"), false).applied).toBe(false); expect(ids(c.sync().items)).toEqual(["u1", "d1"]);
    c.capture(window("u3", "d3"), true); expect(ids(c.sync().items)).toEqual(["u3", "d3"]); expect(c.sync().gap).toBe(true);
  });
  it("rejects duplicate IDs, conflicting anchors and malformed rows without altering retained history", () => {
    const c = new DotsConversation(temp()); c.capture(window("u1", "d1", "d2"), true); const before = c.sync();
    for (const rows of [window("d1", "d1"), window("d2", "d1"), [row("", "user")], [{ ...row("new"), inputId: "bad" }], [row("too-big", "user", "🌸".repeat(24001))], [], [{ ...row("new"), injected: true }]]) expect(() => c.capture(rows, true)).toThrow();
    expect(c.sync()).toEqual(before);
  });
  it("keeps identical text with distinct IDs and updates a hydrated body in place", () => {
    const c = new DotsConversation(temp()); const rows = [row("u1", "user", "はい"), row("d1", "assistant", "はい"), row("u2", "user", "はい")];
    c.capture(rows, true); const first = c.sync(); expect(first.items).toHaveLength(3);
    expect(c.capture(rows, true).revision).toBe(first.revision);
    c.capture([{ ...rows[1]!, text: "はい、了解です" }, rows[2]!], true); const next = c.sync(); expect(ids(next.items)).toEqual(["u1", "d1", "u2"]);
    expect(next.items[1]!.text).toBe("はい、了解です"); expect(next.items[1]!.receivedAt).toBe(first.items[1]!.receivedAt);
  });
  it("bounds multibyte snapshots by whole messages and retains the newest 100", () => {
    const c = new DotsConversation(temp()); for (let i = 0; i < 11; i++) c.capture(window(`d${i}`, `d${i+1}`), true);
    const rows = Array.from({ length: 100 }, (_, i) => row(`long${i}`, "assistant", "あ".repeat(700)));
    c.capture(rows, true); const result = c.sync(); expect(result.items).toHaveLength(100); expect(Buffer.byteLength(JSON.stringify(result.items))).toBeLessThanOrEqual(CONVERSATION_BYTES);
    expect(() => c.capture(rows.map(row => ({ ...row, text: "あ".repeat(2000) })), true)).toThrow();
  });
});
describe("ordered history transport and app migration", () => {
  it("requires the local worker credential and delivers ordered history only to subscribed authenticated clients", async () => {
    const { gateway, connect } = setup(), subscribed = connect(), legacy = connect(), call = await http(gateway);
    subscribed.receive({ id: "h", method: "history/sync", params: {} }); expect(subscribed.messages.at(-1).result.ready).toBe(false);
    expect((await call({ items: window("u1", "d1"), latest: true }, "wrong")).status).toBe(403);
    expect((await call({ items: window("u1", "d1"), latest: true }, "worker", "https://example.invalid")).status).toBe(403);
    expect((await call({ items: window("u1", "d1"), latest: "yes" })).status).toBe(409);
    expect((await call({ items: window("u1", "d1"), latest: true })).status).toBe(200);
    expect(subscribed.messages.at(-1).type).toBe("dots.history"); expect(ids(subscribed.messages.at(-1).history.items)).toEqual(["u1", "d1"]);
    expect(legacy.messages).toHaveLength(1); expect(gateway.inbox.sync().items).toEqual([]);
    subscribed.close(); const count = subscribed.messages.length; gateway.conversation.capture(window("d1", "u2", "d2"), true); expect(subscribed.messages).toHaveLength(count);
  });
  it("replaces wrongly sorted old cache including ephemeral ASR replies, silently even during recording", async () => {
    const model = new DotsModel({ cursor: 7, initialized: true, seen: ["old-notification"], history: [
      { id: "old-dot", text: "古いDotの到着時刻", sequence: 1, receivedAt: 1000 },
      { id: "old-input", role: "user", text: "元の入力時刻", sequence: 2, receivedAt: 1 },
      { id: "text:session:1", text: "ASRの別経路の返答", sequence: 0, receivedAt: 2000 }] });
    model.inputMode = "text"; model.transcript = "まだ録音中"; model.setActivity("recording"); model.sleepDisplay();
    const calls: string[] = [];
    await synchronizeInbox({ request: async method => { calls.push(method); return method === "history/sync" ? snapshot() : { items: [], nextCursor: 7, hasMore: false, gap: false }; } }, model, () => {}, true);
    expect(calls).toEqual(["history/sync", "notification/sync"]); expect(ids(model.history)).toEqual(["d1", "u1", "d2", "d3", "u2", "d4"]);
    expect(model.awake).toBe(false); expect(model.activity).toBe("recording"); expect(model.transcript).toBe("まだ録音中");
    expect(new DotsModel(model.save()).history.map(row => row.id)).toEqual(model.history.map(row => row.id));
  });
  it("does not insert notification arrival order or duplicate ASR/delayed TTS replies into canonical history", () => {
    const m = new DotsModel(); m.applyConversation(snapshot()); const idsBefore = ids(m.history);
    m.incoming({ id: "arrived-late", sourceId: "d2", sequence: 1, text: "遅れて届いた返答", receivedAt: 5000 });
    m.incoming({ id: "relay-input", sourceId: "u1", role: "user", inputId: "asr-turn", sequence: 2, text: "送信入力", receivedAt: 1 });
    m.textReply("text:session:1", "別経路の返答", 10000); m.historyReply("tts-history", "昔の音声通知", 0);
    expect(ids(m.history)).toEqual(idsBefore); expect(m.cursor).toBe(2);
  });
  it("preserves the selected message/page during incremental sync and ignores stale snapshots", () => {
    const m = new DotsModel(); const first = snapshot([row("d1", "assistant", "長い本文。".repeat(120)), row("u1", "user"), row("d2")]); m.applyConversation(first); m.select("dom:d1", false); const offset = m.offset;
    m.applyConversation({ ...first, revision: 2, items: [...first.items, ...snapshot(window("u2", "d3")).items] });
    expect(m.selectedId).toBe("dom:d1"); expect(m.offset).toBe(offset); expect(m.applyConversation(first)).toBe(false);
  });
  it.each(["notification-first", "history-first"])("wakes to the new Dot first page with %s delivery", order => {
    const m = new DotsModel(); m.applyConversation(snapshot(window("d1", "u1", "d2"))); m.select("dom:d1"); m.sleepDisplay();
    const next = snapshot([row("d1"), row("u1", "user"), row("d2"), row("new", "assistant", "新着の最初。\n" + "長い新着。".repeat(150))], 2);
    const notify = () => m.incoming({ id: "notification-new", sourceId: "new", sequence: 1, text: "新着", receivedAt: 999 });
    if (order === "notification-first") { notify(); m.applyConversation(next); } else { m.applyConversation(next); notify(); }
    expect(m.awake).toBe(true); expect(m.selectedId).toBe("dom:new"); expect(m.viewport.page).toBe(1);
    m.sleepDisplay(); notify(); expect(m.awake).toBe(false);
  });
  it("holds an empty new bridge baseline without republishing wrong legacy rows", () => {
    const m = new DotsModel(); m.textReply("old", "old", 1); m.applyConversation({ epoch: "fresh", revision: 0, ready: false, gap: false, items: [] });
    m.textReply("text:session:2", "new", 2); expect(m.history).toEqual([]); expect(m.viewport.text).toContain("履歴を同期中");
    m.applyConversation(snapshot()); expect(m.history).toHaveLength(6);
  });
  it("limits visible history without changing the authoritative chronology", () => {
    const m = new DotsModel(); const rows = Array.from({ length: 100 }, (_, i) => row(`m${i}`, i % 2 ? "assistant" : "user")); m.applyConversation(snapshot(rows)); m.setHistoryLimit(10);
    expect(ids(m.visibleHistory)).toEqual(rows.slice(-10).map(row => row.sourceId)); expect(m.history).toHaveLength(100);
  });
});
describe("extension history capture", () => {
  function tracker() { const context = vm.createContext({ TextEncoder }); vm.runInContext(readFileSync("browser/dots-bridge/watch.js", "utf8"), context); return new context.DotsHistoryWatch(); }
  it("captures baseline and normal replies claimed by the relay without creating notifications", () => {
    const t = tracker(), rows = [{ id: "u1", self: true, inputId: "turn-1", text: "入力" }, { id: "d1", self: false, text: "通常返答" }, { id: "d2", self: false, text: "追加返答" }];
    expect(t.capture(rows, true).items).toEqual([{ sourceId: "u1", role: "user", inputId: "turn-1", text: "入力" }, { sourceId: "d1", role: "assistant", text: "通常返答" }, { sourceId: "d2", role: "assistant", text: "追加返答" }]);
    expect(t.capture(rows, true)).toBeNull(); expect(t.capture(rows, true, true).revision).toBe(2);
  });
  it("bounds baseline payload, ignores hydration empties, and records text edits without changing order", () => {
    const t = tracker(); const rows = Array.from({ length: 110 }, (_, i) => ({ id: `id${i}`, text: "あ".repeat(5000), self: !!(i % 2) }));
    const message = t.capture(rows, true); expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(240 * 1024); expect(message.items.at(-1).sourceId).toBe("id109");
    expect(message.items.every((row: any) => row.text.length === 5000)).toBe(true); expect(t.capture([{ id: "empty", text: "", self: false }], true)).toBeNull();
    const edited = t.capture([{ id: "id109", self: true, text: "修正" }], true); expect(edited.items).toEqual([{ sourceId: "id109", role: "user", text: "修正" }]);
  });
});
