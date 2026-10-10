import { describe, expect, it, vi } from "vitest";
import { TranscriptReview } from "../bridge/src/transcript-review";
import { TextVoiceSession } from "../dots-phone-g2/src/text-voice";
import { DotsModel } from "../dots-phone-g2/src/model";
import type { ServerMessage } from "../shared/protocol";

describe("bridge ASR confirmation gate", () => {
  it("holds a draft until an exact turn is accepted once", () => {
    const gate = new TranscriptReview(); gate.begin(7, true);
    expect(gate.finish({ turnId: 7, text: " 認識結果 " })).toBe("review");
    expect(() => gate.take(6)).toThrow("No matching");
    expect(() => gate.take(NaN)).toThrow("No matching");
    expect(gate.take(7)).toEqual({ turnId: 7, text: "認識結果" });
    expect(() => gate.take(7)).toThrow("No matching");
  });
  it("drops a cancelled draft and a final ASR result arriving after cancellation", () => {
    const gate = new TranscriptReview(); gate.begin(1, true); gate.finish({ turnId: 1, text: "送らない" }); gate.clear();
    expect(() => gate.take(1)).toThrow(); expect(gate.finish({ turnId: 1, text: "遅い認識" })).toBe("stale");
    gate.begin(3, true); expect(gate.finish({ turnId: 1, text: "以前の認識" })).toBe("stale");
  });
  it("retains automatic submission and completes empty speech without a draft", () => {
    const gate = new TranscriptReview(); gate.begin(2, false);
    expect(gate.finish({ turnId: 2, text: "自動送信" })).toBe("submit"); expect(() => gate.take(2)).toThrow();
    gate.begin(3, true); expect(gate.finish({ turnId: 3, text: " \n " })).toBe("empty"); expect(() => gate.take(3)).toThrow();
  });
});

