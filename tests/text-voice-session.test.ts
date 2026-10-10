import { afterEach, describe, expect, it, vi } from "vitest";
import { TextVoiceSession } from "../dots-phone-g2/src/text-voice";
import { DotsModel } from "../dots-phone-g2/src/model";
import { PhonePushToTalk } from "../dots-phone-g2/src/push-to-talk";
import type { ServerMessage } from "../shared/protocol";

afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const snapshot = (ready = true, sessionId = "s1"): ServerMessage => ({ type: "echo.snapshot", snapshot: {
  sessionId, phase: "idle", config: { dedicatedDots: true, dotsReady: ready, asrReady: true, transcriptReview: true },
} });
function setup() {
  const port = { ready: true, send: vi.fn(() => true) }, model = new DotsModel(); model.inputMode = "text";
  const callbacks = { active: () => true, changed: vi.fn(), displayed: vi.fn(async () => {}), error: vi.fn(), disconnected: vi.fn() };
  const session = new TextVoiceSession(port, model, callbacks); session.handle(snapshot());
  return { session, port, model, callbacks };
}
async function record(session: TextVoiceSession, turnId = 1) {
  const start = session.startInput(); session.handle({ type: "echo.state", turnId, phase: "listening" }); await start;
}
const reply = { type: "echo.reply", turnId: 1, text: "dotの返答", final: true } as const;

