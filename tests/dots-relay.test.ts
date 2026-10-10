import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { DotsRelay } from "../bridge/src/dots-relay";
import { DotsGateway, dotsWorkerConfig } from "../bridge/src/dots-gateway";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers(); });
function setup(timeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "dots-relay-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "messages.json");
  const relay = new DotsRelay(path, timeoutMs);
  cleanup.push(() => relay.close());
  return { dir, path, relay };
}
const pull = (relay: DotsRelay) => relay.next(new AbortController().signal);

describe("dots reverse transport", () => {
  it("prevents two bridges from dispatching the same persisted queue", () => {
    const { path } = setup();
    expect(() => new DotsRelay(path)).toThrow("already open");
  });
  it("refuses input when no worker has connected", () => {
    const { relay } = setup();
    expect(() => relay.send("phone", "one", "hello")).toThrow("offline");
  });

  it("correlates a Japanese reply, hides leases and deduplicates reconnect sends", async () => {
    const { relay, path } = setup();
    const next = pull(relay);
    const accepted = relay.send("phone", "one", "こんにちは🌸");
    const job = (await next)!;
    expect(job.text).toBe("こんにちは🌸");
    expect(accepted).not.toHaveProperty("lease");
    expect(accepted.status).toBe("processing");
    expect(relay.send("phone", "one", "こんにちは🌸").id).toBe(job.id);
    expect(() => relay.send("phone", "one", "changed")).toThrow("different text");
    expect(() => relay.read("another-app", "one")).toThrow("Unknown message");
    expect(() => relay.reply(job.id, "wrong", "response")).toThrow("lease");
    relay.reply(job.id, job.lease, "こんにちは、届きました。");
    relay.reply(job.id, job.lease, "こんにちは、届きました。");
    expect(() => relay.reply(job.id, job.lease, "changed reply")).toThrow("no longer");
    expect(relay.read("phone", "one")).toMatchObject({ status: "completed", reply: "こんにちは、届きました。" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("does not redeliver a claimed operation to a second worker", async () => {
    const { relay } = setup();
    const next = pull(relay);
    await expect(pull(relay)).rejects.toThrow("already waiting");
    relay.send("phone", "one", "first");
    const job = (await next)!;
    relay.send("phone", "two", "second");
    await expect(pull(relay)).rejects.toThrow("already waiting");
    relay.reply(job.id, job.lease, "done first");
    const second = (await pull(relay))!;
    expect(second.text).toBe("second");
  });

  it("marks interrupted delivery uncertain after restart instead of replaying", async () => {
    const { relay, path } = setup();
    const next = pull(relay);
    relay.send("phone", "one", "may have executed");
    const job = (await next)!;
    relay.send("phone", "two", "not yet executed");
    relay.close();
    const restarted = new DotsRelay(path);
    cleanup.push(() => restarted.close());
    expect(restarted.read("phone", "one").status).toBe("uncertain");
    expect(restarted.read("phone", "two").status).toBe("failed");
    expect(restarted.send("phone", "one", "may have executed").status).toBe("uncertain");
    expect(() => restarted.reply(job.id, job.lease, "late")).toThrow("lease");
    expect(restarted.status.queued).toBe(0);
  });

  it("retains completed responses over restart", async () => {
    const { relay, path } = setup();
    const next = pull(relay);
    relay.send("phone", "one", "hello");
    const job = (await next)!;
    relay.reply(job.id, job.lease, "saved reply");
    relay.close();
    const restarted = new DotsRelay(path);
    cleanup.push(() => restarted.close());
    expect(restarted.send("phone", "one", "hello")).toMatchObject({ reply: "saved reply", status: "completed" });
  });

  it("expires delivery without authorizing a second execution", async () => {
    vi.useFakeTimers();
    const { relay } = setup(1000);
    const next = pull(relay);
    relay.send("phone", "one", "hello");
    const job = (await next)!;
    vi.advanceTimersByTime(1001);
    expect(relay.read("phone", "one").status).toBe("uncertain");
    expect(() => relay.reply(job.id, job.lease, "late")).toThrow("lease");
    expect(relay.status.workerOnline).toBe(false);
  });

  it("only allows the leased worker to abandon and distinguishes unsent failures", async () => {
    const { relay } = setup();
    const next = pull(relay);
    relay.send("phone", "blocked", "draft present");
    const job = (await next)!;
    expect(() => relay.abandon(job.id, "wrong", false, "failed")).toThrow("lease");
    relay.abandon(job.id, job.lease, false, "Composer has a draft");
    expect(relay.read("phone", "blocked").status).toBe("failed");
    expect(relay.status.workerOnline).toBe(false);
    expect(relay.send("phone", "blocked", "draft present").status).toBe("failed");
  });

  it("releases disconnected long polls and limits input and queue size", async () => {
    const { relay } = setup();
    const abort = new AbortController();
    const next = relay.next(abort.signal);
    abort.abort();
    expect(await next).toBeNull();
    const following = pull(relay);
    expect(() => relay.send("phone", "long", "🌸".repeat(12_001))).toThrow("12000");
    relay.send("phone", "one", "first");
    await following;
    for (let i = 0; i < 16; i++) relay.send("phone", `queued-${i}`, "queued");
    expect(() => relay.send("phone", "overflow", "more")).toThrow("queue is full");
  });
});

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  messages: any[] = [];
  closed?: number;
  send(text: string) { this.messages.push(JSON.parse(text)); }
  close(code: number) { this.closed = code; this.emit("close"); }
  receive(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
}

describe("dots gateway boundaries", () => {
  function createGateway() {
    const { dir } = setup();
    const workerToken = dotsWorkerConfig(join(dir, "worker.json"), 8787);
    const gateway = new DotsGateway({ tokenMatches: token => token === "phone-token", workerToken,
      historyPath: join(dir, "gateway.json") });
    cleanup.push(() => gateway.close());
    return { gateway, dir, workerToken };
  }
  function connect(gateway: DotsGateway, token = "phone-token", appId = "phone") {
    const socket = new FakeSocket();
    gateway.accept(socket as unknown as WebSocket);
    socket.receive({ type: "dots.hello", version: 1, token, appId });
    return socket;
  }
  it("authenticates the phone and never exposes worker credentials", () => {
    const { gateway, workerToken, dir } = createGateway();
    const bad = connect(gateway, "wrong");
    expect(bad.closed).toBe(4401);
    const socket = connect(gateway);
    expect(socket.messages[0]).toMatchObject({ type: "dots.ready", workerOnline: false });
    expect(JSON.stringify(socket.messages)).not.toContain(workerToken);
    expect(statSync(join(dir, "worker.json")).mode & 0o777).toBe(0o600);
    expect(dotsWorkerConfig(join(dir, "worker.json"), 8788)).toBe(workerToken);
    expect(JSON.parse(readFileSync(join(dir, "worker.json"), "utf8")).baseUrl).toBe("http://127.0.0.1:8788");
  });
  it("routes events only to the originating app and rejects arbitrary app tool calls", async () => {
    const { gateway } = createGateway();
    const a = connect(gateway);
    const b = connect(gateway, "phone-token", "second");
    const next = pull(gateway.relay);
    a.receive({ id: 1, method: "message/send", params: { requestId: "one", text: "hello" } });
    const job = (await next)!;
    gateway.relay.reply(job.id, job.lease, "reply");
    expect(a.messages.some(message => message.type === "dots.message" && message.message.reply === "reply")).toBe(true);
    expect(b.messages).toHaveLength(1);
    b.receive({ id: 2, method: "message/read", params: { requestId: "one" } });
    expect(b.messages.at(-1).error).toBeDefined();
    a.receive({ id: 3, method: "send_message_to_thread", params: {} });
    expect(a.messages.at(-1).error).toBeDefined();
  });
  it.each([
    ["untrusted.example", undefined, "worker"],
    ["127.0.0.1", "https://untrusted.example", "worker"],
    ["127.0.0.1", undefined, "phone"],
  ])("rejects worker access from %s with origin %s and credential %s", (remoteAddress, origin, kind) => {
    const { gateway, workerToken } = createGateway();
    const request = { url: "/dots/worker/next", method: "POST", socket: { remoteAddress },
      headers: { origin, authorization: `Bearer ${kind === "worker" ? workerToken : "phone-token"}` } };
    let status = 0;
    const response = { setHeader() {}, writeHead(code: number) { status = code; return this; }, end() {} };
    expect(gateway.handleHttp(request as unknown as IncomingMessage, response as unknown as ServerResponse)).toBe(true);
    expect(status).toBe(403);
  });
});
