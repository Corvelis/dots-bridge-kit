import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

// A second, independent control connection. Audio stays in the native helper;
// credentials never enter the extension or the ChatGPT page.
export function connectDotsVoice({ configPath, dotUrl, send, diagnostic = () => {} }) {
  let socket, retry, offlineTimer, stopped = false, ownedSession = null;
  function connect() {
    if (stopped) return;
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")), url = new URL(config.url);
      if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/voice/worker"
        || url.username || url.password || url.search || url.hash || config.dotUrl !== dotUrl
        || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error("Invalid local voice worker config");
      const connection = new WebSocket(config.url, { perMessageDeflate: false, maxPayload: 8192 }); socket = connection;
      connection.once("open", () => connection.send(JSON.stringify({ type: "voice.worker.hello", url: dotUrl, token: config.token })));
      connection.on("message", (raw, binary) => {
        try {
          const message = JSON.parse(raw.toString());
          if (binary) throw new Error("Invalid frame");
          if (message.type === "voice.worker.ready") {
            clearTimeout(offlineTimer); offlineTimer = null;
            diagnostic("native-voice-connected", {});
            send({ type: "voice.command", id: "voice-monitor", action: "status", url: dotUrl }); return;
          }
          if (message.type !== "voice.command" || message.url !== dotUrl || typeof message.id !== "string"
            || !["start", "stop", "status", "prepare"].includes(message.action)) throw new Error("Invalid voice command");
          if (message.action === "start") ownedSession = message.sessionId;
          send(message);
        } catch { connection.close(4400, "Invalid command"); }
      });
      connection.on("error", () => {});
      connection.once("close", code => {
        if (socket !== connection) return;
        socket = undefined;
        diagnostic("native-voice-disconnected", { closeCode: code, graceMs: 60000 });
        if (!stopped && ownedSession && !offlineTimer) {
          const previous = ownedSession;
          offlineTimer = setTimeout(() => {
            offlineTimer = null;
            if (!stopped && ownedSession === previous) {
              diagnostic("native-voice-recovery-timeout", { sessionId: previous });
              send({ type: "voice.command", id: `voice-offline-${Date.now()}`, action: "stop", sessionId: previous, url: dotUrl });
            }
          }, 60000);
          offlineTimer.unref();
        }
        if (!stopped) retry = setTimeout(connect, 3000);
      });
    } catch { if (!stopped) retry = setTimeout(connect, 3000); }
  }
  connect();
  return {
    forward(message) {
      if (!["voice.state", "voice.result"].includes(message.type)) return false;
      if (message.snapshot?.state === "idle" && !message.snapshot.ownedSession) { ownedSession = null; clearTimeout(offlineTimer); offlineTimer = null; }
      else if (/^[a-zA-Z0-9-]{1,80}$/.test(message.snapshot?.ownedSession || "")) ownedSession = message.snapshot.ownedSession;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      return true;
    },
    close() { stopped = true; clearTimeout(retry); clearTimeout(offlineTimer); socket?.close(); },
  };
}
