import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { DotsGateway } from "../bridge/src/dots-gateway";
import { DotsEchoNotifications } from "../bridge/src/dots-echo-notifications";
import { DotsModel } from "../dots-phone-g2/src/model";
import { synchronizeInbox } from "../dots-phone-g2/src/inbox";
import { dotsTexts } from "../dots-phone-g2/src/glasses";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; messages: any[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
  close() { this.emit("close"); }
  receive(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "dots-input-history-")), path = join(directory, "history.json");
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = new DotsGateway({ historyPath: path, workerToken: "worker", tokenMatches: value => value === "phone-token" });
  cleanups.push(() => gateway.close());
  const socket = new Socket(); gateway.accept(socket as unknown as WebSocket);
  socket.receive({ type: "dots.hello", version: 1, appId: "g2-history", token: "phone-token" });
  socket.receive({ id: "sync", method: "notification/sync", params: { after: 0, includeInputs: true } });
  return { gateway, socket, directory, path };
}
async function worker(gateway: DotsGateway) {
  const server = createServer((request, response) => gateway.handleHttp(request, response));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  return async (params: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/dots/worker/notification`, { method: "POST", headers: { authorization: "Bearer worker", "content-type": "application/json" }, body: JSON.stringify(params) });
    return { status: response.status, body: await response.json() as any };
  };
}
describe("accepted input history and browser correlation", () => {
  it("records an accepted ASR input once across retries, DOM observation and bridge restart", async () => {
    const { gateway, socket, path } = setup(); const pending = gateway.relay.next(new AbortController().signal);
    socket.receive({ id: "send", method: "message/send", params: { requestId: "asr-turn-1", text: "認識して送信した文章" } });
    const job = (await pending)!;
    const input = gateway.inbox.sync().items[0]!;
    expect(input).toMatchObject({ role: "user", inputId: job.id, text: job.text });
    const call = await worker(gateway);
    expect((await call({ sourceId: "dom-own-1", role: "user", inputId: job.id, text: job.text })).status).toBe(200);
    // A reconnect can show the same DOM row without its in-flight job metadata.
    expect((await call({ sourceId: "dom-own-1", role: "user", text: job.text })).status).toBe(200);
    socket.receive({ id: "retry", method: "message/send", params: { requestId: "asr-turn-1", text: job.text } });
    expect(gateway.inbox.sync().items).toEqual([input]);
    expect(socket.messages.filter(message => message.type === "dots.notification")).toHaveLength(1);
    gateway.relay.reply(job.id, job.lease, "Dotの返答"); gateway.close();
    const restarted = new DotsGateway({ historyPath: path, workerToken: "worker", tokenMatches: () => true });
    cleanups.push(() => restarted.close()); expect(restarted.inbox.sync().items).toEqual([input]);
  });
  it("keeps separate submissions of identical text and captures direct Chrome input", async () => {
    const { gateway, socket } = setup(); const call = await worker(gateway);
    const firstJob = gateway.relay.next(new AbortController().signal);
    socket.receive({ id: 1, method: "message/send", params: { requestId: "first", text: "はい" } });
    const first = (await firstJob)!; gateway.relay.reply(first.id, first.lease, "わかったよ");
    const secondJob = gateway.relay.next(new AbortController().signal);
    socket.receive({ id: 2, method: "message/send", params: { requestId: "second", text: "はい" } }); await secondJob;
    await call({ sourceId: "manual-input", role: "user", text: "はい" });
    expect(gateway.inbox.sync().items.map(item => item.text)).toEqual(["はい", "はい", "はい"]);
    expect(new Set(gateway.inbox.sync().items.map(item => item.id)).size).toBe(3);
  });
  it("imports retained Mac inputs without sending them back to Dot", () => {
    const { gateway, path } = setup(); gateway.close();
    writeFileSync(path, JSON.stringify([{ id: "retained", appId: "old-phone", requestId: "old-turn", text: "Macに残っている以前の入力", status: "completed", reply: "以前の返答", createdAt: 10, updatedAt: 20 }]));
    const migrated = new DotsGateway({ historyPath: path, workerToken: "worker", tokenMatches: () => true });
    cleanups.push(() => migrated.close());
    expect(migrated.inbox.sync().items).toMatchObject([{ role: "user", inputId: "retained", text: "Macに残っている以前の入力", receivedAt: 10 }]);
    expect(migrated.relay.status.queued).toBe(0);
  });
  it("validates the author and input correlation before persisting worker messages", async () => {
    const { gateway } = setup(); const call = await worker(gateway);
    expect((await call({ sourceId: "bad", text: "不正", role: "system" })).status).toBe(409);
    expect((await call({ sourceId: "bad", text: "不正", inputId: "an-input" })).status).toBe(409);
    expect(gateway.inbox.sync().items).toEqual([]);
  });
  it("keeps legacy notification subscribers on Dot replies while advancing past own inputs", () => {
    const { gateway } = setup(), legacy = new Socket(); gateway.accept(legacy as unknown as WebSocket);
    legacy.receive({ type: "dots.hello", version: 1, appId: "legacy", token: "phone-token" });
    legacy.receive({ id: 1, method: "notification/sync", params: { after: 0 } });
    gateway.inbox.publish("own", "自分の入力", { role: "user" });
    expect(legacy.messages.some(message => message.type === "dots.notification")).toBe(false);
    gateway.inbox.publish("dot", "Dotからの返答");
    expect(legacy.messages.filter(message => message.type === "dots.notification")).toHaveLength(1);
    legacy.receive({ id: 2, method: "notification/sync", params: { after: 0 } });
    expect(legacy.messages.at(-1).result).toMatchObject({ nextCursor: 2, items: [{ text: "Dotからの返答" }] });
  });
  it("does not let a page of own inputs block later Dot notifications for older clients", () => {
    const { gateway } = setup(), legacy = new Socket(); gateway.accept(legacy as unknown as WebSocket);
    legacy.receive({ type: "dots.hello", version: 1, appId: "legacy", token: "phone-token" });
    for (let i = 1; i <= 120; i++) gateway.inbox.publish(`own-${i}`, `入力${i}`, { role: "user" });
    gateway.inbox.publish("later-dot", "Dotの後続メッセージ");
    legacy.receive({ id: 1, method: "notification/sync", params: { after: 0, limit: 100 } });
    expect(legacy.messages.at(-1).result).toMatchObject({ items: [{ text: "Dotの後続メッセージ" }], nextCursor: 121, hasMore: false });
  });
  it("preserves the job ID while waiting for an empty self row to hydrate", () => {
    const context = vm.createContext({}); vm.runInContext(readFileSync("browser/dots-bridge/watch.js", "utf8"), context);
    const watch = new context.DotsMessageWatch(), old = { id: "old", text: "Dotの以前の返答", self: false };
    watch.initialize([old]); expect(watch.scan([old, { id: "own", self: true, text: "", inputId: "job-1" }])).toEqual([]);
    expect(watch.scan([old, { id: "own", self: true, text: "音声で入力", inputId: "job-1" }])).toEqual([{ sourceId: "own", text: "音声で入力", role: "user", inputId: "job-1" }]);
    expect(watch.scan([old, { id: "own", self: true, text: "音声で入力", inputId: "job-1" }])).toEqual([]);
  });
});

describe("G2 conversation history", () => {
  const own = (id: string, sequence: number, receivedAt: number, text = "自分の入力") => ({ id, sequence, receivedAt, text, role: "user" as const, inputId: id });
  it("lets both authors be read in order, including multi-page own input", () => {
    const model = new DotsModel(); model.textReply("dot-1", "前の返答", 10);
    model.incoming(own("own", 1, 20, "入力の確認です。".repeat(50))); model.textReply("dot-2", "次の返答", 30);
    expect(model.selectedId).toBe("dot-2"); model.scroll(1); expect(model.selectedId).toBe("own");
    expect(model.heading).toContain("あなた"); expect(model.viewport.pages).toBeGreaterThan(1);
    expect(dotsTexts(model).map(value => value.content).join("\n")).toContain("あなた");
    model.select("dot-1"); expect(model.selectedRole).toBe("assistant");
  });
  it("silently merges older own input without changing ASR, call or display state", () => {
    const model = new DotsModel(); model.textReply("current", "最新の返答", 100); model.sleepDisplay();
    model.transcript = "これから送る認識結果"; model.pendingTranscript = true; model.callActive = true; model.setActivity("recording");
    const notificationId = model.notificationId; model.incoming(own("past", 1, 10));
    expect(model.history.map(item => item.id)).toEqual(["past", "current"]); expect(model.selectedId).toBe("current");
    expect(model.awake).toBe(false); expect(model.activity).toBe("recording"); expect(model.callActive).toBe(true);
    expect(model.transcript).toBe("これから送る認識結果"); expect(model.pendingTranscript).toBe(true);
    expect(model.notificationId).toBe(notificationId); expect(model.unread).toBe(0);
  });
  it("does not add ASR previews or discarded drafts to sent history, and keeps one accepted input after reconnect", () => {
    const model = new DotsModel(); model.inputMode = "text"; model.transcript = "ASRの認識結果"; model.pendingTranscript = true;
    expect(model.history).toEqual([]); model.pendingTranscript = false; model.setActivity("waiting");
    const input = own("sent", 1, 20, model.transcript); model.incoming(input); model.incoming(input);
    model.setActivity("ready"); expect(model.asrCardVisible).toBe(false); model.select(input.id);
    expect(model.heading).toContain("あなた"); expect(model.history).toHaveLength(1);
    const restored = new DotsModel(model.save()); expect(restored.history).toHaveLength(1); expect(restored.selectedRole).toBe("user");
  });
  it("applies history limits to both authors without merging repeated words", () => {
    const model = new DotsModel(); for (let i = 1; i <= 40; i++) model.incoming(own(`own-${i}`, i, i, "同じ言葉"));
    model.setHistoryLimit(10); expect(model.messageCount).toBe(10); expect(model.visibleHistory[0]!.id).toBe("own-31");
    expect(model.history).toHaveLength(40); model.setHistoryLimit(50); expect(model.messageCount).toBe(40);
  });
  it("keeps the newest hundred messages when much older Mac input is imported", () => {
    const model = new DotsModel(); for (let i = 1; i <= 100; i++) model.textReply(`dot-${i}`, `返答${i}`, 1000 + i);
    model.incoming(own("ancient", 1, 10));
    expect(model.history).toHaveLength(100); expect(model.history[0]!.id).toBe("dot-1"); expect(model.selectedId).toBe("dot-100");
    expect(model.history.some(item => item.id === "ancient")).toBe(false);
  });
  it("keeps reply synchronization working with an older bridge that rejects the new input option", async () => {
    const model = new DotsModel(); const request = vi.fn()
      .mockRejectedValueOnce(new Error("Unsupported parameter"))
      .mockResolvedValueOnce({ items: [{ id: "old-dot", text: "既存ブリッジの返答", sequence: 1, receivedAt: 10 }], nextCursor: 1, hasMore: false, gap: false });
    await synchronizeInbox({ request }, model, vi.fn());
    expect(request).toHaveBeenCalledTimes(2); expect(request).toHaveBeenLastCalledWith("notification/sync", { after: 0, limit: 100 });
    expect(model.history[0]!.text).toBe("既存ブリッジの返答"); expect(model.initialized).toBe(true);
  });
  it("counts only Dot messages as unread", () => {
    const model = new DotsModel(); model.textReply("dot-1", "一件目", 1); model.textReply("dot-2", "二件目", 2); model.select("dot-1");
    model.incoming(own("own-1", 1, 3)); expect(model.unread).toBe(0);
    model.textReply("dot-3", "三件目", 4); model.incoming(own("own-2", 2, 5)); expect(model.unread).toBe(1);
  });
});

describe("own input notification isolation", () => {
  it("advances past own input without invoking the Dot notification delivery path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dots-own-cursor-")), path = join(directory, "cursor.json");
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const items = [{ ...{ id: "own", sequence: 1, sourceId: "s1", text: "自分の入力", receivedAt: 1 }, role: "user" as const }, { id: "dot", sequence: 2, sourceId: "s2", text: "Dotの新着", receivedAt: 2 }];
    const deliver = vi.fn(async (_notification: unknown, _signal: AbortSignal) => true);
    const coordinator = new DotsEchoNotifications({ path, retryMs: 5, canDeliver: () => true, notifications: async after => ({ items: items.filter(item => item.sequence > after), nextCursor: 2, hasMore: false, gap: false }), deliver });
    cleanups.push(() => coordinator.stop()); coordinator.start();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce()); expect(deliver.mock.calls[0]?.[0]).toMatchObject({ id: "dot" });
    expect(JSON.parse(readFileSync(path, "utf8")).cursor).toBe(2);
  });
});
