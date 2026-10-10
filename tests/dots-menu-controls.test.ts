import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSourceType, MenuItemClickEvent, OsEventTypeList, validateEvenHubPageContainer, type EvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DotsControls } from "../dots-phone-g2/src/controls";
import { DotsModel } from "../dots-phone-g2/src/model";
import { InputModeSwitch } from "../dots-phone-g2/src/input-mode";
import { buildDotsMenu, DOTS_MENU_ITEM_ID } from "../dots-phone-g2/src/menu";
import { buildDotsPage, buildDotsSleepPage, DotsGlasses } from "../dots-phone-g2/src/glasses";
import { OverlayLifecycle } from "../dots-phone-g2/src/lifecycle";

afterEach(() => vi.unstubAllGlobals());
const L = EventSourceType.TOUCH_EVENT_FROM_GLASSES_L, R = EventSourceType.TOUCH_EVENT_FROM_GLASSES_R, R1 = EventSourceType.TOUCH_EVENT_FROM_RING;
function controls() {
  let now = 0, owned = true;
  const model = new DotsModel(); model.callActive = true;
  const actions = { awake: () => model.awake, ownedCall: () => owned, canEndCall: () => owned && model.callActive, endCall: vi.fn(() => { model.callActive = false; }), doubleTap: vi.fn(() => model.toggleDisplay()), switchMode: vi.fn(), discardAsr: vi.fn(), submitAsr: vi.fn(), tap: vi.fn(), scroll: vi.fn(), hold: vi.fn(), release: vi.fn() };
  const router = new DotsControls(actions, () => now);
  return { model, actions, router, time: (value: number) => { now = value; }, disconnect: () => { owned = false; },
    event: (type: OsEventTypeList, source = R) => router.route({ sysEvent: { eventType: type, eventSource: source } }),
    menu: (id: number) => router.route({ menuItemClickEvent: new MenuItemClickEvent({ itemID: id }) }) };
}
describe("Dots G2 gesture and contextual-menu controls", () => {
  it("lets a CLICK prefix reach DOUBLE_CLICK once and coalesces mirrored duplicates", () => {
    const { event, actions, model, time } = controls();
    event(OsEventTypeList.CLICK_EVENT); time(80); event(OsEventTypeList.DOUBLE_CLICK_EVENT);
    expect(model.awake).toBe(true); event(OsEventTypeList.DOUBLE_CLICK_EVENT, L);
    expect(actions.endCall).toHaveBeenCalledOnce(); expect(actions.doubleTap).not.toHaveBeenCalled(); expect(model.callActive).toBe(false);
    time(1200); event(OsEventTypeList.DOUBLE_CLICK_EVENT); expect(model.awake).toBe(false);
  });
  it.each([L, R, R1])("reserves tap then hold on source %s for the OS menu", source => {
    const { event, actions, time } = controls();
    event(OsEventTypeList.CLICK_EVENT, source); time(600); event(OsEventTypeList.LONG_PRESS_EVENT, source);
    time(2400); event(OsEventTypeList.LONG_PRESS_EVENT, source);
    expect(actions.hold).not.toHaveBeenCalled(); expect(actions.switchMode).not.toHaveBeenCalled();
    event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, source); expect(actions.release).toHaveBeenCalled();
    time(3000); event(OsEventTypeList.LONG_PRESS_EVENT, source);
    if (source === R) expect(actions.switchMode).toHaveBeenCalledOnce(); else expect(actions.hold).toHaveBeenCalledOnce();
  });
  it("keeps a release's echo click from becoming a new menu prefix", () => {
    const { event, actions, time } = controls();
    event(OsEventTypeList.LONG_PRESS_EVENT, L); time(500); event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, L);
    time(550); event(OsEventTypeList.CLICK_EVENT, L); expect(actions.tap).not.toHaveBeenCalled();
    time(700); event(OsEventTypeList.LONG_PRESS_EVENT, L); expect(actions.hold).toHaveBeenCalledTimes(2);
  });
  it("runs explicit menu actions underneath the overlay without treating them as taps", () => {
    const { router, actions, menu } = controls();
    const lifecycle = new OverlayLifecycle({ overlay: vi.fn(), resume: vi.fn() }); lifecycle.handle(OsEventTypeList.FOREGROUND_ENTER_EVENT);
    expect(lifecycle.acceptsGesture).toBe(false);
    menu(DOTS_MENU_ITEM_ID.inputMode); menu(DOTS_MENU_ITEM_ID.discardAsr); menu(DOTS_MENU_ITEM_ID.submitAsr); menu(999);
    // Main dispatches this top-level event before the overlay gesture gate.
    router.route({ menuItemClickEvent: new MenuItemClickEvent({ itemID: 999 }), textEvent: {} });
    expect(actions.switchMode).toHaveBeenCalledOnce(); expect(actions.discardAsr).toHaveBeenCalledOnce(); expect(actions.submitAsr).toHaveBeenCalledOnce(); expect(actions.tap).not.toHaveBeenCalled();
  });
  it("rejects menu actions while blank but preserves owned-call PTT, including the right side", () => {
    const { model, menu, event, actions, disconnect } = controls(); model.sleepDisplay();
    for (const id of Object.values(DOTS_MENU_ITEM_ID)) menu(id);
    expect(actions.switchMode).not.toHaveBeenCalled(); expect(actions.discardAsr).not.toHaveBeenCalled(); expect(actions.submitAsr).not.toHaveBeenCalled();
    event(OsEventTypeList.LONG_PRESS_EVENT, R); expect(actions.hold).toHaveBeenCalledWith("g2-right");
    event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, R); disconnect(); event(OsEventTypeList.LONG_PRESS_EVENT, L);
    expect(actions.hold).toHaveBeenCalledOnce(); expect(model.awake).toBe(false);
  });
  it("validates native menu byte limits and labels, and clears app actions while blank", () => {
    const model = new DotsModel();
    for (const mode of ["phone", "text"] as const) for (const review of [true, false]) {
      model.inputMode = mode; model.pendingTranscript = review;
      const items = buildDotsMenu(model).menuItems!;
      expect(items[0]!.itemName).toBe(mode === "phone" ? "テキストDotへ" : "電話へ");
      expect(items).toHaveLength(review ? 3 : 1);
      expect(validateEvenHubPageContainer(buildDotsPage(model)).valid).toBe(true);
    }
    expect(buildDotsSleepPage().menuObject).toBeUndefined();
  });
  it("refreshes native menu labels only at settings/review changes, retains them after restore and wake", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
    const model = new DotsModel(), display = new DotsGlasses(api as unknown as EvenAppBridge);
    await display.initialize(model); await display.render(model); expect(api.rebuildPageContainer).not.toHaveBeenCalled();
    model.inputMode = "text"; await display.render(model); expect(api.rebuildPageContainer).toHaveBeenCalledTimes(1);
    model.setActivity("waiting"); model.hud.observeBattery(70); await display.render(model); expect(api.rebuildPageContainer).toHaveBeenCalledTimes(1);
    model.pendingTranscript = true; display.setOverlayVisible(true); await display.render(model); expect(api.rebuildPageContainer).toHaveBeenCalledTimes(1);
    display.setOverlayVisible(false); await display.render(model); expect(api.rebuildPageContainer).toHaveBeenCalledTimes(2);
    expect(api.rebuildPageContainer.mock.calls.at(-1)![0].menuObject!.menuItems!.map(item => item.itemName)).toEqual(["電話へ", "Dotに送信", "ASR結果を破棄"]);
    model.sleepDisplay(); await display.render(model); expect(api.rebuildPageContainer.mock.calls.at(-1)![0].menuObject).toBeUndefined();
    await display.render(model); expect(api.rebuildPageContainer).toHaveBeenCalledTimes(3);
    model.wakeDisplay(); await display.render(model); expect(api.rebuildPageContainer.mock.calls.at(-1)![0].menuObject!.menuItems![0]!.itemName).toBe("電話へ");
  });
});

