import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceEventRecorder } from "../scripts/dots-voice-events.mjs";

describe("Dots voice operational log", () => {
  it("records the end reason without accepting credentials, text or audio and rotates at one MiB", () => {
    const directory = mkdtempSync(join(tmpdir(), "dots-voice-events-")), path = join(directory, "events.jsonl");
    try {
      const record = createVoiceEventRecorder(path);
      record("call-ended", { reason: "client-recovery-timeout", closeCode: 1006, token: "private-token", resumeKey: "private-resume", text: "private-conversation", audio: "private-audio" });
      const text = readFileSync(path, "utf8"), event = JSON.parse(text);
      expect(event).toMatchObject({ event: "call-ended", reason: "client-recovery-timeout", closeCode: 1006 });
      expect(text).not.toContain("private"); expect(statSync(path).mode & 0o777).toBe(0o600);
      record("native-audio-restart-failed", { errorCode: "capture-process-exited", stage: "exit", exitCode: 1, signal: "SIGTERM", attempt: 2, droppedBytes: 640, droppedFrames: 1, queueLimitMs: 200, error: "private-diagnostic" });
      const diagnostic = readFileSync(path, "utf8").trim().split("\n").map(value => JSON.parse(value))[1];
      expect(diagnostic).toMatchObject({ errorCode: "capture-process-exited", stage: "exit", exitCode: 1, signal: "SIGTERM", attempt: 2, droppedBytes: 640, droppedFrames: 1, queueLimitMs: 200 });
      expect(JSON.stringify(diagnostic)).not.toContain("private");
      writeFileSync(path, " ".repeat(1_048_576)); record("client-recovered", { clientId: "new-client" });
      expect(statSync(`${path}.1`).size).toBe(1_048_576); expect(JSON.parse(readFileSync(path, "utf8")).event).toBe("client-recovered");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
