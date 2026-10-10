import { afterEach, describe, it, expect, vi } from "vitest";
import { VoiceSession } from "../dots-voice-bridge/src/session";
import { NativeAudioError } from "../dots-voice-bridge/src/native-audio";
import type { AudioRoute, CallSnapshot, CallController } from "../dots-voice-bridge/src/protocol";

const url = "https://chatgpt.com/dots/test";
function setup(recoveredSession?: string) {
  let snapshot: CallSnapshot = { state: "idle", url, ownedSession: null, muted: null };
  const calls: string[] = [], restores: boolean[] = [], events: any[] = [], output: Buffer[] = [], records: any[] = [];
  let source: (pcm: Buffer) => void = () => {}, held = Boolean(recoveredSession), offline = false;
  let preparedSnapshot: CallSnapshot | undefined;
  const audio: AudioRoute = {
    get heldInput() { return held; },
    async prepare(callback, signal) { held = true; source = callback; signal.throwIfAborted(); },
    append(pcm) { calls.push(`input:${pcm.length}`); },
    async stop(restore) { restores.push(restore); if (restore) held = false; },
  };
  const browser: CallController = {
      get online() { return !offline; },
      async command(action, sessionId) {
        calls.push(action);
        if (offline) throw new Error("browser offline");
        if (action === "prepare" && preparedSnapshot) snapshot = preparedSnapshot;
        if (action === "start") snapshot = { state: "active", url, ownedSession: sessionId!, muted: false };
        if (action === "stop") snapshot = { state: "idle", url, ownedSession: null, muted: null };
        return snapshot;
      },
    };
  const session = new VoiceSession({ audio, recoveredSession, browser, record: (event, detail) => records.push({ event, ...detail }),
    emit: event => events.push(event), output: pcm => output.push(pcm), saveRecovery: id => calls.push(`save:${id ? "owned" : "clear"}`),
  });
  return { session, audio, browser, calls, restores, records, events, output, source: (pcm: Buffer) => source(pcm),
    snapshot: (value: CallSnapshot) => { snapshot = value; }, offline: (value: boolean) => { offline = value; },
    preparedSnapshot: (value: CallSnapshot) => { preparedSnapshot = value; },
  };
}
const captureError = new NativeAudioError("private capture diagnostics", "capture-process-exited", "exit", 1);
afterEach(() => vi.useRealTimers());
describe("Dots voice call lifecycle", () => {
  it("prepares hidden controls before changing audio routing and starting", async () => {
    const t = setup(); t.snapshot({ state: "unknown", url, ownedSession: null, muted: null });
    t.preparedSnapshot({ state: "idle", url, ownedSession: null, muted: null });
    await t.session.start("phone");
    expect(t.calls.slice(0, 2)).toEqual(["status", "prepare"]);
    expect(t.calls.indexOf("prepare")).toBeLessThan(t.calls.indexOf("save:owned"));
    expect(t.session.phase).toBe("active"); await t.session.stop();
  });
  it("rejects a hidden manual call after revealing controls without changing its audio route", async () => {
    const t = setup(); t.snapshot({ state: "unknown", url, ownedSession: null, muted: null });
    const prepareAudio = vi.spyOn(t.audio, "prepare");
    t.preparedSnapshot({ state: "active", url, ownedSession: null, muted: false });
    await expect(t.session.start("phone")).rejects.toThrow("existing Dots call");
    expect(t.calls).not.toContain("start"); expect(t.calls).not.toContain("stop");
    expect(prepareAudio).not.toHaveBeenCalled();
    expect(t.audio.heldInput).toBe(false); expect(t.session.phase).toBe("idle");
  });
  it("does not treat unrevealed or owned unknown controls as an idle call", async () => {
    const t = setup(); t.snapshot({ state: "unknown", url, ownedSession: null, muted: null });
    await expect(t.session.start("phone")).rejects.toThrow("existing Dots call");
    expect(t.calls).toContain("prepare"); expect(t.calls).not.toContain("start"); expect(t.audio.heldInput).toBe(false);
    const owned = setup(); owned.snapshot({ state: "unknown", url, ownedSession: "old-session", muted: null });
    await expect(owned.session.start("phone")).rejects.toThrow("existing Dots call");
    expect(owned.calls).not.toContain("prepare"); expect(owned.audio.heldInput).toBe(false);
  });
  it("prepares routing, persists ownership, gates input by owner and PTT, and confirms end before restoration", async () => {
    const t = setup(); await t.session.start("phone");
    expect(t.session.phase).toBe("active");
    expect(t.calls.indexOf("save:owned")).toBeLessThan(t.calls.indexOf("start"));
    t.session.append("phone", Buffer.alloc(640)); expect(t.session.inputBytes).toBe(0);
    expect(() => t.session.setInput("other", true)).toThrow("no active call");
    t.session.setInput("phone", true); t.session.append("other", Buffer.alloc(640));
    t.session.append("phone", Buffer.alloc(640)); expect(t.session.inputBytes).toBe(640);
    t.source(Buffer.alloc(7680)); expect(t.output).toHaveLength(1);
    await expect(t.session.stop("other")).rejects.toThrow("owns");
    await t.session.stop("phone"); expect(t.restores).toEqual([true]); expect(t.session.phase).toBe("idle");
    t.source(Buffer.alloc(7680)); expect(t.output).toHaveLength(1);
    await t.session.stop(); expect(t.restores).toHaveLength(1);
  });
  it("never attaches or ends a manually started call", async () => {
    const t = setup(); t.snapshot({ state: "active", url, ownedSession: null, muted: false });
    await expect(t.session.start("phone")).rejects.toThrow("existing Dots call");
    expect(t.calls).not.toContain("start"); expect(t.calls).not.toContain("stop"); expect(t.session.phase).toBe("idle");
  });
  it("rejects a second caller while preparation is pending", async () => {
    const t = setup(); let release!: () => void;
    t.audio.prepare = async () => new Promise<void>(resolve => { release = resolve; });
    const first = t.session.start("phone"); await Promise.resolve(); await Promise.resolve();
    await expect(t.session.start("other")).rejects.toThrow("already active");
    release(); await first; await t.session.stop();
  });
  it("cancels during preparation without issuing a late Start command", async () => {
    const t = setup(); let release!: () => void;
    t.audio.prepare = async () => new Promise<void>(resolve => { release = resolve; });
    const first = t.session.start("phone").catch(error => error);
    await Promise.resolve(); await Promise.resolve(); const stop = t.session.stop("phone"); release();
    expect(await first).toBeInstanceOf(Error); await stop;
    expect(t.calls).not.toContain("start"); expect(t.session.phase).toBe("idle");
  });
  it("holds the virtual mic if disconnected and recovers only after idle is verified", async () => {
    const t = setup(); await t.session.start("phone"); t.offline(true);
    await t.session.stop("phone"); expect(t.restores).toEqual([false]); expect(t.session.phase).toBe("needs-stop");
    expect(t.audio.heldInput).toBe(true);
    await expect(t.session.start("phone")).rejects.toThrow("cleanup");
    t.offline(false); t.snapshot({ state: "idle", url, ownedSession: null, muted: null });
    await t.session.stop("reconnected-client"); expect(t.restores).toEqual([false, true]); expect(t.session.phase).toBe("idle");
  });
  it("restores an interrupted route on process restart after ownership is confirmed", async () => {
    const t = setup("previous-call"); expect(t.session.phase).toBe("needs-stop");
    t.snapshot({ state: "active", url, ownedSession: "previous-call", muted: false });
    await t.session.stop("new-client"); expect(t.calls).toContain("stop"); expect(t.restores).toEqual([true]);
    await t.session.start("new-client"); await t.session.stop(); expect(t.session.phase).toBe("idle");
  });
  it("validates PCM framing", async () => {
    const t = setup(); await t.session.start("phone"); t.session.setInput("phone", true);
    for (const bytes of [Buffer.alloc(1), Buffer.alloc(6402)]) expect(() => t.session.append("phone", bytes)).toThrow("PCM16");
    await t.session.stop();
  });
});