function modeSwitch(phase = "idle", own = true) {
  let currentPhase = phase, starting = false;
  const model = new DotsModel(); model.callActive = phase === "active";
  const host = { phase: () => currentPhase, starting: () => starting, canStopCall: () => own,
    stopCall: vi.fn(async () => { currentPhase = "idle"; model.callActive = false; }), clearInputs: vi.fn(async () => {}), cancelText: vi.fn(), committed: vi.fn(), changed: vi.fn() };
  return { model, host, modes: new InputModeSwitch(model, host), phase: (value: string) => { currentPhase = value; }, starting: () => { starting = true; } };
}
describe("One mode switch transaction for right hold, menu and phone", () => {
  it("switches both ways, cancels text and closes the previous microphone before committing", async () => {
    const { model, host, modes } = modeSwitch();
    let finish!: () => void; host.clearInputs.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const changing = modes.set("text"); expect(modes.busy).toBe(true); expect(model.inputMode).toBe("phone"); expect(host.cancelText).toHaveBeenCalledOnce();
    await expect(modes.set("text")).rejects.toThrow("完了"); expect(host.clearInputs).toHaveBeenCalledOnce();
    finish(); await changing; expect(model.inputMode).toBe("text"); expect(modes.busy).toBe(false);
    await modes.set("phone"); expect(model.inputMode).toBe("phone"); expect(host.stopCall).not.toHaveBeenCalled(); expect(host.committed).toHaveBeenCalledTimes(2);
  });
  it.each(["active", "needs-stop"])("ends an owned %s call before selecting text", async phase => {
    const fixture = modeSwitch(phase);
    fixture.host.stopCall.mockImplementation(async () => { expect(fixture.model.inputMode).toBe("phone"); expect(fixture.host.clearInputs).toHaveBeenCalledOnce(); fixture.phase("idle"); fixture.model.callActive = false; });
    await fixture.modes.set("text"); expect(fixture.model.inputMode).toBe("text"); expect(fixture.model.callActive).toBe(false); expect(fixture.host.stopCall).toHaveBeenCalledOnce();
  });
  it.each(["starting", "stopping", "unknown"])("does not cancel inputs or stop a call in %s", async phase => {
    const { model, host, modes } = modeSwitch(phase);
    await expect(modes.set("text")).rejects.toThrow("完了"); expect(model.inputMode).toBe("phone"); expect(host.stopCall).not.toHaveBeenCalled(); expect(host.cancelText).not.toHaveBeenCalled();
  });
  it("never stops another client's call or races a pending start", async () => {
    const foreign = modeSwitch("active", false); expect(foreign.modes.canSet("text")).toBe(false);
    await expect(foreign.modes.set("text")).rejects.toThrow(); expect(foreign.host.stopCall).not.toHaveBeenCalled();
    const pending = modeSwitch(); pending.starting(); await expect(pending.modes.set("text")).rejects.toThrow(); expect(pending.host.cancelText).not.toHaveBeenCalled();
  });
  it("retains phone mode after a failed or unconfirmed call end and can retry", async () => {
    const { model, host, modes, phase } = modeSwitch("active"); host.stopCall.mockRejectedValueOnce(new Error("接続切れ"));
    await expect(modes.set("text")).rejects.toThrow("接続切れ"); expect(model.inputMode).toBe("phone"); expect(modes.busy).toBe(false);
    host.stopCall.mockImplementationOnce(async () => {}); await expect(modes.set("text")).rejects.toThrow("終了を確認"); expect(model.inputMode).toBe("phone");
    phase("idle"); await modes.set("text"); expect(model.inputMode).toBe("text");
  });
});