describe("G2 local ASR and text conversation", () => {
  it("starts capture only after acknowledgement, transcribes and completes a displayed reply", async () => {
    const { session, model, port } = setup(); const start = session.startInput(); expect(session.busy).toBe(true); expect(session.phase).toBe("idle");
    expect(port.send).toHaveBeenLastCalledWith({ type: "echo.voice.start" });
    session.handle({ type: "echo.state", turnId: 1, phase: "listening" }); await start;
    expect(model.activity).toBe("recording"); session.stopInput(); expect(model.activity).toBe("recognizing");
    expect(port.send).toHaveBeenLastCalledWith({ type: "echo.voice.stop" });
    session.handle({ type: "echo.transcript", turnId: 1, text: "こんにちは", final: true });
    session.handle({ type: "echo.state", turnId: 1, phase: "thinking" }); expect(model.activity).toBe("waiting");
    model.sleepDisplay(); session.handle(reply); session.handle(reply);
    expect(model.awake).toBe(true); expect(model.transcript).toBe("こんにちは"); expect(model.history).toHaveLength(1); expect(model.reply).toBe(reply.text);
    session.handle({ type: "echo.done", turnId: 1 }); expect(session.busy).toBe(false); expect(model.activity).toBe("ready");
    await record(session, 2);
  });
  it("acknowledges an incoming message only after display completes, and stores it once", async () => {
    const { session, model, port, callbacks } = setup(); let displayed!: () => void;
    callbacks.displayed.mockImplementationOnce(() => new Promise<void>(resolve => { displayed = resolve; }));
    const item = { notificationId: "dots:n1", turnId: 1, content: "おかえり", createdAt: 10 };
    model.sleepDisplay(); session.handle({ type: "echo.dots.incoming", ...item }); session.handle({ type: "echo.notification", ...item });
    expect(model.awake).toBe(true); expect(model.history).toHaveLength(1); expect(port.send).not.toHaveBeenCalled();
    displayed(); await flush(); expect(port.send).toHaveBeenCalledWith({ type: "echo.notification.displayed", turnId: 1, notificationId: "dots:n1" });
    session.handle({ type: "echo.done", turnId: 1 }); expect(session.busy).toBe(false);
  });
  it("retains incoming text during a call without changing the call's activity", async () => {
    const { session, callbacks, model, port } = setup(); callbacks.active = () => false; model.callActive = true; model.setActivity("playing"); model.phase = "speaking";
    session.handle({ type: "echo.notification", notificationId: "dots:n1", turnId: 1, content: "新着", createdAt: 1 });
    session.handle({ type: "echo.done", turnId: 1 }); await flush();
    expect(model.reply).toBe("新着"); expect(model.activity).toBe("playing"); expect(model.phase).toBe("speaking"); expect(session.busy).toBe(false);
    expect(port.send).toHaveBeenCalledWith({ type: "echo.notification.displayed", turnId: 1, notificationId: "dots:n1" });
  });
  it("does not acknowledge a notification display that finishes after cancellation", async () => {
    const { session, callbacks, port } = setup(); let display!: () => void;
    callbacks.displayed.mockImplementationOnce(() => new Promise<void>(resolve => { display = resolve; }));
    session.handle({ type: "echo.notification", notificationId: "dots:n1", turnId: 1, content: "新着", createdAt: 1 }); session.cancel(); display(); await flush();
    expect(port.send.mock.calls.some(([m]) => m.type === "echo.notification.displayed")).toBe(false);
  });
  it("ignores late acknowledgements and replies after a pending start is cancelled", async () => {
    const { session, port, model } = setup(); const start = session.startInput(); const rejected = expect(start).rejects.toThrow("取り消し"); session.cancel(); await rejected;
    session.handle({ type: "echo.state", turnId: 1, phase: "listening" }); session.handle(reply);
    expect(port.send).toHaveBeenLastCalledWith({ type: "echo.cancel" }); expect(model.history).toHaveLength(0); expect(session.busy).toBe(false);
  });
  it("closes a hold released before ASR readiness without opening the G2 microphone", async () => {
    const { session } = setup(), microphone = vi.fn(async () => {});
    const ptt = new PhonePushToTalk({ ensureCall: async () => {}, owned: () => true,
      setInput: async enabled => { if (enabled) await session.startInput(); else session.stopInput(); }, microphone, changed: vi.fn(), error: vi.fn() });
    ptt.hold("g2"); await flush(); const released = ptt.release("g2"); session.handle({ type: "echo.state", turnId: 1, phase: "listening" }); await released;
    expect(microphone).not.toHaveBeenCalledWith(true); expect(session.phase).toBe("transcribing");
  });
  it("preserves active turns and cancellation guards across readiness broadcasts", async () => {
    const { session, model, port } = setup(); await record(session, 5);
    session.handle(snapshot()); expect(session.phase).toBe("listening"); expect(session.busy).toBe(true);
    session.cancel(); session.handle(snapshot()); session.handle({ ...reply, turnId: 5 }); expect(model.history).toHaveLength(0);
    expect(port.send).toHaveBeenLastCalledWith({ type: "echo.cancel" });
  });
  it("cancels capture when Dot loses readiness", async () => {
    const { session, callbacks, port } = setup(); await record(session); session.handle(snapshot(false));
    expect(session.available).toBe(false); expect(session.busy).toBe(false); expect(callbacks.disconnected).toHaveBeenCalled();
    expect(port.send).toHaveBeenLastCalledWith({ type: "echo.cancel" });
  });
  it("rejects a disconnected start and accepts a newly authenticated session", async () => {
    const { session } = setup(); const start = session.startInput(); const rejected = expect(start).rejects.toThrow("接続が切れ"); session.disconnected(); await rejected;
    expect(session.available).toBe(false); session.handle(snapshot(true, "s2")); await record(session);
  });
  it("releases an empty recognition result so the next hold can start", async () => {
    const { session, model } = setup(); await record(session); session.stopInput();
    session.handle({ type: "echo.transcript", turnId: 1, text: "", final: true }); session.handle({ type: "echo.state", turnId: 1, phase: "idle", message: "NO SPEECH HEARD FROM G2" });
    expect(session.busy).toBe(false); expect(model.notice).toContain("認識できません"); await record(session, 2);
  });
  it("bounds a stalled start and a stalled Dot reply without accepting late text", async () => {
    vi.useFakeTimers(); const { session, model, callbacks } = setup(); const start = session.startInput(); const rejected = expect(start).rejects.toThrow("取り消し"); session.tick(Date.now() + 10_000); await rejected;
    expect(callbacks.error).toHaveBeenCalledOnce(); await record(session, 2); session.stopInput(); session.tick(Date.now() + 120_001);
    expect(session.busy).toBe(false); expect(model.activity).toBe("error"); session.handle({ ...reply, turnId: 2 }); expect(model.history).toHaveLength(0);
  });
  it("ignores delayed events from a preceding turn", async () => {
    const { session, model } = setup(); await record(session); session.handle({ type: "echo.done", turnId: 1 }); await record(session, 2);
    session.handle(reply); session.handle({ type: "echo.done", turnId: 1 }); expect(session.busy).toBe(true); expect(model.history).toHaveLength(0);
  });
});