describe("Dots voice connection recovery", () => {
  it("restarts only audio while keeping call, ownership and route, then waits for fresh PTT", async () => {
    const t = setup(); await t.session.start("phone"); const id = t.session.sessionId;
    let complete!: () => void;
    t.audio.restart = vi.fn(async () => new Promise<void>(resolve => { complete = resolve; }));
    t.session.setInput("phone", true); t.session.audioFailed(captureError);
    expect(t.session.phase).toBe("active"); expect(t.session.inputEnabled).toBe(false); expect(t.session.status.recovery.audio).toBe(true);
    expect(() => t.session.setInput("phone", true)).toThrow("recovering"); expect(t.restores).toEqual([]); expect(t.calls).not.toContain("stop");
    complete(); await vi.waitFor(() => expect(t.session.status.recovery.audio).toBe(false));
    expect(t.session.status.recovery.audio).toBe(false); expect(t.session.status.recovery.deadline).toBeNull();
    expect(t.session.sessionId).toBe(id); expect(t.session.owner).toBe("phone"); expect(t.session.route).toBe("original"); expect(t.session.inputEnabled).toBe(false);
    expect(JSON.stringify(t.records)).not.toContain("private"); expect(t.events).toContainEqual(expect.objectContaining({ type: "audio.reset", reason: "audio-recovered" }));
    t.session.setInput("phone", true); await t.session.stop("phone");
  });
  it("retries a failed helper without delaying the normal call or issuing another start", async () => {
    vi.useFakeTimers(); const t = setup(); await t.session.start("phone");
    t.audio.restart = vi.fn().mockRejectedValueOnce(captureError).mockResolvedValue(undefined);
    t.session.audioFailed(captureError); await vi.advanceTimersByTimeAsync(999); expect(t.audio.restart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(t.audio.restart).toHaveBeenCalledTimes(2); expect(t.session.status.recovery.audio).toBe(false);
    await vi.advanceTimersByTimeAsync(60000); expect(t.session.phase).toBe("active"); expect(t.calls.filter(v => v === "start")).toHaveLength(1); await t.session.stop();
  });
  it("bounds repeated failure to three retries and hangs up only at the one-minute deadline", async () => {
    vi.useFakeTimers(); const t = setup(); await t.session.start("phone");
    t.audio.restart = vi.fn().mockRejectedValue(captureError); t.session.audioFailed(captureError);
    await vi.advanceTimersByTimeAsync(59_999); expect(t.audio.restart).toHaveBeenCalledTimes(3); expect(t.calls).not.toContain("stop"); expect(t.session.phase).toBe("active");
    await vi.advanceTimersByTimeAsync(1); expect(t.session.phase).toBe("idle"); expect(t.session.status.lastEnd?.reason).toBe("native-audio-recovery-timeout");
  });
  it("does not falsely report recovery when the replacement fails just after readiness", async () => {
    vi.useFakeTimers(); const t = setup(); await t.session.start("phone");
    t.audio.restart = vi.fn().mockImplementationOnce(async () => { t.session.audioFailed(captureError); }).mockResolvedValue(undefined);
    t.session.audioFailed(captureError); await vi.advanceTimersByTimeAsync(0);
    expect(t.session.status.recovery.audio).toBe(true); expect(t.records.some(v => v.event === "native-audio-recovered")).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); expect(t.audio.restart).toHaveBeenCalledTimes(2); expect(t.session.status.recovery.audio).toBe(false); await t.session.stop();
  });
  it("cancels pending recovery on user stop and never resumes a late helper", async () => {
    const t = setup(); await t.session.start("phone"); let aborted = false;
    t.audio.restart = vi.fn(async (_cb, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(captureError); }, { once: true })));
    t.session.audioFailed(captureError); await t.session.stop("phone");
    expect(aborted).toBe(true); expect(t.restores).toEqual([true]); expect(t.session.phase).toBe("idle"); expect(t.records.some(v => v.event === "native-audio-recovered")).toBe(false);
  });
  it("does not cancel audio recovery when a tentative Dots end proves still active", async () => {
    const t = setup(); await t.session.start("phone"); let complete!: () => void, signal!: AbortSignal;
    t.audio.restart = async (_cb, s) => { signal = s; return new Promise<void>(resolve => { complete = resolve; }); };
    t.session.audioFailed(captureError); await t.session.stop(undefined, "dots-ended");
    expect(signal.aborted).toBe(false); expect(t.session.phase).toBe("active"); expect(t.calls).not.toContain("stop");
    complete(); await Promise.resolve(); await Promise.resolve(); expect(t.session.status.recovery.audio).toBe(false); await t.session.stop();
  });
  it("does not count dropped native input or end the call on a bounded input queue", async () => {
    const t = setup(); await t.session.start("phone"); t.session.setInput("phone", true);
    t.audio.append = () => false; t.session.append("phone", Buffer.alloc(640)); expect(t.session.inputBytes).toBe(0); expect(t.session.inputEnabled).toBe(true); expect(t.calls).not.toContain("stop"); await t.session.stop();
  });
  it("rechecks a transient unknown state without hanging up a still-active call", async () => {
    vi.useFakeTimers(); const t = setup(); await t.session.start("phone");
    t.session.setInput("phone", true);
    t.session.browserChanged({ state: "unknown", url, ownedSession: t.session.sessionId!, muted: null });
    expect(t.session.phase).toBe("active"); expect(t.session.inputEnabled).toBe(false); expect(t.session.status.recovery.browser).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.session.status.recovery.browser).toBe(false); expect(t.calls).not.toContain("stop");
    expect(t.records.some(record => record.event === "browser-recovered")).toBe(true);
    await t.session.stop();
  });
  it("preserves the call through browser disconnection and does not restart PTT automatically", async () => {
    vi.useFakeTimers(); const t = setup(); await t.session.start("phone"); const id = t.session.sessionId;
    t.session.setInput("phone", true); t.offline(true); t.session.browserChanged(undefined, "browser-disconnected");
    await vi.advanceTimersByTimeAsync(30_000); expect(t.calls).not.toContain("stop"); expect(t.session.phase).toBe("active");
    t.offline(false); t.session.browserChanged({ state: "active", url, ownedSession: id!, muted: false });
    await vi.advanceTimersByTimeAsync(40_000); expect(t.session.sessionId).toBe(id); expect(t.session.inputEnabled).toBe(false); expect(t.session.phase).toBe("active");
    t.session.setInput("phone", true); await t.session.stop();
  });
  it("confirms a Dots-side end, but a racing return to active must not become a hangup", async () => {
    vi.useFakeTimers(); const t = setup(); await t.session.start("phone"); const id = t.session.sessionId!;
    const command = t.browser.command; let statuses = 0;
    t.browser.command = async (action, sessionId) => action === "status" && ++statuses === 1
      ? { state: "idle", url, ownedSession: id, muted: null } : command(action, sessionId);
    t.session.browserChanged({ state: "idle", url, ownedSession: id, muted: null });
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.session.phase).toBe("active"); expect(t.calls).not.toContain("stop"); expect(t.restores).toHaveLength(0);
    t.browser.command = command; t.snapshot({ state: "idle", url, ownedSession: id, muted: null });
    t.session.browserChanged({ state: "idle", url, ownedSession: id, muted: null });
    await vi.advanceTimersByTimeAsync(2000); expect(t.session.phase).toBe("idle"); expect(t.session.status.lastEnd?.reason).toBe("dots-ended");
  });
  it("keeps unknown observations from extending the one-minute recovery deadline", async () => {
    vi.useFakeTimers(); const t = setup(); await t.session.start("phone");
    t.snapshot({ state: "unknown", url, ownedSession: t.session.sessionId!, muted: null });
    t.session.browserChanged({ state: "unknown", url, ownedSession: t.session.sessionId!, muted: null });
    await vi.advanceTimersByTimeAsync(59_000); t.session.browserChanged({ state: "unknown", url, ownedSession: t.session.sessionId!, muted: null });
    expect(t.session.phase).toBe("active"); await vi.advanceTimersByTimeAsync(1000);
    expect(t.session.phase).toBe("idle"); expect(t.session.status.lastEnd?.reason).toBe("browser-recovery-timeout");
  });
  it("allows only the disconnected owner's identity to resume the same call", async () => {
    vi.useFakeTimers(); const t = setup(), key = "a".repeat(64); await t.session.start("old", key); const id = t.session.sessionId;
    t.session.setInput("old", true); t.session.clientDisconnected("unrelated"); expect(t.session.status.recovery.client).toBe(false);
    t.session.clientDisconnected("old"); expect(t.session.phase).toBe("active"); expect(t.session.inputEnabled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.session.resumeClient("other", "b".repeat(64))).toBe(false); expect(t.session.resumeClient("other")).toBe(false);
    expect(t.session.resumeClient("new", key)).toBe(true); expect(t.session.sessionId).toBe(id); expect(t.session.owner).toBe("new");
    expect(t.session.inputEnabled).toBe(false); expect(() => t.session.setInput("old", true)).toThrow("no active call");
    t.session.setInput("new", true); await vi.advanceTimersByTimeAsync(40_000); expect(t.session.phase).toBe("active");
    expect(t.calls.filter(action => action === "start")).toHaveLength(1); await t.session.stop("new");
    expect(JSON.stringify(t.records)).not.toContain(key);
  });
  it("ends only after a disconnected client fails to return for one minute", async () => {
    vi.useFakeTimers(); const t = setup(); await t.session.start("phone", "a".repeat(64));
    t.session.clientDisconnected("phone"); await vi.advanceTimersByTimeAsync(59_999); expect(t.calls).not.toContain("stop");
    await vi.advanceTimersByTimeAsync(1); expect(t.session.phase).toBe("idle"); expect(t.session.status.lastEnd?.reason).toBe("client-recovery-timeout");
  });
  it("pauses congested input while leaving the call active", async () => {
    const t = setup(); await t.session.start("phone"); t.session.setInput("phone", true); t.session.pauseInput("input-transfer-failed");
    expect(t.session.phase).toBe("active"); expect(t.session.inputEnabled).toBe(false); expect(t.calls).not.toContain("stop");
    t.session.append("phone", Buffer.alloc(640)); expect(t.session.inputBytes).toBe(0); await t.session.stop();
  });
});
