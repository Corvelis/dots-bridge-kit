import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { resolve } from "node:path";
import { createGateway } from "../scripts/gateway.mjs";
import { startBridge } from "../scripts/supervisor.mjs";

async function backend(kind: string) {
  const server = createServer((req, res) => res.writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify(req.url === "/health" ? { ok: true, kind } : { kind, path: req.url })));
  const ws = new WebSocketServer({ server, perMessageDeflate: false });
  ws.on("connection", socket => socket.on("message", (bytes, binary) => socket.send(bytes, { binary })));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { port: (server.address() as { port: number }).port,
    async close() { for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function unusedPorts() {
  const servers = await Promise.all(Array.from({ length: 4 }, async () => { const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); return server; }));
  const [port, relay, voice, text] = servers.map(server => (server.address() as { port: number }).port);
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  return { port, ports: { relay, voice, text } };
}
const fixture = resolve("tests/fixtures/bridge-worker.mjs");
describe("one public bridge endpoint", () => {
  it("routes browser assets and health while hiding native worker endpoints", async () => {
    const relay = await backend("relay"), voice = await backend("voice"), text = await backend("text");
    const gateway = createGateway({ relay: relay.port, voice: voice.port, text: text.port });
    gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
    const base = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
    try {
      expect((await fetch(base + "/voice")).status).toBe(503); gateway.setReady(true);
      for (const [path, kind] of [["/dots", "relay"], ["/voice", "voice"], ["/client.js", "voice"], ["/mic-worklet.js", "voice"]]) {
        expect(await (await fetch(base + path)).json()).toEqual({ path, kind });
      }
      const health = await (await fetch(base + "/health")).json();
      expect(health.ok).toBe(true); expect(Object.keys(health.components).sort()).toEqual(["relay", "text", "voice"]);
      for (const path of ["/dots/worker/next", "/voice/worker", "/unlisted"]) expect((await fetch(base + path)).status).toBe(404);
      expect((await fetch(base + "/dots/worker/next", { method: "POST" })).status).toBe(405);
      const blocked = new WebSocket(base.replace("http", "ws") + "/voice/worker");
      const [error] = await once(blocked, "error"); expect(error.message).toContain("404");
    } finally { gateway.close(); gateway.destroyConnections(); await Promise.all([relay.close(), voice.close(), text.close()]); }
  });
  it("preserves JSON/binary ordering and PCM bytes through every WebSocket path", async () => {
    const relay = await backend("relay"), voice = await backend("voice"), text = await backend("text");
    const gateway = createGateway({ relay: relay.port, voice: voice.port, text: text.port }); gateway.setReady(true);
    gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
    const base = `ws://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
    try {
      for (const path of ["/dots/ws", "/voice/ws", "/ws"]) {
        const client = new WebSocket(base + path, { perMessageDeflate: false }); await once(client, "open");
        const received: Array<{ data: Buffer; binary: boolean }> = [];
        client.on("message", (data, binary) => received.push({ data: Buffer.from(data as Buffer), binary }));
        const pcm = Buffer.alloc(64000); for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
        const complete = new Promise<void>(resolve => client.on("message", () => { if (received.length === 6) resolve(); }));
        for (let i = 0; i < 3; i++) { client.send(JSON.stringify({ index: i, byteLength: pcm.length })); client.send(pcm); }
        await complete;
        for (let i = 0; i < 3; i++) { expect(JSON.parse(received[2 * i]!.data.toString()).index).toBe(i); expect(received[2 * i]!.binary).toBe(false); expect(received[2 * i + 1]!.binary).toBe(true); expect(received[2 * i + 1]!.data.equals(pcm)).toBe(true); }
        const closed = once(client, "close"); client.close(); await closed;
      }
    } finally { gateway.close(); gateway.destroyConnections(); await Promise.all([relay.close(), voice.close(), text.close()]); }
  });
  it("starts private loopback workers together and finishes call teardown before the relay stops", async () => {
    const config = await unusedPorts(), stopped: string[] = [], exited: string[] = [], workers: ChildProcess[] = [];
    const bridge = await startBridge({ root: process.cwd(), config, host: "127.0.0.1", spawnWorker(kind: string, env: NodeJS.ProcessEnv) {
      for (const role of ["relay", "voice", "text"]) expect(env[`DOTS_${role.toUpperCase()}_HOST`]).toBe("127.0.0.1");
      const worker = spawn(process.execPath, [fixture, kind], { env, stdio: ["ignore", "ignore", "ignore", "ipc"] }); workers.push(worker);
      worker.on("message", message => { if ((message as any).type === "stopping") stopped.push(kind); }); worker.on("exit", () => exited.push(kind)); return worker;
    } });
    try { expect((await (await fetch(`http://127.0.0.1:${config.port}/health`)).json()).ok).toBe(true); }
    finally { await bridge.stop(); }
    expect((await bridge.done).error).toBeUndefined(); expect(stopped[0]).toBe("voice"); expect(exited[0]).toBe("voice");
    expect(workers.every(worker => worker.exitCode !== null || worker.signalCode !== null)).toBe(true);
  });
  it("stops sibling workers after an unexpected exit without replaying a call", async () => {
    const config = await unusedPorts(), workers = new Map<string, ChildProcess>();
    const bridge = await startBridge({ root: process.cwd(), config, host: "127.0.0.1", spawnWorker(kind: string, env: NodeJS.ProcessEnv) {
      const worker = spawn(process.execPath, [fixture, kind], { env, stdio: ["ignore", "ignore", "ignore", "ipc"] }); workers.set(kind, worker); return worker;
    } });
    workers.get("relay")!.kill("SIGTERM"); const result = await bridge.done;
    expect(result.error.message).toContain("relay worker stopped");
    expect([...workers.values()].every(worker => worker.exitCode !== null || worker.signalCode !== null)).toBe(true);
  });
  it("refuses a second public listener before starting any workers", async () => {
    const blocker = await backend("occupied"), config = await unusedPorts(); let spawned = false;
    try { await expect(startBridge({ root: process.cwd(), config: { ...config, port: blocker.port }, host: "127.0.0.1", spawnWorker() { spawned = true; throw new Error("Unexpected spawn"); } })).rejects.toThrow("EADDRINUSE"); expect(spawned).toBe(false); }
    finally { await blocker.close(); }
  });
  it("cleans up a partial startup when a worker cannot start", async () => {
    const config = await unusedPorts(), workers: ChildProcess[] = [];
    await expect(startBridge({ root: process.cwd(), config, host: "127.0.0.1", spawnWorker(kind: string, env: NodeJS.ProcessEnv) {
      const worker = spawn(process.execPath, [fixture, kind], { env: { ...env, TEST_FAIL_WORKER: "text" }, stdio: ["ignore", "ignore", "ignore", "ipc"] }); workers.push(worker); return worker;
    } })).rejects.toThrow("text worker");
    expect(workers.every(worker => worker.exitCode !== null || worker.signalCode !== null)).toBe(true);
  });
});
