import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserBroker } from "./browser-broker";
import { NativeAudioRoute, nativeFailureDetails } from "./native-audio";
import { LiveAudioOutput } from "./live-audio-output";
import { secretMatches, VOICE_PROTOCOL } from "./protocol";
import { VoiceSession } from "./session";
import { createVoiceEventRecorder } from "../../scripts/dots-voice-events.mjs";

const workspace = process.cwd();
const root = resolve(workspace, "dots-voice-bridge");
const recordVoiceEvent = createVoiceEventRecorder(resolve(workspace, ".dots-bridge/dots-voice-events.jsonl"));
const stateDir = resolve(root, ".state"); mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const port = Number(process.env.DOTS_VOICE_PORT || 18799), host = process.env.DOTS_VOICE_HOST || "127.0.0.1";
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Dots voice port");
const pairing = JSON.parse(readFileSync(resolve(workspace, ".dots-bridge/pairing.json"), "utf8"));
const token = process.env.DOTS_BRIDGE_TOKEN || pairing.token;
if (typeof token !== "string" || token.length < 16) throw new Error("Existing bridge pairing token is required");
const install = JSON.parse(readFileSync(resolve(workspace, ".dots-bridge/dots-browser-install.json"), "utf8"));
if (!/^https:\/\/chatgpt\.com\/dots\/(?:home|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(install.dotUrl)) throw new Error("Configure the existing dot browser bridge first");
const workerPath = resolve(workspace, ".dots-bridge/dots-voice-worker.json");
const workerToken = existsSync(workerPath) ? JSON.parse(readFileSync(workerPath, "utf8")).token : randomBytes(32).toString("hex");
if (typeof workerToken !== "string" || !/^[a-f0-9]{64}$/.test(workerToken)) throw new Error("Invalid local voice worker credential");
const recoveryPath = resolve(stateDir, "call-recovery.json");
const recoveredSession = existsSync(recoveryPath) ? JSON.parse(readFileSync(recoveryPath, "utf8")).sessionId : undefined;
const broker = new BrowserBroker(install.dotUrl), audio = new NativeAudioRoute(root);
const clients = new Map<WebSocket, { id: string; authenticated: boolean; busy: boolean; resumeKey?: string }>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
const workers = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
const alive = new WeakSet<WebSocket>();
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!alive.has(socket)) { recordVoiceEvent("client-heartbeat-timeout", { clientId: clients.get(socket)?.id }); socket.terminate(); continue; }
    alive.delete(socket); socket.ping();
  }
}, 15_000); heartbeat.unref();
function send(socket: WebSocket, value: unknown) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function broadcast(value: unknown) { for (const [socket, client] of clients) if (client.authenticated) send(socket, value); }
const liveOutput = new LiveAudioOutput(() => session.resetForOutputGap(), (event, detail) => recordVoiceEvent(event, { clientId: session.owner, ...detail }));
const session = new VoiceSession({ browser: broker, audio, recoveredSession, record: recordVoiceEvent,
  emit: broadcast,
  output(pcm, sampleRate, channels, streamId) {
    const entry = [...clients].find(([, client]) => client.id === session.owner);
    if (!entry) return;
    const [socket] = entry;
    liveOutput.send(socket, pcm, { streamId, route: session.route, sampleRate, channels });
  },
  saveRecovery(sessionId) {
    if (sessionId) writeFileSync(recoveryPath, JSON.stringify({ sessionId }), { mode: 0o600 });
    else if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
  },
});
broker.onDiagnostic = recordVoiceEvent;
broker.onChange = (snapshot, reason) => { session.browserChanged(snapshot, reason); broadcast({ type: "browser.state", online: broker.online, snapshot: snapshot ?? null }); };
audio.onDiagnostic = (event, detail) => recordVoiceEvent(event, { phase: session.phase, sessionId: session.sessionId, ...detail });
audio.onFailure = error => { recordVoiceEvent("native-audio-failed", { phase: session.phase, sessionId: session.sessionId, ...nativeFailureDetails(error) }); session.audioFailed(error); };
workers.on("connection", socket => {
  const timeout = setTimeout(() => socket.close(4401, "Worker authentication required"), 5000);
  socket.once("message", (data, binary) => {
    try {
      const hello = JSON.parse(data.toString());
      if (binary || hello.type !== "voice.worker.hello" || hello.url !== install.dotUrl || !secretMatches(workerToken, hello.token)) throw new Error("unauthorized");
      clearTimeout(timeout);
      if (!broker.attach(socket)) { socket.close(4409, "Another browser worker is attached"); return; }
      send(socket, { type: "voice.worker.ready" });
    } catch { socket.close(4401, "Worker authentication failed"); }
  });
  socket.on("error", () => socket.terminate()); socket.once("close", () => clearTimeout(timeout));
});
wss.on("connection", socket => {
  if (clients.size >= 8) { socket.close(4429, "Too many clients"); return; }
  const client: { id: string; authenticated: boolean; busy: boolean; resumeKey?: string } = { id: randomUUID(), authenticated: false, busy: false }; clients.set(socket, client);
  alive.add(socket); socket.on("pong", () => alive.add(socket));
  const timer = setTimeout(() => socket.close(4401, "voice.hello required"), 5000);
  socket.on("message", (data, binary) => {
    if (!client.authenticated) {
      try {
        const hello = JSON.parse(data.toString());
        if (binary || hello.type !== "voice.hello" || hello.version !== VOICE_PROTOCOL || !secretMatches(token, hello.token)) throw new Error("unauthorized");
        if (hello.resumeKey !== undefined && (typeof hello.resumeKey !== "string" || !/^[a-f0-9]{64}$/.test(hello.resumeKey))) throw new Error("invalid resume key");
        client.resumeKey = hello.resumeKey;
        clearTimeout(timer); client.authenticated = true;
        session.resumeClient(client.id, client.resumeKey);
        send(socket, { type: "voice.ready", version: 1, clientId: client.id, input: { format: "pcm_s16le", sampleRate: 16_000, channels: 1 },
          state: session.status, dotUrl: install.dotUrl });
      } catch { socket.close(4401, "Unauthorized or incompatible client"); } return;
    }
    if (binary) {
      try { session.append(client.id, Buffer.from(data as Buffer)); }
      catch (error) { session.pauseInput("input-transfer-failed"); send(socket, { type: "voice.error", message: (error as Error).message }); }
      return;
    }
    void (async () => {
      let id: unknown, acquired = false;
      try {
        const request = JSON.parse(data.toString()); id = request.id;
        if (typeof id !== "string" || id.length > 80 || !id) throw new Error("Request id required");
        if (client.busy && !["status", "session.stop"].includes(request.method)) throw new Error("Previous command is still running");
        if (!client.busy) { client.busy = true; acquired = true; }
        let result: unknown;
        switch (request.method) {
          case "status": result = { ...session.status, browser: broker.snapshot ?? null }; break;
          case "session.start": result = await session.start(client.id, client.resumeKey); break;
          case "session.stop": result = await session.stop(client.id); break;
          case "audio.input":
            if (typeof request.params?.enabled !== "boolean") throw new Error("enabled must be boolean");
            result = session.setInput(client.id, request.params.enabled); break;
          default: throw new Error("Unsupported voice method");
        }
        send(socket, { id, result });
      } catch (error) { send(socket, { id: typeof id === "string" ? id : null, error: { message: (error as Error).message } }); }
      finally { if (acquired) client.busy = false; }
    })();
  });
  socket.on("error", () => socket.terminate());
  socket.once("close", code => {
    clearTimeout(timer); clients.delete(socket);
    recordVoiceEvent("client-closed", { clientId: client.id, closeCode: code });
    session.clientDisconnected(client.id);
  });
});
const assets: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"], "/voice": ["index.html", "text/html"],
  "/client.js": ["client.js", "text/javascript"], "/mic-worklet.js": ["mic-worklet.js", "text/javascript"],
};
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, version: "0.1.0", implementationVersion: "0.3.0", ...session.status })); return;
  }
  const asset = assets[pathname];
  if (!asset) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8` }); response.end(readFileSync(resolve(root, "public", asset[0])));
});
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
  if (pathname === "/voice/ws") wss.handleUpgrade(request, socket, head, client => wss.emit("connection", client));
  else if (pathname === "/voice/worker" && loopback && !request.headers.origin) workers.handleUpgrade(request, socket, head, client => workers.emit("connection", client));
  else { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); }
});
server.listen(port, host, () => {
  writeFileSync(workerPath, JSON.stringify({ url: `ws://127.0.0.1:${port}/voice/worker`, token: workerToken, dotUrl: install.dotUrl }), { mode: 0o600 });
  console.log("Dots call/audio worker ready");
  recordVoiceEvent("bridge-started", { phase: session.phase });
  process.send?.({ type: "ready", kind: "voice", port });
});
server.on("error", error => { console.error(error.message); broker.close(); process.exitCode = 1; });
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (closing) return; closing = true;
  clearInterval(heartbeat);
  recordVoiceEvent("bridge-shutdown", { reason: signal, phase: session.phase });
  void session.stop(undefined, "bridge-shutdown").finally(() => { broker.close(); for (const socket of clients.keys()) socket.terminate(); wss.close(); workers.close(); server.close(() => process.exit(0)); server.closeAllConnections(); });
  setTimeout(() => process.exit(1), 30_000).unref();
});
