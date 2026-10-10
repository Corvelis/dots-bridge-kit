import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.dots-bridge/dots-voice-events.jsonl");
const fields = new Set(["reason", "phase", "sessionId", "clientId", "browserState", "browserOnline", "closeCode", "graceMs", "bufferedBytes", "inputBytes", "outputBytes", "stage", "errorCode", "observedAt", "exitCode", "signal", "attempt", "droppedBytes", "droppedFrames", "queueLimitMs"]);
/** Structured operational events only: never accept tokens, URLs, text or audio. */
export function createVoiceEventRecorder(path = defaultPath) {
  return (event, detail = {}) => {
    try {
      const data = { at: new Date().toISOString(), event: String(event).replace(/[^a-z0-9_.-]/gi, "").slice(0, 80), pid: process.pid };
      for (const [key, value] of Object.entries(detail)) {
        if (!fields.has(key)) continue;
        if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null) data[key] = value;
        else if (typeof value === "string") data[key] = value.replace(/[^a-z0-9_.:-]/gi, "").slice(0, 100);
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && statSync(path).size >= 1_048_576) renameSync(path, `${path}.1`);
      appendFileSync(path, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch { /* Diagnostics cannot disrupt an active call. */ }
  };
}
export const recordVoiceEvent = createVoiceEventRecorder();
