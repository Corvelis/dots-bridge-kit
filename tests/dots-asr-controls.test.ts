import { describe, expect, it, vi } from "vitest";
import { EventSourceType, MenuItemClickEvent, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { DotsControls } from "../dots-phone-g2/src/controls";
import { DotsModel } from "../dots-phone-g2/src/model";
import { DOTS_MENU_ITEM_ID } from "../dots-phone-g2/src/menu";

const L = EventSourceType.TOUCH_EVENT_FROM_GLASSES_L, R = EventSourceType.TOUCH_EVENT_FROM_GLASSES_R;
const R1 = EventSourceType.TOUCH_EVENT_FROM_RING;
const LONG = OsEventTypeList.LONG_PRESS_EVENT, RELEASE = OsEventTypeList.LONG_PRESS_RELEASE_EVENT;
const DOUBLE = OsEventTypeList.DOUBLE_CLICK_EVENT;
function setup() {
  const model = new DotsModel(); model.inputMode = "text"; model.pendingTranscript = true;
  let now = 0, owned = false;
  const actions = {
    awake: () => model.awake, ownedCall: () => owned, canEndCall: () => owned && model.callActive,
    reviewingAsr: () => model.textInputActive && model.pendingTranscript, screenSide: () => model.screenSide,
    submitAsr: vi.fn(() => { model.pendingTranscript = false; model.setActivity("waiting"); }),
    discardAsr: vi.fn(() => { model.pendingTranscript = false; model.setActivity("ready"); }),
    endCall: vi.fn(() => { owned = false; model.callActive = false; }),
    doubleTap: vi.fn(() => model.toggleDisplay()), switchMode: vi.fn(), toggleTts: vi.fn(),
    tap: vi.fn(), scroll: vi.fn(), hold: vi.fn(), release: vi.fn(),
  };
  const controls = new DotsControls(actions, () => now);
  return { model, actions, controls, time: (value: number) => { now = value; },
    call: () => { owned = true; model.callActive = true; },
    event: (type: OsEventTypeList, source?: EventSourceType) => controls.route({ sysEvent: { eventType: type, eventSource: source } }),
    menu: (id: number) => controls.route({ menuItemClickEvent: new MenuItemClickEvent({ itemID: id }) }),
  };
}

describe("ASR confirmation-only G2 and R1 shortcuts", () => {
  for (const screen of ["left", "right"] as const) for (const source of [L, R, R1]) {
    it(`submits once on input source ${source} with ${screen} screen control, without starting other actions`, () => {
      const f = setup(); f.model.screenSide = screen;
      f.event(LONG, source); f.time(200); f.event(LONG, source);
      for (const echo of [L, R, R1]) f.event(LONG, echo);
      expect(f.actions.submitAsr).toHaveBeenCalledOnce(); expect(f.model.pendingTranscript).toBe(false);
      expect(f.actions.hold).not.toHaveBeenCalled(); expect(f.actions.switchMode).not.toHaveBeenCalled();
      f.event(RELEASE, source); expect(f.actions.release).toHaveBeenCalled();
      f.time(300); f.event(LONG, source); expect(f.actions.hold).not.toHaveBeenCalled();
      f.time(1200); f.event(LONG, source);
      if (source !== R1 && (source === L ? "left" : "right") === screen) expect(f.actions.switchMode).toHaveBeenCalledOnce();
      else expect(f.actions.hold).toHaveBeenCalledOnce();
    });
    it(`discards once on input source ${source} with ${screen} screen control, without blanking the display`, () => {
      const f = setup(); f.model.screenSide = screen;
      f.event(DOUBLE, source); f.time(80); for (const echo of [L, R, R1]) f.event(DOUBLE, echo);
      expect(f.actions.discardAsr).toHaveBeenCalledOnce(); expect(f.actions.submitAsr).not.toHaveBeenCalled();
      expect(f.actions.doubleTap).not.toHaveBeenCalled(); expect(f.model.awake).toBe(true);
      f.time(1200); f.event(DOUBLE, screen === "left" ? L : R);
      expect(f.actions.doubleTap).toHaveBeenCalledOnce(); expect(f.model.awake).toBe(false);
    });
  }
  it.each([L, R1])("does not submit a draft from the recording press still held on source %s", source => {
    const f = setup(); f.model.pendingTranscript = false;
    f.event(LONG, source); f.model.pendingTranscript = true; f.time(60000); f.event(LONG, source);
    expect(f.actions.submitAsr).not.toHaveBeenCalled();
    f.event(RELEASE, source); f.time(61000); f.event(LONG, source);
    expect(f.actions.submitAsr).toHaveBeenCalledOnce();
  });
  it.each([L, R, R1])("preserves tap then hold for the menu on input source %s during confirmation", source => {
    const f = setup(); f.event(OsEventTypeList.CLICK_EVENT, source); f.time(500); f.event(LONG, source);
    expect(f.actions.submitAsr).not.toHaveBeenCalled(); expect(f.actions.switchMode).not.toHaveBeenCalled();
    expect(f.actions.hold).not.toHaveBeenCalled();
    f.menu(DOTS_MENU_ITEM_ID.submitAsr); expect(f.actions.submitAsr).toHaveBeenCalledOnce();
    f.time(2500); f.event(LONG, source);
    expect(f.actions.hold).not.toHaveBeenCalled(); expect(f.actions.switchMode).not.toHaveBeenCalled();
  });
  it("retains menu discard and normal-side ASR page scrolling", () => {
    const f = setup(); f.event(OsEventTypeList.SCROLL_BOTTOM_EVENT, L);
    expect(f.actions.scroll).toHaveBeenCalledWith(1); expect(f.model.pendingTranscript).toBe(true);
    f.menu(DOTS_MENU_ITEM_ID.discardAsr); expect(f.actions.discardAsr).toHaveBeenCalledOnce();
  });
  it("wakes a blank display first and ignores sleeping holds without a call", () => {
    const f = setup(); f.model.sleepDisplay(); f.event(LONG, L); f.event(LONG, R);
    expect(f.actions.submitAsr).not.toHaveBeenCalled(); expect(f.actions.hold).not.toHaveBeenCalled();
    f.event(DOUBLE, R); expect(f.model.awake).toBe(true); expect(f.model.pendingTranscript).toBe(true);
    expect(f.actions.discardAsr).not.toHaveBeenCalled();
  });
  it("keeps call PTT and physical-right call end when a stale draft exists", () => {
    const f = setup(); f.call(); f.event(LONG, L); f.event(RELEASE, L); f.event(DOUBLE, R);
    expect(f.actions.hold).toHaveBeenCalledWith("g2-left"); expect(f.actions.endCall).toHaveBeenCalledOnce();
    expect(f.actions.submitAsr).not.toHaveBeenCalled(); expect(f.actions.discardAsr).not.toHaveBeenCalled();
  });
  it("submits once on source-less R1 holds and forwards release for cleanup", () => {
    const f = setup(); f.event(LONG); f.time(200); f.event(LONG); f.event(LONG, R1);
    expect(f.actions.submitAsr).toHaveBeenCalledOnce(); expect(f.actions.hold).not.toHaveBeenCalled();
    f.event(RELEASE); expect(f.actions.release).toHaveBeenCalledWith("r1");
    f.time(1200); f.event(LONG); expect(f.actions.hold).toHaveBeenCalledWith("r1");
  });
  it.each(["textEvent", "listEvent"] as const)("discards source-less R1 doubles in %s without sleeping", envelope => {
    const f = setup(); f.controls.route({ [envelope]: { eventType: DOUBLE } });
    f.time(80); f.event(DOUBLE, R1); f.event(DOUBLE);
    expect(f.actions.discardAsr).toHaveBeenCalledOnce(); expect(f.actions.doubleTap).not.toHaveBeenCalled();
    expect(f.model.awake).toBe(true); expect(f.actions.submitAsr).not.toHaveBeenCalled();
  });
  it("keeps ordinary R1 PTT and display control when not confirming", () => {
    const f = setup(); f.model.pendingTranscript = false;
    f.event(LONG, R1); f.event(RELEASE, R1); f.event(DOUBLE, R1);
    expect(f.actions.hold).toHaveBeenCalledWith("r1"); expect(f.model.awake).toBe(false);
    f.time(1200); f.event(DOUBLE, R1); expect(f.model.awake).toBe(true);
    expect(f.actions.submitAsr).not.toHaveBeenCalled(); expect(f.actions.discardAsr).not.toHaveBeenCalled();
  });
  it("keeps R1 call PTT and sleeping wake when a stale ASR draft exists", () => {
    const f = setup(); f.call(); f.event(LONG, R1); f.event(RELEASE, R1); f.event(DOUBLE, R1);
    expect(f.actions.hold).toHaveBeenCalledWith("r1"); expect(f.model.awake).toBe(false);
    f.time(1200); f.event(DOUBLE, R1); expect(f.model.awake).toBe(true);
    expect(f.actions.submitAsr).not.toHaveBeenCalled(); expect(f.actions.discardAsr).not.toHaveBeenCalled();
  });
  it("restores ordinary text controls when there is no pending draft", () => {
    const f = setup(); f.model.pendingTranscript = false;
    f.event(LONG, L); f.event(LONG, R); f.event(DOUBLE, R);
    expect(f.actions.hold).toHaveBeenCalledWith("g2-left"); expect(f.actions.switchMode).toHaveBeenCalledOnce();
    expect(f.actions.doubleTap).toHaveBeenCalledOnce(); expect(f.actions.submitAsr).not.toHaveBeenCalled();
  });
  it("shows shortcuts only during confirmation and preserves all text processing stages", () => {
    const f = setup(); f.model.setActivity("reviewing");
    expect(f.model.controlsHint).toContain("G2左右 / R1: 長押しでDotに送信");
    expect(f.model.footer).toContain("READY > REC > [ASR] > DOT");
    expect(f.model.footer).toContain("2タップ:破棄");
    f.event(DOUBLE, L); expect(f.model.controlsHint).not.toContain("G2左右 / R1:");
    expect(f.model.footer).not.toContain("破棄"); expect(f.model.footer).toContain("[READY] > REC > ASR > DOT");
  });
});
