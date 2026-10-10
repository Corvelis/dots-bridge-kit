import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSourceType, OsEventTypeList, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DotsControls } from "../dots-phone-g2/src/controls";
import { DotsModel } from "../dots-phone-g2/src/model";
import { DotsGlasses, dotsTexts } from "../dots-phone-g2/src/glasses";

const L = EventSourceType.TOUCH_EVENT_FROM_GLASSES_L, R = EventSourceType.TOUCH_EVENT_FROM_GLASSES_R, R1 = EventSourceType.TOUCH_EVENT_FROM_RING;
afterEach(() => vi.unstubAllGlobals());
function fixture(side: "left" | "right" = "right") {
  const model = new DotsModel(); model.callActive = true; model.screenSide = side;
  let now = 0, own = true, stopping = false;
  const actions = {
    awake: () => model.awake, ownedCall: () => own && model.callActive,
    canEndCall: () => own && (model.callActive || stopping),
    endCall: vi.fn(() => { stopping = true; model.callActive = false; }),
    screenSide: () => model.screenSide,
    doubleTap: vi.fn(() => model.toggleDisplay()), tap: vi.fn(), scroll: vi.fn(),
    switchMode: vi.fn(), discardAsr: vi.fn(), submitAsr: vi.fn(), hold: vi.fn(), release: vi.fn(),
  };
  const controls = new DotsControls(actions, () => now);
  const event = (type: OsEventTypeList, source?: EventSourceType) => controls.route({ sysEvent: { eventType: type, eventSource: source } });
  return { model, actions, controls, event, time: (value: number) => { now = value; }, otherOwner: () => { own = false; }, finished: () => { stopping = false; } };
}
describe("right temple call termination", () => {
  it.each(["right", "left"] as const)("ends the call from the physical right temple with the %s screen preference", side => {
    const { event, actions, model } = fixture(side); event(OsEventTypeList.DOUBLE_CLICK_EVENT, R);
    expect(actions.endCall).toHaveBeenCalledOnce(); expect(actions.doubleTap).not.toHaveBeenCalled();
    expect(model.awake).toBe(true); expect(model.inputMode).toBe("phone");
  });
  it("does not turn a click prefix, mirrored event or duplicate hangup into display-off", () => {
    const { event, actions, time } = fixture("left"); event(OsEventTypeList.CLICK_EVENT, R);
    time(80); event(OsEventTypeList.DOUBLE_CLICK_EVENT, R); event(OsEventTypeList.DOUBLE_CLICK_EVENT, L);
    time(200); event(OsEventTypeList.DOUBLE_CLICK_EVENT, R);
    expect(actions.endCall).toHaveBeenCalledOnce(); expect(actions.doubleTap).not.toHaveBeenCalled();
  });
  it("continues routing right doubles to the pending stop rather than display-off", () => {
    const { event, actions, time } = fixture(); event(OsEventTypeList.DOUBLE_CLICK_EVENT, R);
    time(1200); event(OsEventTypeList.DOUBLE_CLICK_EVENT, R);
    expect(actions.endCall).toHaveBeenCalledTimes(2); expect(actions.doubleTap).not.toHaveBeenCalled();
  });
  it("wakes a blank active call first, then ends it on the next deliberate right double", () => {
    const { event, actions, model, time } = fixture(); model.sleepDisplay();
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, R); expect(model.awake).toBe(true);
    expect(actions.doubleTap).toHaveBeenCalledOnce(); expect(actions.endCall).not.toHaveBeenCalled();
    time(1200); event(OsEventTypeList.DOUBLE_CLICK_EVENT, R); expect(actions.endCall).toHaveBeenCalledOnce();
  });
  it("preserves the swapped-side wake gesture before a physical-right hangup", () => {
    const { event, model, actions, time } = fixture("left"); model.sleepDisplay();
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, R); expect(model.awake).toBe(false); expect(actions.endCall).not.toHaveBeenCalled();
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, L); expect(model.awake).toBe(true);
    time(1200); event(OsEventTypeList.DOUBLE_CLICK_EVENT, R); expect(actions.endCall).toHaveBeenCalledOnce();
  });
  it("does not stop another client's call and keeps ring doubles as screen control", () => {
    const { event, actions, model, time, otherOwner } = fixture(); otherOwner();
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, R); expect(actions.endCall).not.toHaveBeenCalled(); expect(model.awake).toBe(false);
    time(1200); event(OsEventTypeList.DOUBLE_CLICK_EVENT, R1); expect(model.awake).toBe(true); expect(actions.endCall).not.toHaveBeenCalled();
  });
  it("keeps source-less G2 doubles and idle text doubles from ending calls", () => {
    const { event, actions, model, time } = fixture(); event(OsEventTypeList.DOUBLE_CLICK_EVENT);
    expect(actions.endCall).not.toHaveBeenCalled(); expect(model.awake).toBe(false);
    model.callActive = false; model.inputMode = "text"; model.wakeDisplay(); time(1200);
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, R); expect(model.awake).toBe(false); expect(actions.endCall).not.toHaveBeenCalled();
  });
  it("continues forwarding a held PTT release after termination is requested", () => {
    const { event, actions, time } = fixture(); event(OsEventTypeList.LONG_PRESS_EVENT, L);
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, R); time(100); event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, L);
    expect(actions.hold).toHaveBeenCalledWith("g2-left"); expect(actions.release).toHaveBeenCalledWith("g2-left"); expect(actions.endCall).toHaveBeenCalledOnce();
  });
});

