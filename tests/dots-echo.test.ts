import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { DotsGateway } from "../bridge/src/dots-gateway";
import { DotsEchoClient } from "../bridge/src/dots-echo-client";
import { DotsEchoNotifications } from "../bridge/src/dots-echo-notifications";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function bridge() {
  const directory = mkdtempSync(join(tmpdir(), "dots-echo-test-"));
  const gateway = new DotsGateway({ historyPath: join(directory, "history.json"), workerToken: "worker",
    tokenMatches: token => token === "pair-token" });
  const server = createServer();
  const connections = new Set<Socket>();
  server.on("connection", socket => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
  server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const worker = new AbortController();
  const job = gateway.relay.next(worker.signal);
  const client = new DotsEchoClient({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/dots/ws`,
    token: "pair-token", reconnectMs: 15 });
  const connected = new Promise<void>(resolve => client.once("connected", resolve));
  client.start(); await connected;
  cleanup.push(async () => {
    client.stop(); worker.abort(); gateway.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { gateway, client, job, directory, disconnect: () => { for (const socket of connections) socket.destroy(); } };
}

describe("Echo transport to the existing dot", () => {
  it("uses the authenticated bridge and accepts the matching dot reply", async () => {
    const { client, gateway, job } = await bridge();
    expect(client.ready).toBe(true);
    const reply = client.ask("音声から認識したこんにちは", new AbortController().signal);
    const delivery = (await job)!;
    expect(delivery.text).toBe("音声から認識したこんにちは");
    gateway.relay.reply(delivery.id, delivery.lease, "こんにちは、また話せてうれしいよ。");
    await expect(reply).resolves.toBe("こんにちは、また話せてうれしいよ。");
    gateway.inbox.publish("spontaneous-1", "おはよう！");
    expect(await client.notifications(0)).toMatchObject({ items: [{ text: "おはよう！" }], nextCursor: 2 });
  });

  it("stops waiting on cancellation, leaves the accepted dot turn alone, and accepts a subsequent turn", async () => {
    const { client, gateway, job } = await bridge();
    const abort = new AbortController();
    const reply = client.ask("一回目", abort.signal);
    const rejected = expect(reply).rejects.toMatchObject({ name: "AbortError" });
    const delivery = (await job)!;
    abort.abort(); await rejected;
    gateway.relay.reply(delivery.id, delivery.lease, "遅れて届いた返答");
    const nextJob = gateway.relay.next(new AbortController().signal);
    const nextReply = client.ask("二回目", new AbortController().signal);
    const next = (await nextJob)!;
    gateway.relay.reply(next.id, next.lease, "二回目の返答");
    await expect(nextReply).resolves.toBe("二回目の返答");
  });

  it("reconnects without replaying an accepted message after a lost connection", async () => {
    const { client, gateway, job, directory, disconnect } = await bridge();
    const reply = client.ask("再送しないで", new AbortController().signal);
    const rejected = expect(reply).rejects.toThrow("will not be sent again automatically");
    const delivery = (await job)!;
    disconnect();
    await rejected;
    await vi.waitFor(() => expect(client.ready).toBe(true));
    const records = JSON.parse(readFileSync(join(directory, "history.json"), "utf8"));
    expect(records).toHaveLength(1);
    gateway.relay.reply(delivery.id, delivery.lease, "再送なし");
  });

  it("handles a completion event before the send acknowledgement and rejects offline input", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(resolve => server.once("listening", resolve));
    server.on("connection", socket => socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "dots.hello") socket.send(JSON.stringify({ type: "dots.ready", workerOnline: true }));
      else if (message.method === "message/send") {
        const record = { ...message.params, status: "completed", reply: "先に返答" };
        socket.send(JSON.stringify({ type: "dots.message", message: record }));
        socket.send(JSON.stringify({ id: message.id, result: { ...record, status: "queued" } }));
      }
    }));
    const client = new DotsEchoClient({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "test" });
    cleanup.push(async () => { client.stop(); for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve())); });
    await expect(client.ask("未接続", new AbortController().signal)).rejects.toThrow("OFFLINE");
    const connected = new Promise<void>(resolve => client.once("connected", resolve));
    client.start(); await connected;
    await expect(client.ask("こんにちは", new AbortController().signal)).resolves.toBe("先に返答");
  });
});

describe("dot notification voice delivery", () => {
  it("waits while busy, persists only after acknowledgement, and resumes without repeating acknowledged speech", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dots-echo-notifications-"));
    const path = join(directory, "cursor.json");
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    let available = false;
    let finishPlayback!: (value: boolean) => void;
    const spoken: number[] = [];
    const items = [1, 2].map(sequence => ({ id: `n${sequence}`, sequence, sourceId: `s${sequence}`,
      text: `通知${sequence}`, receivedAt: Date.now() }));
    const notifications = vi.fn(async (after: number) => ({ items: items.filter(n => n.sequence > after),
      nextCursor: 2, hasMore: false, gap: false }));
    const coordinator = new DotsEchoNotifications({ path, notifications, retryMs: 10,
      canDeliver: () => available, deliver: async item => {
        spoken.push(item.sequence);
        return new Promise<boolean>(resolve => { finishPlayback = resolve; });
      } });
    cleanup.push(() => coordinator.stop());
    coordinator.start();
    expect(notifications).not.toHaveBeenCalled();
    available = true; coordinator.poke();
    await vi.waitFor(() => expect(spoken).toEqual([1]));
    expect(existsSync(path)).toBe(false);
    available = false; finishPlayback(true);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(path, "utf8")).cursor).toBe(1));
    coordinator.stop();
    const resumed = new DotsEchoNotifications({ path, notifications, retryMs: 10,
      canDeliver: () => available, deliver: async item => { spoken.push(item.sequence); available = false; return true; } });
    cleanup.push(() => resumed.stop());
    available = true; resumed.start();
    await vi.waitFor(() => expect(spoken).toEqual([1, 2]));
    expect(JSON.parse(readFileSync(path, "utf8")).cursor).toBe(2);
  });

  it("keeps cancelled notifications pending for the next connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dots-echo-cancel-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "cursor.json");
    const item = { id: "n1", sequence: 1, sourceId: "s1", text: "あとで話す", receivedAt: 1 };
    let available = true;
    const coordinator = new DotsEchoNotifications({ path, retryMs: 10,
      notifications: async () => ({ items: [item], nextCursor: 1, hasMore: false, gap: false }),
      canDeliver: () => available, deliver: async () => { available = false; return false; } });
    cleanup.push(() => coordinator.stop()); coordinator.start();
    await vi.waitFor(() => expect(available).toBe(false));
    expect(existsSync(path)).toBe(false);
  });
});
