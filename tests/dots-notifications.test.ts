import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DotsGateway } from "../bridge/src/dots-gateway";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  messages: any[] = [];
  send(data: string) { this.messages.push(JSON.parse(data)); }
  close() { this.emit("close"); }
  receive(data: unknown) { this.emit("message", Buffer.from(JSON.stringify(data)), false); }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dots-inbox-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "history.json");
  const make = () => {
    const gateway = new DotsGateway({ historyPath: path, workerToken: "worker", tokenMatches: t => t === "phone-token" });
    cleanups.push(() => gateway.close());
    return gateway;
  };
  const connect = (gateway: DotsGateway) => {
    const socket = new Socket();
    gateway.accept(socket as unknown as WebSocket);
    socket.receive({ type: "dots.hello", version: 1, appId: "phone", token: "phone-token" });
    return socket;
  };
  return { make, connect, path };
}
const sync = (socket: Socket, after = 0, limit = 100) => {
  socket.receive({ id: 1, method: "notification/sync", params: { after, limit } });
  return socket.messages.at(-1).result;
};

describe("dot notification persistence and subscriptions", () => {
  it("delivers idle notifications only to authenticated subscribed clients and deduplicates source IDs", () => {
    const { make, connect, path } = setup(), g = make();
    const old = connect(g), phone = connect(g), anonymous = new Socket();
    g.accept(anonymous as unknown as WebSocket);
    expect(sync(phone)).toMatchObject({ items: [], nextCursor: 0, hasMore: false, gap: false });
    const event = g.inbox.publish("source-1", "そろそろ出かける時間だよ🌸");
    g.inbox.publish("source-1", "そろそろ出かける時間だよ🌸");
    expect(phone.messages.filter(m => m.type === "dots.notification")).toEqual([{ type: "dots.notification", notification: event }]);
    expect(old.messages).toHaveLength(1);
    expect(anonymous.messages).toHaveLength(0);
    expect(statSync(`${path}.notifications.json`).mode & 0o777).toBe(0o600);
    g.inbox.seen("reply-already-routed");
    expect(g.inbox.publish("reply-already-routed", "普通の返答")).toBeNull();
    expect(g.inbox.sync().items).toHaveLength(1);
  });
  it("recovers messages received while the phone was disconnected, including across bridge restart", () => {
    const { make, connect } = setup();
    let g = make();
    const phone = connect(g); sync(phone); phone.close();
    g.inbox.publish("offline-1", "切断中の一件目");
    g.inbox.publish("offline-2", "切断中の二件目");
    g.close(); g = make();
    const resumed = connect(g);
    expect(sync(resumed, 0, 1)).toMatchObject({ items: [{ text: "切断中の一件目" }], nextCursor: 1, hasMore: true });
    g.inbox.publish("during-pagination", "同期中の新着");
    expect(resumed.messages.some(m => m.type === "dots.notification")).toBe(false);
    expect(sync(resumed, 1)).toMatchObject({ items: [{ text: "切断中の二件目" }, { text: "同期中の新着" }], nextCursor: 3, hasMore: false });
    const live = g.inbox.publish("after-sync", "同期後の新着");
    expect(resumed.messages.at(-1)).toEqual({ type: "dots.notification", notification: live });
    expect(sync(resumed, 4).items).toEqual([]);
    expect(g.inbox.publish("offline-1", "切断中の一件目")?.sequence).toBe(1);
  });
  it("reports retention gaps, rejects invalid cursors, and prevents phone-side publication", () => {
    const { make, connect } = setup(), g = make(), phone = connect(g);
    for (let i = 1; i <= 1025; i++) g.inbox.publish(`id-${i}`, `通知${i}`);
    expect(g.inbox.sync(0, 1)).toMatchObject({ items: [{ sequence: 2 }], gap: true, hasMore: true });
    expect(() => g.inbox.sync(1026)).toThrow("cursor");
    expect(() => g.inbox.sync(-1)).toThrow("cursor");
    expect(() => g.inbox.publish("bad", "🌸".repeat(24001))).toThrow("Invalid");
    phone.receive({ id: 2, method: "notification/publish", params: { text: "forged" } });
    expect(phone.messages.at(-1).error).toBeDefined();
    phone.receive({ id: 3, method: "notification/sync", params: { after: "0" } });
    expect(phone.messages.at(-1).error).toBeDefined();
  }, 15000);
});

describe("continuous dot DOM tracking", () => {
  const row = (id: string, text: string, self = false) => ({ id, text, self });
  function tracker() {
    const context = vm.createContext({});
    vm.runInContext(readFileSync("browser/dots-bridge/watch.js", "utf8"), context);
    return new context.DotsMessageWatch();
  }
  it("baselines old history, captures new idle text after hydration, and captures self messages once", () => {
    const watch = tracker(), old = row("old", "過去の返答");
    watch.initialize([old]);
    expect(watch.scan([old])).toEqual([]);
    const empty = row("new", "");
    expect(watch.scan([old, empty])).toEqual([]);
    expect(watch.scan([old, row("new", "話しかけ")])).toEqual([{ sourceId: "new", text: "話しかけ" }]);
    expect(watch.scan([old, row("new", "話しかけ"), row("self", "ユーザー入力", true)])).toEqual([{ sourceId: "self", text: "ユーザー入力", role: "user" }]);
    expect(watch.scan([old, row("new", "話しかけ")])).toEqual([]);
  });
  it("does not duplicate a routed reply, but captures additional replies and avoids scrollback", () => {
    const watch = tracker(), old = row("old", "old"), self = row("self", "こんにちは", true);
    watch.initialize([old]); watch.scan([old, self]);
    const first = row("first", "通常の返答"), second = row("second", "もうひとこと");
    expect(watch.scan([old, self, first, second], ["first"])).toEqual([{ sourceId: "second", text: "もうひとこと" }]);
    expect(watch.scan([row("ancient", "さらに古い履歴"), old, self, first, second])).toEqual([]);
    expect(watch.scan([row("virtualized-old", "上へスクロール")])).toEqual([]);
    expect(watch.scan([second, row("latest", "新着")])).toEqual([{ sourceId: "latest", text: "新着" }]);
  });
});