describe("phone and ASR display isolation", () => {
  it.each(["phone", "text"] as const)("does not render old ASR during an active call with input mode %s", mode => {
    const model = new DotsModel(); model.inputMode = mode; model.callActive = true;
    model.transcript = "以前の音声認識結果"; model.pendingTranscript = true;
    model.textReply("reply", "Dotからの最新メッセージ"); model.phase = "listening"; model.setActivity("recording");
    expect(model.asrVisible).toBe(false); expect(model.asrCardVisible).toBe(false); expect(model.heading).not.toContain("ASR");
    expect(model.viewport.text).toContain("Dotからの最新メッセージ");
    expect(dotsTexts(model).map(item => item.content).join("\n")).not.toContain(model.transcript);
    expect(dotsTexts(model).find(item => item.name === "dotsFooter")!.content).toContain("PTT");
  });
  it("keeps the current ASR result and confirmation visible in text mode", () => {
    const model = new DotsModel(); model.inputMode = "text"; model.transcript = "これからDotに送る認識結果";
    model.pendingTranscript = true; model.setActivity("reviewing");
    expect(model.asrCardVisible).toBe(true); expect(model.asrVisible).toBe(true); expect(model.viewport.text).toContain(model.transcript);
    expect(model.heading).toContain("ASR確認"); expect(model.footer).toContain("[ASR]");
  });
  it("hides the completed ASR card so accepted input is reviewed in conversation history", () => {
    const model = new DotsModel(); model.inputMode = "text"; model.transcript = "送信済みの認識結果"; model.setActivity("ready");
    expect(model.asrCardVisible).toBe(false); expect(model.asrVisible).toBe(false);
    model.inputMode = "phone"; expect(model.asrCardVisible).toBe(false); expect(model.asrVisible).toBe(false);
  });
  it("keeps the native footer on call controls throughout PTT instead of replacing it with stale ASR", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
    const model = new DotsModel(); model.callActive = true; model.connected = true; model.transcript = "以前の認識結果";
    const display = new DotsGlasses(api as unknown as EvenAppBridge); await display.initialize(model);
    const initial = dotsTexts(model).find(item => item.name === "dotsFooter")!.content;
    model.phase = "listening"; model.setActivity("recording"); await display.render(model);
    expect(dotsTexts(model).find(item => item.name === "dotsFooter")!.content).toBe(initial);
    expect(dotsTexts(model).map(item => item.content).join("\n")).not.toContain(model.transcript);
    expect(api.rebuildPageContainer).not.toHaveBeenCalled();
  });
  it("shows termination state and the right-temple action in the phone footer", () => {
    const model = new DotsModel(); model.callActive = true; model.screenSide = "left"; model.setActivity("ending");
    expect(model.status.code).toBe("END"); expect(model.status.label).toBe("通話を終了中");
    expect(model.footer).toContain("右2タップ: 終了"); expect(model.controlsHint).toContain("G2右2タップで通話終了");
  });
});
