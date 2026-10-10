import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
// @ts-expect-error This module also runs in Chrome's JavaScript native host.
import { connectDotsVoice } from "../scripts/dots-voice-native.mjs";
afterEach(() => vi.useRealTimers());

describe("Dots native voice preparation", () => {
  it("forwards profile preparation without claiming a call and rejects another dot", async () => {
    const dotUrl = "https://chatgpt.com/dots/test";
    const directory = mkdtempSync(join(tmpdir(), "dots-voice-native-"));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/voice/worker" });
    await once(server, "listening");
    const configPath = join(directory, "voice.json");
    writeFileSync(configPath, JSON.stringify({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/voice/worker`,
      dotUrl, token: "a".repeat(64) }), { mode: 0o600 });
    const connected = once(server, "connection");
    const sent: any[] = [];
    const adapter = connectDotsVoice({ configPath, dotUrl, send: (message: any) => sent.push(message) });
    const [worker] = await connected;
    try {
      worker.send(JSON.stringify({ type: "voice.worker.ready" }));
      await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ action: "status" })));
      const prepare = { type: "voice.command", id: "prepare", action: "prepare", url: dotUrl };
      worker.send(JSON.stringify(prepare));
      await vi.waitFor(() => expect(sent).toContainEqual(prepare));
      const closed = once(worker, "close");
      worker.send(JSON.stringify({ ...prepare, id: "wrong-dot", url: `${dotUrl}-other` }));
      expect((await closed)[0]).toBe(4400);
      expect(sent.some(message => message.action === "stop")).toBe(false);
      expect(sent.some(message => message.id === "wrong-dot")).toBe(false);
      expect(JSON.stringify(sent)).not.toContain("a".repeat(64));
    } finally {
      adapter.close(); worker.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([false, true])("preserves an owned call on native disconnect and handles reconnect=%s", async reconnect => {
    const dotUrl = "https://chatgpt.com/dots/test", directory = mkdtempSync(join(tmpdir(), "dots-voice-native-"));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/voice/worker" }); await once(server, "listening");
    const configPath = join(directory, "voice.json");
    writeFileSync(configPath, JSON.stringify({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/voice/worker`, dotUrl, token: "a".repeat(64) }));
    const sent: any[] = [], records: any[] = [];
    server.on("connection", socket => socket.on("message", () => { if (reconnect) socket.send(JSON.stringify({ type: "voice.worker.ready" })); }));
    const connected = once(server, "connection");
    const adapter = connectDotsVoice({ configPath, dotUrl, send: (message: any) => sent.push(message), diagnostic: (event: string) => records.push({ event, at: Date.now() }) });
    const [worker] = await connected;
    try {
      adapter.forward({ type: "voice.state", snapshot: { state: "active", ownedSession: "owned-call" } });
      vi.useFakeTimers(); const at = Date.now(); worker.terminate();
      await vi.waitFor(() => expect(records.some(record => record.event === "native-voice-disconnected")).toBe(true));
      expect(sent.some(message => message.action === "stop")).toBe(false);
      if (reconnect) {
        await vi.advanceTimersByTimeAsync(3000);
        // Let the real localhost handshake finish before moving the fake clock
        // a whole minute. Socket I/O is intentionally not a simulated timer.
        await vi.waitFor(() => expect(records.some(record => record.event === "native-voice-connected")).toBe(true));
      }
      await vi.advanceTimersByTimeAsync(Math.max(0, at + 59_000 - Date.now()));
      expect(sent.some(message => message.action === "stop")).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      expect(sent.some(message => message.action === "stop")).toBe(!reconnect);
      if (reconnect) expect(records.some(record => record.event === "native-voice-connected")).toBe(true);
    } finally {
      adapter.close(); vi.useRealTimers(); for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
    }
  });
});
