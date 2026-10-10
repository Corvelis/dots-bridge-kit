import { EventEmitter, once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, it, expect, vi } from "vitest";
import { BrowserBroker } from "../dots-voice-bridge/src/browser-broker";
const dotUrl = "https://chatgpt.com/dots/test";
afterEach(() => vi.useRealTimers());
describe("Dot call control transport", () => {
  it("correlates responses, rejects another worker and never replays timed-out commands", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const broker = new BrowserBroker(dotUrl, 50);
    server.on("connection", socket => { if (!broker.attach(socket)) socket.close(4409); });
    const worker = new WebSocket(`ws://127.0.0.1:${port}`); await once(worker, "open");
    const commands: any[] = [];
    worker.on("message", data => commands.push(JSON.parse(data.toString())));
    try {
      const other = new WebSocket(`ws://127.0.0.1:${port}`); expect((await once(other, "close"))[0]).toBe(4409);
      const response = broker.command("status"); await vi.waitFor(() => expect(commands).toHaveLength(1), { interval: 5 });
      worker.send(JSON.stringify({ type: "voice.result", id: commands[0].id, snapshot: { state: "idle", url: dotUrl, ownedSession: null, muted: null } }));
      expect(await response).toMatchObject({ state: "idle" });
      const timeout = broker.command("start", "session-one"); await expect(timeout).rejects.toThrow("not replayed");
      expect(commands).toHaveLength(2);
      worker.send(JSON.stringify({ type: "voice.result", id: commands[1].id, snapshot: { state: "active", url: dotUrl, ownedSession: "session-one", muted: false } }));
      await new Promise(resolve => setTimeout(resolve, 10)); expect(broker.snapshot?.state).toBe("idle");
      const lost = broker.command("stop", "session-one"); worker.terminate(); await expect(lost).rejects.toThrow("disconnected"); expect(broker.online).toBe(false);
    } finally { broker.close(); worker.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("disconnects a worker that reports a different dot", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
    const broker = new BrowserBroker(dotUrl); server.on("connection", socket => broker.attach(socket));
    const worker = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`); await once(worker, "open");
    try {
      const closed = once(worker, "close");
      worker.send(JSON.stringify({ type: "voice.state", snapshot: { state: "idle", url: `${dotUrl}-other`, ownedSession: null, muted: null } }));
      expect((await closed)[0]).toBe(4400); expect(broker.online).toBe(false);
    } finally { broker.close(); worker.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("keeps a responsive native socket when Chrome's monitor is throttled, then accepts fresh state", async () => {
    vi.useFakeTimers(); const worker = new EventEmitter() as any; worker.readyState = WebSocket.OPEN;
    worker.ping = vi.fn(() => worker.emit("pong")); worker.terminate = vi.fn(() => { worker.readyState = WebSocket.CLOSED; worker.emit("close", 1006); });
    const broker = new BrowserBroker(dotUrl), changed = vi.fn(); broker.onChange = changed;
    try {
      broker.attach(worker); worker.emit("message", Buffer.from(JSON.stringify({ type: "voice.state", snapshot: { state: "active", url: dotUrl, ownedSession: "owned", muted: false } })), false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(worker.terminate).not.toHaveBeenCalled(); expect(broker.online).toBe(true);
      expect(changed.mock.calls.filter(([, reason]) => reason === "browser-monitor-stale")).toHaveLength(1);
      worker.emit("message", Buffer.from(JSON.stringify({ type: "voice.state", snapshot: { state: "active", url: dotUrl, ownedSession: "owned", muted: false } })), false);
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ state: "active" }), "browser-state-active");
    } finally { broker.close(); }
  });
});
