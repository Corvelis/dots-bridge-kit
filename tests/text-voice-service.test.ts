import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createTextVoiceService } from "../bridge/src/text-voice-service";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function bridge(options: { cursorPath?: string; notifications?: (after: number) => Promise<any> } = {}) {
  const token = randomBytes(32).toString("hex");
  const speech = {
    probe: vi.fn(async () => ({ ok: true, authorization: "authorized" })), start: vi.fn(async (_id: string) => {}),
    appendPcm: vi.fn((_id: string, _pcm: Buffer) => true), stop: vi.fn(async (_id: string) => "認識した文章"), cancel: vi.fn(async (_id: string) => {}),
  };
  const dots = { ready: true, ask: vi.fn(async (_text: string, _signal: AbortSignal) => "返答です"), notifications: options.notifications };
  const service = createTextVoiceService({ token, speech, dots, cursorPath: options.cursorPath });
  cleanup.push(() => service.close()); await service.probe();
  await new Promise<void>((resolve, reject) => { service.server.once("error", reject); service.server.listen(0, "127.0.0.1", resolve); });
  const port = (service.server.address() as { port: number }).port;
  async function connect(secret = token) {
    const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws");
    const messages: any[] = []; socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", version: 16, client: "dots", token: secret }));
    return { socket, messages, send: (message: unknown) => socket.send(JSON.stringify(message)),
      wait: async (type: string, match: (message: any) => boolean = () => true) => {
        await vi.waitFor(() => expect(messages.some(message => message.type === type && match(message))).toBe(true), { timeout: 3000 });
        return messages.find(message => message.type === type && match(message));
      } };
  }
  return { service, speech, dots, connect, port };
}

