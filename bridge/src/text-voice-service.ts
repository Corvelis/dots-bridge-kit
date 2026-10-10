import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { PROTOCOL_VERSION, type EchoPhase } from "../../shared/protocol";
import { TranscriptReview } from "./transcript-review";
import { DotsEchoNotifications } from "./dots-echo-notifications";
import type { DotsNotificationPage } from "./dots-echo-client";

export interface SpeechProvider {
  probe(): Promise<{ ok: boolean; authorization: string }>;
  start(id: string): Promise<void>; appendPcm(id: string, pcm: Buffer): boolean;
  stop(id: string): Promise<string>; cancel(id: string): Promise<void>;
}
interface Session {
  id: string; turn: number; generation: number; phase: EchoPhase; transcript: string; reply: string;
  recording?: string; abort?: AbortController; review: TranscriptReview;
  authenticated: boolean; command: Promise<void>;
  receipt?: { id: string; displayed(value: boolean): void };
}
export function createTextVoiceService(options: {
  token: string; speech: SpeechProvider;
  dots: { readonly ready: boolean; ask(text: string, signal: AbortSignal): Promise<string>; notifications?(after: number): Promise<DotsNotificationPage> };
  cursorPath?: string;
}) {
  const sessions = new Map<WebSocket, Session>();
  let activeRecording: Session | undefined, asrReady = false, asrAuthorization = "checking";
  let probing: Promise<void> | undefined;
  const probe = () => probing ??= options.speech.probe().then(status => {
    asrReady = status.ok; asrAuthorization = status.authorization;
  }).catch(() => { asrReady = false; asrAuthorization = "unavailable"; }).finally(() => { probing = undefined; });
  const send = (socket: WebSocket, value: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(1013, "slow client"); return; }
    socket.send(JSON.stringify(value));
  };
  const state = (socket: WebSocket, session: Session, phase: EchoPhase, message?: string) => {
    session.phase = phase; send(socket, { type: "echo.state", turnId: session.turn, phase, ...(message ? { message } : {}) });
  };
  const snapshot = (socket: WebSocket, session: Session) => send(socket, {
    type: "echo.snapshot", snapshot: { sessionId: session.id, phase: session.phase, transcript: session.transcript, reply: session.reply,
      config: { dedicatedDots: true, dotsReady: options.dots.ready, transcriptReview: true, asrReady } },
  });
  const cancel = async (socket: WebSocket, session: Session, notify = true) => {
    ++session.turn; ++session.generation; session.abort?.abort(); session.abort = undefined; session.review.clear();
    session.receipt?.displayed(false); session.receipt = undefined;
    const recording = session.recording; session.recording = undefined;
    if (activeRecording === session) activeRecording = undefined;
    if (recording) await options.speech.cancel(recording).catch(() => {});
    session.phase = "idle"; if (notify) state(socket, session, "idle");
  };
  const fail = (socket: WebSocket, session: Session, turn: number, message: string) => {
    if (turn !== session.turn || socket.readyState !== WebSocket.OPEN) return;
    state(socket, session, "error", message);
    send(socket, { type: "echo.error", turnId: turn, message, recoverable: true });
  };
  const ask = async (socket: WebSocket, session: Session, text: string) => {
    const turn = session.turn, abort = new AbortController(); session.abort = abort;
    state(socket, session, "thinking");
    try {
      const reply = await options.dots.ask(text, abort.signal);
      if (abort.signal.aborted || turn !== session.turn) return;
      session.reply = reply; send(socket, { type: "echo.reply", turnId: turn, text: reply, final: true });
      send(socket, { type: "echo.done", turnId: turn });
      state(socket, session, "idle");
    } catch (error) {
      if (!abort.signal.aborted) fail(socket, session, turn, error instanceof Error ? error.message : "Dot request failed");
    } finally { if (session.abort === abort) session.abort = undefined; }
  };
  const command = async (socket: WebSocket, session: Session, message: Record<string, unknown>) => {
    switch (message.type) {
      case "echo.voice.start": {
        if (!options.dots.ready) throw new Error("ChromeのDotブリッジを確認してください");
        if (!asrReady) throw new Error("音声認識を確認してください: " + asrAuthorization);
        if (activeRecording && activeRecording !== session) throw new Error("別の端末が録音中です");
        if (!["idle", "error"].includes(session.phase)) throw new Error("前の入力・返答を完了または中止してください");
        const turn = ++session.turn, recording = session.id + ":" + turn;
        session.recording = recording; activeRecording = session;
        session.transcript = ""; session.reply = ""; session.review.begin(turn, message.reviewTranscript === true);
        try { await options.speech.start(recording); }
        catch (error) { if (activeRecording === session) activeRecording = undefined; session.recording = undefined; throw error; }
        if (session.turn !== turn) { await options.speech.cancel(recording); return; }
        state(socket, session, "listening"); return;
      }
      case "echo.voice.stop": {
        if (session.phase !== "listening" || activeRecording !== session || !session.recording) throw new Error("録音は開始されていません");
        const turn = session.turn, recording = session.recording;
        state(socket, session, "transcribing");
        let text: string;
        try { text = (await options.speech.stop(recording)).trim(); }
        finally { if (activeRecording === session && session.turn === turn) activeRecording = undefined; }
        if (session.turn !== turn) return;
        session.recording = undefined; session.transcript = text;
        const disposition = session.review.finish({ turnId: turn, text });
        if (disposition === "stale") return;
        send(socket, { type: "echo.transcript", turnId: turn, text, final: true, ...(disposition === "review" ? { awaitingConfirmation: true } : {}) });
        if (!text) { state(socket, session, "idle", "NO SPEECH HEARD FROM G2"); return; }
        if (disposition !== "review") void ask(socket, session, text);
        return;
      }
      case "echo.transcript.submit": {
        if (message.turnId !== session.turn || session.phase !== "transcribing") throw new Error("送信確認中のASR結果がありません");
        if (!options.dots.ready) throw new Error("ChromeのDotブリッジを確認してください");
        const draft = session.review.take(session.turn); void ask(socket, session, draft.text); return;
      }
      case "echo.text.submit": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text || Array.from(text).length > 12000) throw new Error("Input must contain 1–12000 characters");
        if (!options.dots.ready || !["idle", "error"].includes(session.phase)) throw new Error("Dot is offline or a turn is still active");
        ++session.turn; session.transcript = text;
        send(socket, { type: "echo.transcript", turnId: session.turn, text, final: true }); void ask(socket, session, text); return;
      }
      default: throw new Error("Unsupported text voice command");
    }
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  wss.on("connection", socket => {
    const session: Session = { id: randomUUID(), turn: 0, generation: 0, phase: "idle", transcript: "", reply: "",
      authenticated: false, review: new TranscriptReview(), command: Promise.resolve() };
    sessions.set(socket, session);
    const timeout = setTimeout(() => socket.close(4401, "hello required"), 5000);
    socket.on("message", (raw: RawData, binary: boolean) => {
      if (binary) {
        if (!session.authenticated || session.phase !== "listening" || activeRecording !== session || !session.recording) return;
        const bytes = Buffer.from(raw as Buffer);
        if (!bytes.length || bytes.length % 2 || !options.speech.appendPcm(session.recording, bytes)) {
          void cancel(socket, session).then(() => fail(socket, session, session.turn, "録音データが上限に達しました"));
        }
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString());
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch { socket.close(4400, "invalid JSON"); return; }
      if (!session.authenticated) {
        const actual = Buffer.from(typeof message.token === "string" ? message.token : ""), expected = Buffer.from(options.token);
        if (message.type !== "hello" || message.version !== PROTOCOL_VERSION || message.client !== "dots"
          || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { socket.close(4401, "unauthorized"); return; }
        clearTimeout(timeout); session.authenticated = true; snapshot(socket, session); return;
      }
      if (message.type === "echo.snapshot.request") { snapshot(socket, session); return; }
      if (message.type === "echo.cancel" || message.type === "echo.session.reset") { void cancel(socket, session); return; }
      if (message.type === "echo.notification.displayed") {
        const receipt = session.receipt;
        if (receipt && message.turnId === session.turn && message.notificationId === receipt.id) receipt.displayed(true);
        return;
      }
      const generation = session.generation;
      session.command = session.command.then(async () => {
        if (socket.readyState === WebSocket.OPEN && session.generation === generation) await command(socket, session, message);
      }).catch(error => {
        if (session.generation === generation) fail(socket, session, session.turn, error instanceof Error ? error.message : "Text voice command failed");
      });
    });
    socket.on("error", () => {});
    socket.once("close", () => { clearTimeout(timeout); sessions.delete(socket); void cancel(socket, session, false); });
  });
  const target = () => [...sessions].find(([, session]) => session.authenticated && session.phase === "idle" && !session.recording && !session.receipt);
  const notifications = options.cursorPath && options.dots.notifications ? new DotsEchoNotifications({
    path: options.cursorPath, notifications: after => options.dots.notifications!(after),
    canDeliver: () => !!target(),
    deliver: async (notification, signal) => {
      const entry = target(); if (!entry) return false;
      const [socket, session] = entry, turn = ++session.turn, id = "dots:" + notification.id;
      const controller = new AbortController(); session.abort = controller;
      const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
      let displayed!: (value: boolean) => void;
      const displayReceipt = new Promise<boolean>(resolve => { displayed = resolve; });
      session.receipt = { id, displayed }; session.phase = "thinking";
      const timer = setTimeout(() => controller.abort(), 120000);
      const cancelled = new Promise<false>(resolve => controller.signal.addEventListener("abort", () => resolve(false), { once: true }));
      try {
        const item = { turnId: turn, notificationId: id, content: notification.text, createdAt: notification.receivedAt };
        send(socket, { type: "echo.dots.incoming", ...item }); send(socket, { type: "echo.notification", ...item });
        const shown = await Promise.race([displayReceipt, cancelled]);
        if (!shown || controller.signal.aborted || session.turn !== turn) return false;
        send(socket, { type: "echo.done", turnId: turn });
        state(socket, session, "idle");
        return socket.readyState === WebSocket.OPEN;
      } finally {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (session.turn === turn) { session.receipt = undefined; session.abort = undefined; session.phase = "idle"; }
      }
    },
    onError: () => console.error("Dot notification delivery will be retried"),
  }) : undefined;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, dotsReady: options.dots.ready,
        asrReady, asrAuthorization, clients: [...sessions.values()].filter(s => s.authenticated).length }));
    } else response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, peer => wss.emit("connection", peer));
  });
  const readiness = setInterval(() => { void probe().then(() => { for (const [socket, session] of sessions) if (session.authenticated) snapshot(socket, session); }); }, 15000);
  readiness.unref(); notifications?.start(); void probe();
  return { server, probe, async close() {
    clearInterval(readiness); notifications?.stop();
    await Promise.all([...sessions].map(([socket, session]) => cancel(socket, session, false)));
    for (const socket of sessions.keys()) socket.terminate();
    wss.close(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