const snapshot = (supported = true, sessionId = "s1") => ({ type: "echo.snapshot", snapshot: {
  phase: "idle", sessionId, config: { dedicatedDots: true, dotsReady: true, asrReady: true, transcriptReview: supported },
} } as ServerMessage);
function setup(review = true, supported = true) {
  const port = { ready: true, send: vi.fn(() => true) };
  const model = new DotsModel(); model.inputMode = "text";
  const callbacks = { active: () => true, review: () => review, changed: vi.fn(), displayed: vi.fn(async () => {}), error: vi.fn(), disconnected: vi.fn() };
  const session = new TextVoiceSession(port, model, callbacks); session.handle(snapshot(supported));
  return { session, model, port, callbacks };
}
async function capture(session: TextVoiceSession) {
  const start = session.startInput(); session.handle({ type: "echo.state", phase: "listening", turnId: 1 }); await start;
  session.stopInput();
  session.handle({ type: "echo.transcript", turnId: 1, final: true, awaitingConfirmation: true, text: "散歩に行きたい" });
}
describe("G2 ASR result confirmation", () => {

  it.each([true, false])("lets submitted ASR browse history while Dot is pending (review=%s)", async review => {
    const { session, model, port } = setup(review);
    const oldText = "古いDotの長い返答です。".repeat(40);
    const rows = [
      { sourceId: "old", role: "assistant" as const, text: oldText },
      { sourceId: "input", role: "user" as const, text: "以前の入力" },
      { sourceId: "recent", role: "assistant" as const, text: "直前の返答" },
    ];
    const history = (revision: number) => ({ epoch: "conversation", revision, ready: true, gap: false,
      items: rows.map((row, i) => ({ ...row, id: `dom:${row.sourceId}`, sequence: 0, receivedAt: i + 1 })) });
    model.applyConversation(history(1));
    const start = session.startInput(); session.handle({ type: "echo.state", phase: "listening", turnId: 1 }); await start;
    session.stopInput(); session.handle({ type: "echo.transcript", turnId: 1, final: true, awaitingConfirmation: review, text: "新しい入力" });
    if (review) { expect(model.asrVisible).toBe(true); session.submitTranscript(); }
    else session.handle({ type: "echo.state", turnId: 1, phase: "thinking" });
    const sent = port.send.mock.calls.length;
    expect(session.busy).toBe(true); expect(model.activity).toBe("waiting");
    expect(model.asrVisible).toBe(false); expect(model.asrCardVisible).toBe(false);
    expect(model.viewport.text).toBe("直前の返答"); expect(model.footer).toContain("[DOT]");
    model.scroll(1); expect(model.viewport.text).toBe("以前の入力"); expect(model.canNewer).toBe(true);
    model.scroll(-1); expect(model.viewport.text).toBe("直前の返答");
    // Selecting a phone history entry and paging it must also work during the wait.
    model.select("dom:old"); const firstPage = model.offset; expect(firstPage).toBeGreaterThan(0);
    model.scroll(-1); expect(model.offset).toBe(firstPage - 1);
    rows.push({ sourceId: "new-input", role: "user", text: "新しい入力" });
    model.applyConversation(history(2));
    rows.push({ sourceId: "new-reply", role: "assistant", text: "新しい返答" });
    model.applyConversation(history(3));
    expect(model.activity).toBe("waiting");
    session.handle({ type: "echo.reply", turnId: 1, text: "新しい返答", final: true });
    expect(model.selectedId).toBe("dom:old"); expect(model.offset).toBe(firstPage - 1);
    expect(model.asrVisible).toBe(false); expect(session.busy).toBe(true);
    expect(model.transcript).toBe("新しい入力"); expect(model.pendingTranscript).toBe(false);
    expect(port.send).toHaveBeenCalledTimes(sent);
    model.latest(); expect(model.viewport.text).toBe("新しい返答");
    model.scroll(1); expect(model.viewport.text).toBe("新しい入力");
  });
  it("allows history navigation while waiting with the legacy history route", async () => {
    const { session, model } = setup();
    model.textReply("older", "古い返答", 1); model.textReply("recent", "直前の返答", 2);
    await capture(session); session.submitTranscript();
    model.scroll(1); expect(model.selectedId).toBe("older"); expect(model.viewport.text).toBe("古い返答");
    model.scroll(-1); expect(model.selectedId).toBe("recent"); expect(model.viewport.text).toBe("直前の返答");
    expect(session.busy).toBe(true); expect(model.activity).toBe("waiting");
  });
  it("displays without sending, survives snapshots and timeout, then submits once", async () => {
    const { session, model, port } = setup(); await capture(session);
    expect(port.send).toHaveBeenCalledWith({ type: "echo.voice.start", reviewTranscript: true });
    expect(model.pendingTranscript).toBe(true); expect(model.viewport.text).toContain("散歩に行きたい"); expect(model.activity).toBe("reviewing");
    const count = port.send.mock.calls.length; session.handle(snapshot()); session.tick(Date.now() + 600_000);
    expect(port.send).toHaveBeenCalledTimes(count); expect(session.busy).toBe(true); expect(model.activity).toBe("reviewing");
    session.submitTranscript(); session.submitTranscript();
    expect(port.send.mock.calls.filter(([v]) => v.type === "echo.transcript.submit")).toEqual([[{ type: "echo.transcript.submit", turnId: 1 }]]);
    expect(model.pendingTranscript).toBe(false); expect(model.activity).toBe("waiting");
    session.handle({ type: "echo.transcript", turnId: 1, final: true, awaitingConfirmation: true, text: "散歩に行きたい" });
    expect(model.pendingTranscript).toBe(false);
    session.handle({ type: "echo.reply", turnId: 1, text: "公園はどう？", final: true });
    session.handle({ type: "echo.state", turnId: 1, phase: "speaking" }); expect(model.asrVisible).toBe(false); expect(model.viewport.text).toContain("公園はどう？");
  });
  it("discards without submission and ignores late ASR or reply events", async () => {
    const { session, model, port } = setup(); await capture(session); session.discardTranscript();
    expect(port.send).toHaveBeenLastCalledWith({ type: "echo.cancel" }); expect(session.busy).toBe(false); expect(model.pendingTranscript).toBe(false); expect(model.transcript).toBe("");
    session.submitTranscript(); session.handle({ type: "echo.transcript", turnId: 1, final: true, awaitingConfirmation: true, text: "遅い結果" });
    session.handle({ type: "echo.reply", turnId: 1, text: "送信されてはいけない", final: true });
    expect(model.transcript).toBe(""); expect(model.history).toHaveLength(0);
    expect(port.send.mock.calls.some(([v]) => v.type === "echo.transcript.submit")).toBe(false);
  });
  it("refuses confirmation on older bridges and keeps automatic input compatible", async () => {
    const { session, port } = setup(true, false); await expect(session.startInput()).rejects.toThrow("更新が必要"); expect(port.send).not.toHaveBeenCalled();
    const automatic = setup(false, false); const start = automatic.session.startInput();
    automatic.session.handle({ type: "echo.state", turnId: 1, phase: "listening" }); await start;
    expect(automatic.port.send).toHaveBeenCalledWith({ type: "echo.voice.start" });
  });
  it("clears a pending decision on disconnect or server session replacement", async () => {
    const { session, model, port } = setup(); await capture(session); session.disconnected(); session.submitTranscript();
    expect(model.pendingTranscript).toBe(false); expect(session.reviewSupported).toBe(false);
    expect(port.send.mock.calls.some(([v]) => v.type === "echo.transcript.submit")).toBe(false);
    const other = setup(); await capture(other.session); other.session.handle(snapshot(true, "s2"));
    expect(other.model.pendingTranscript).toBe(false); expect(other.session.busy).toBe(false);
  });
  it("pages through a long ASR draft without moving Dot message history", async () => {
    const { session, model } = setup(); model.textReply("old", "過去のDot返信"); await capture(session);
    model.transcript = "認識した長い文章です。".repeat(40); model.scroll(1);
    expect(model.asrOffset).toBe(1); expect(model.heading).toContain("ASR"); expect(model.selectedId).toBe("old");
    session.discardTranscript(); expect(model.viewport.text).toContain("過去のDot返信"); expect(model.offset).toBe(0);
  });
});