describe("public ASR / Dot text service", () => {
  it("rejects invalid pairing before any speech or Dot operation", async () => {
    const b = await bridge(); const peer = await b.connect("invalid");
    const code = await new Promise<number>(resolve => peer.socket.once("close", resolve));
    expect(code).toBe(4401); expect(peer.messages).toEqual([]); expect(b.dots.ask).not.toHaveBeenCalled(); expect(b.speech.start).not.toHaveBeenCalled();
  });
  it("allows local ASR and holds the draft until its exact turn is submitted", async () => {
    const b = await bridge(), peer = await b.connect();
    const snapshot = await peer.wait("echo.snapshot");
    expect(snapshot.snapshot.config).toMatchObject({ asrReady: true });
    peer.send({ type: "echo.voice.start", reviewTranscript: true });
    const listening = await peer.wait("echo.state", m => m.phase === "listening");
    peer.socket.send(Buffer.alloc(320)); peer.send({ type: "echo.voice.stop" });
    const transcript = await peer.wait("echo.transcript");
    expect(transcript).toMatchObject({ text: "認識した文章", awaitingConfirmation: true });
    expect(b.dots.ask).not.toHaveBeenCalled(); expect(b.speech.appendPcm).toHaveBeenCalled();
    peer.send({ type: "echo.transcript.submit", turnId: listening.turnId }); await peer.wait("echo.done");
    expect(b.dots.ask.mock.calls[0][0]).toBe("認識した文章"); expect(peer.messages.some(m => m.type === "echo.audio")).toBe(false);
    await peer.wait("echo.state", m => m.phase === "idle");
  });
  it("serializes immediate start and stop without dropping stop after the turn changes", async () => {
    const b = await bridge(), peer = await b.connect(); await peer.wait("echo.snapshot");
    peer.send({ type: "echo.voice.start" }); peer.send({ type: "echo.voice.stop" });
    await peer.wait("echo.done"); expect(b.speech.stop).toHaveBeenCalledOnce(); expect(b.dots.ask).toHaveBeenCalledOnce();
  });
  it("ignores stale display receipts outside a notification turn", async () => {
    const b = await bridge(), peer = await b.connect(); const first = await peer.wait("echo.snapshot");
    peer.send({ type: "echo.notification.displayed", turnId: 0 });
    peer.send({ type: "echo.snapshot.request" });
    await vi.waitFor(() => expect(peer.messages.filter(m => m.type === "echo.snapshot")).toHaveLength(2));
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    expect(peer.messages.at(-1).snapshot.sessionId).toBe(first.snapshot.sessionId);
    expect(peer.messages.some(m => m.type === "echo.error")).toBe(false);
  });
  it("completes consecutive text turns and returns to idle after each reply", async () => {
    const b = await bridge(), peer = await b.connect(); await peer.wait("echo.snapshot");
    for (const [turnId, text] of [[1, "最初の入力"], [2, "次の入力"]] as const) {
      peer.send({ type: "echo.text.submit", text });
      expect(await peer.wait("echo.reply", m => m.turnId === turnId)).toMatchObject({ text: "返答です", final: true });
      await peer.wait("echo.done", m => m.turnId === turnId); await peer.wait("echo.state", m => m.turnId === turnId && m.phase === "idle");
    }
    expect(b.dots.ask.mock.calls.map(([text]) => text)).toEqual(["最初の入力", "次の入力"]);
  });
  it("cancels waiting work, rejects a stale ASR draft and never emits a late reply", async () => {
    const b = await bridge(), peer = await b.connect(); await peer.wait("echo.snapshot");
    peer.send({ type: "echo.voice.start", reviewTranscript: true }); await peer.wait("echo.state", m => m.phase === "listening");
    peer.send({ type: "echo.voice.stop" }); const draft = await peer.wait("echo.transcript");
    peer.send({ type: "echo.cancel" }); await peer.wait("echo.state", m => m.phase === "idle");
    peer.send({ type: "echo.transcript.submit", turnId: draft.turnId }); await peer.wait("echo.error"); expect(b.dots.ask).not.toHaveBeenCalled();
    let resolveReply!: (text: string) => void;
    b.dots.ask.mockImplementationOnce(() => new Promise<string>(resolve => { resolveReply = resolve; }));
    peer.send({ type: "echo.text.submit", text: "送信済みの待機" }); await vi.waitFor(() => expect(b.dots.ask).toHaveBeenCalledOnce());
    const signal = b.dots.ask.mock.calls[0][1]; peer.send({ type: "echo.cancel" });
    await vi.waitFor(() => expect(signal.aborted).toBe(true)); resolveReply("取り消し後の返答");
    peer.send({ type: "echo.text.submit", text: "次の入力" }); await peer.wait("echo.done");
    expect(peer.messages.filter(m => m.type === "echo.reply").map(m => m.text)).toEqual(["返答です"]);
  });
  it("enforces a single recording owner and cancels malformed PCM without calling Dot", async () => {
    const b = await bridge(), a = await b.connect(), other = await b.connect(); await a.wait("echo.snapshot"); await other.wait("echo.snapshot");
    a.send({ type: "echo.voice.start" }); await a.wait("echo.state", m => m.phase === "listening");
    other.send({ type: "echo.voice.start" }); await other.wait("echo.error"); expect(b.speech.start).toHaveBeenCalledOnce();
    a.socket.send(Buffer.alloc(3)); await a.wait("echo.error"); expect(b.speech.cancel).toHaveBeenCalledOnce(); expect(b.dots.ask).not.toHaveBeenCalled();
  });
  it("saves a notification cursor only after the matching display acknowledgement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dots-public-notification-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "cursor.json"), notification = { id: "notification-1", sequence: 1, text: "新着です", receivedAt: Date.now() };
    const b = await bridge({ cursorPath: path, notifications: async after => ({ items: after < 1 ? [notification] : [], cursor: 1, hasMore: false, gap: false }) });
    const peer = await b.connect(), incoming = await peer.wait("echo.notification");
    expect(existsSync(path)).toBe(false);
    peer.send({ type: "echo.notification.displayed", turnId: incoming.turnId + 1, notificationId: incoming.notificationId });
    peer.send({ type: "echo.notification.displayed", turnId: incoming.turnId, notificationId: "other-notification" });
    peer.send({ type: "echo.snapshot.request" });
    await peer.wait("echo.snapshot", m => m.snapshot.phase === "thinking");
    expect(existsSync(path)).toBe(false);
    peer.send({ type: "echo.notification.displayed", turnId: incoming.turnId, notificationId: incoming.notificationId });
    await peer.wait("echo.done");
    await vi.waitFor(() => expect(existsSync(path)).toBe(true)); expect(JSON.parse(readFileSync(path, "utf8")).cursor).toBe(1);
  });
  it("keeps an undisplayed notification pending after the phone disconnects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dots-public-notification-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "cursor.json"), notification = { id: "pending", sequence: 1, text: "まだ表示していません", receivedAt: Date.now() };
    const b = await bridge({ cursorPath: path, notifications: async () => ({ items: [notification], cursor: 1, hasMore: false, gap: false }) });
    const peer = await b.connect(); await peer.wait("echo.notification");
    peer.socket.close(); await new Promise<void>(resolve => peer.socket.once("close", () => resolve()));
    const again = await b.connect(); await again.wait("echo.notification"); expect(existsSync(path)).toBe(false);
  });
});
