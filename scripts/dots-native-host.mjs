import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNativeMessage, NativeMessageDecoder } from "./dots-native-protocol.mjs";
import { recordVoiceEvent } from "./dots-voice-events.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, ".dots-bridge/dots-worker.json"), "utf8"));
const settings = JSON.parse(readFileSync(resolve(root, ".dots-bridge/dots-browser-install.json"), "utf8"));
const base = new URL(config.baseUrl);
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password
  || !/^[a-f0-9]{64}$/.test(config.token)
  || process.argv[2] !== `chrome-extension://${settings.extensionId}/`) process.exit(1);
const jobPath = resolve(root, ".dots-bridge/dots-browser-job.json");
const statePath = resolve(root, ".dots-bridge/dots-browser-state.json");
const metricsPath = resolve(root, ".dots-bridge/dots-browser-metrics.json");
const lockPath = resolve(root, ".dots-bridge/dots-browser-host.lock");
try {
  if (existsSync(lockPath)) {
    const previous = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(previous) || previous < 1) throw new Error("Invalid browser worker lock");
    try { process.kill(previous, 0); throw new Error("Another browser worker is connected"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
} catch (error) { process.stderr.write(error.message + "\n"); process.exit(1); }
process.on("exit", () => { if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath); });
const decoder = new NativeMessageDecoder();
let running = false, closing = false, job = null, pollAbort = null, jobTimer = null, sequence = Promise.resolve();
const save = (path, value) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
};
const status = (state, error) => save(statePath, { state, error, updatedAt: Date.now(), pid: process.pid });
const send = message => { if (!closing) process.stdout.write(encodeNativeMessage(message)); };
let voiceConnection, historyPending, historySending = false;
async function drainHistory() {
  historySending = true;
  try {
    while (historyPending && !closing) { const message = historyPending; historyPending = undefined; await handle(message); }
  } finally { historySending = false; }
}
function forwardVoiceMessage(message) {
  if (message?.type === "voice.diagnostic") { recordVoiceEvent(`extension-${message.event}`, message); return true; }
  if (["voice.state", "voice.result"].includes(message?.type)) { voiceConnection?.forward(message); return true; }
  return false;
}
const voiceConfigPath = resolve(root, ".dots-bridge/dots-voice-worker.json");
async function call(action, data, signal) {
  const response = await fetch(new URL(`/dots/worker/${action}`, base), {
    method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(data ?? {}), redirect: "error", signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Worker HTTP ${response.status}`);
  return result;
}
async function abandon(reason, sent = true) {
  clearTimeout(jobTimer);
  if (!job) return;
  await call("abandon", { id: job.id, lease: job.lease, sent, reason });
  unlinkSync(jobPath);
  job = null;
}
async function poll() {
  if (!running || closing || job || pollAbort) return;
  pollAbort = new AbortController();
  const abort = pollAbort;
  status("waiting");
  try {
    const next = await call("next", {}, abort.signal);
    if (!next) return;
    job = { ...next, receivedAt: Date.now() };
    save(jobPath, job); // Save before exposing input: reconnect never replays it.
    if (closing) { await abandon("Browser disconnected before dispatch", false); return; }
    status("processing");
    send({ type: "job", id: job.id, text: job.text });
    jobTimer = setTimeout(() => { void shutdown("Browser reply timed out"); }, 120_000);
  } catch (error) {
    if (!closing) { status("error", error.message); send({ type: "error", message: error.message }); running = false; }
  } finally {
    if (pollAbort === abort) pollAbort = null;
    if (running && !closing && !job) setTimeout(() => void poll(), 0);
  }
}
async function handle(message) {
  if (!message || typeof message !== "object") throw new Error("Invalid browser message");
  if (forwardVoiceMessage(message)) return;
  if (message.type === "ready") {
    if (running) return;
    if (message.url !== settings.dotUrl) throw new Error("Wrong dot page");
    if (!voiceConnection && existsSync(voiceConfigPath)) {
      const { connectDotsVoice } = await import("./dots-voice-native.mjs");
      voiceConnection = connectDotsVoice({ configPath: voiceConfigPath, dotUrl: settings.dotUrl, send, diagnostic: recordVoiceEvent });
    }
    if (existsSync(jobPath)) {
      job = JSON.parse(readFileSync(jobPath, "utf8"));
      const delivery = await call("delivery", { id: job.id });
      if (delivery.status === "processing") await abandon("Previous browser connection ended; input was not replayed");
      else { unlinkSync(jobPath); job = null; }
    }
    running = true;
    send({ type: "ready" });
    void poll();
    return;
  }
  if (message.type === "history") {
    if (!running) return;
    // History sync failure must not abort a call, delivery, or native host.
    try {
      const result = await call("history", { items: message.items, latest: message.latest });
      send({ type: "history-accepted", revision: message.revision, applied: result.applied });
    } catch (error) { send({ type: "history-error", revision: message.revision, message: error.message }); }
    return;
  }
  if (message.type === "notification") {
    if (!running) throw new Error("Browser notification before initialization");
    await call("notification", { sourceId: message.sourceId, text: message.text,
      ...(message.role === "user" ? { role: "user", ...(typeof message.inputId === "string" ? { inputId: message.inputId } : {}) } : {}) });
    send({ type: "notification-accepted", sourceId: message.sourceId });
    return;
  }
  if (!job || message.id !== job.id) throw new Error("Unknown browser delivery");
  if (message.type === "reply") {
    if (typeof message.text !== "string" || !message.text.trim() || [...message.text].length > 24_000) throw new Error("Invalid reply");
    const finished = job;
    await call("reply", { id: job.id, lease: job.lease, text: message.text, sourceId: message.sourceId });
    clearTimeout(jobTimer);
    unlinkSync(jobPath);
    job = null;
    const metrics = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, "utf8")) : [];
    metrics.push({ id: finished.id, completedAt: Date.now(), workerRoundTripMs: Date.now() - finished.receivedAt,
      browserReplyMs: Number.isFinite(message.browserReplyMs) ? message.browserReplyMs : null });
    save(metricsPath, metrics.slice(-100));
    send({ type: "accepted", id: finished.id });
    void poll();
  } else if (message.type === "failure") {
    await abandon(String(message.reason ?? "Browser failed"), message.sent !== false);
    send({ type: "accepted", id: message.id });
    void poll();
  } else throw new Error("Unsupported browser message");
}
async function shutdown(reason) {
  if (closing) return;
  closing = true; running = false; pollAbort?.abort(); clearTimeout(jobTimer);
  recordVoiceEvent("native-host-stopped", { reason: "native-host-disconnected" });
  voiceConnection?.close();
  try { await abandon(reason); } catch { /* Preserve the unresolved delivery for the next startup. */ }
  status("stopped", reason);
  process.exit(0);
}
process.stdin.on("data", chunk => {
  try {
    for (const message of decoder.push(chunk)) {
      if (forwardVoiceMessage(message)) continue;
      if (message?.type === "history") { historyPending = message; if (!historySending) void drainHistory(); continue; }
      sequence = sequence.then(() => handle(message)).catch(error => shutdown(error.message));
    }
  }
  catch (error) { void shutdown(error.message); }
});
process.stdin.on("end", () => void shutdown("Browser port closed"));
process.on("SIGTERM", () => void shutdown("Native host stopped"));
process.on("SIGINT", () => void shutdown("Native host stopped"));
process.stdout.on("error", () => void shutdown("Browser output closed"));
status("starting");
