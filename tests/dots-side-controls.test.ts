import { describe, expect, it, vi } from "vitest";
import { EventSourceType, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { DotsControls } from "../dots-phone-g2/src/controls";
import { DotsModel } from "../dots-phone-g2/src/model";

const L = EventSourceType.TOUCH_EVENT_FROM_GLASSES_L, R = EventSourceType.TOUCH_EVENT_FROM_GLASSES_R, R1 = EventSourceType.TOUCH_EVENT_FROM_RING;
function setup() {
  const model = new DotsModel(); let now = 0, owned = true;
  const actions = { screenSide: () => model.screenSide, awake: () => model.awake, ownedCall: () => owned, canEndCall: () => owned && model.callActive, endCall: vi.fn(() => { model.callActive = false; }),
    doubleTap: vi.fn(() => model.toggleDisplay()), switchMode: vi.fn(), toggleTts: vi.fn(), discardAsr: vi.fn(), submitAsr: vi.fn(),
    tap: vi.fn(), scroll: vi.fn(), hold: vi.fn(), release: vi.fn() };
  const controls = new DotsControls(actions, () => now);
  return { model, actions, controls, time: (value: number) => { now = value; }, disconnect: () => { owned = false; },
    event: (type: OsEventTypeList, source: EventSourceType) => controls.route({ sysEvent: { eventType: type, eventSource: source } }) };
}
describe("configurable G2 temple roles", () => {
  it.each(["right", "left"] as const)("uses %s for screen control and the opposite side for normal input", side => {
    const { model, actions, event, time } = setup(); model.screenSide = side;
    const screen = side === "right" ? R : L, normal = side === "right" ? L : R;
    event(OsEventTypeList.CLICK_EVENT, screen); expect(actions.tap).not.toHaveBeenCalled();
    event(OsEventTypeList.CLICK_EVENT, normal); expect(actions.tap).toHaveBeenCalledOnce();
    time(2000); event(OsEventTypeList.LONG_PRESS_EVENT, screen); expect(actions.switchMode).toHaveBeenCalledOnce();
    event(OsEventTypeList.LONG_PRESS_EVENT, normal); expect(actions.hold).toHaveBeenCalledWith(`g2-${model.normalSide}`);
    event(OsEventTypeList.SCROLL_TOP_EVENT, screen); event(OsEventTypeList.SCROLL_BOTTOM_EVENT, screen);
    expect(actions.scroll).not.toHaveBeenCalled();
    event(OsEventTypeList.SCROLL_TOP_EVENT, normal); event(OsEventTypeList.SCROLL_BOTTOM_EVENT, normal);
    expect(actions.scroll.mock.calls).toEqual([[-1], [1]]);
  });
  it.each(["right", "left"] as const)("accepts only %s double taps for sleep and wake", side => {
    const { model, actions, event, time } = setup(); model.screenSide = side;
    const screen = side === "right" ? R : L, normal = side === "right" ? L : R;
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, normal); expect(model.awake).toBe(true);
    time(80); event(OsEventTypeList.DOUBLE_CLICK_EVENT, screen); expect(model.awake).toBe(false);
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, screen); expect(actions.doubleTap).toHaveBeenCalledOnce();
    time(1200); event(OsEventTypeList.DOUBLE_CLICK_EVENT, normal); expect(model.awake).toBe(false);
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, screen); expect(model.awake).toBe(true);
  });
  it("does not change a held mode-switch press into PTT when its preference changes", () => {
    const { model, actions, event, time } = setup(); event(OsEventTypeList.LONG_PRESS_EVENT, R);
    model.screenSide = "left"; time(500); event(OsEventTypeList.LONG_PRESS_EVENT, R); model.sleepDisplay(); event(OsEventTypeList.LONG_PRESS_EVENT, R);
    expect(actions.switchMode).toHaveBeenCalledOnce(); expect(actions.hold).not.toHaveBeenCalled();
    event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, R); expect(actions.release).toHaveBeenCalledWith("g2-right");
    model.wakeDisplay(); time(1000); event(OsEventTypeList.LONG_PRESS_EVENT, R); expect(actions.hold).toHaveBeenCalledWith("g2-right");
  });
  it.each([L, R])("reserves tap then hold on swapped source %s for the native menu", source => {
    const { model, event, time, actions } = setup(); model.screenSide = "left";
    event(OsEventTypeList.CLICK_EVENT, source); time(500); event(OsEventTypeList.LONG_PRESS_EVENT, source);
    expect(actions.switchMode).not.toHaveBeenCalled(); expect(actions.hold).not.toHaveBeenCalled();
    event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, source); expect(actions.release).toHaveBeenCalled();
  });
  it("preserves both-side PTT on an owned call while blank and rejects other normal controls", () => {
    const { model, actions, event, disconnect, time } = setup(); model.screenSide = "left"; model.sleepDisplay();
    event(OsEventTypeList.LONG_PRESS_EVENT, L); event(OsEventTypeList.LONG_PRESS_EVENT, R);
    expect(actions.hold.mock.calls).toEqual([["g2-left"], ["g2-right"]]); expect(actions.switchMode).not.toHaveBeenCalled();
    event(OsEventTypeList.CLICK_EVENT, R); event(OsEventTypeList.SCROLL_TOP_EVENT, R); expect(actions.tap).not.toHaveBeenCalled(); expect(actions.scroll).not.toHaveBeenCalled();
    event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, L); event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, R); disconnect(); time(2000);
    event(OsEventTypeList.LONG_PRESS_EVENT, L); event(OsEventTypeList.LONG_PRESS_EVENT, R); expect(actions.hold).toHaveBeenCalledTimes(2);
  });
  it("keeps ring controls independent of the G2 side preference", () => {
    const { model, actions, event, time } = setup(); model.screenSide = "left";
    event(OsEventTypeList.CLICK_EVENT, R1); expect(actions.tap).toHaveBeenCalledOnce();
    time(2000); event(OsEventTypeList.LONG_PRESS_EVENT, R1); expect(actions.hold).toHaveBeenCalledWith("r1");
    event(OsEventTypeList.SCROLL_TOP_EVENT, R1); expect(actions.scroll).toHaveBeenCalledWith(-1);
    event(OsEventTypeList.DOUBLE_CLICK_EVENT, R1); expect(model.awake).toBe(false);
  });
  it("updates the phone and glasses hints to match the chosen sides", () => {
    const { model } = setup(); expect(model.screenSide).toBe("right"); expect(model.normalSide).toBe("left");
    model.screenSide = "left"; expect(model.controlsHint).toContain("G2右 / R1長押しで話す"); expect(model.controlsHint).toContain("G2左2タップで消灯");
    expect(model.status.detail).toContain("右/R1長押しで話す"); expect(model.footer).toContain("右/R1");
    model.sleepDisplay(); expect(model.status.detail).toContain("左2タップで点灯");
  });
});
