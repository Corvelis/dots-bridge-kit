import { afterEach, describe, expect, it, vi } from "vitest";
import { GlassesHud } from "../dots-phone-g2/src/hud";
import { DotsModel } from "../dots-phone-g2/src/model";
import { DotsGlasses, buildDotsPage, dotsTexts } from "../dots-phone-g2/src/glasses";
import { AutoOff } from "../dots-phone-g2/src/auto-off";
import { validateEvenHubPageContainerZOrder, type EvenAppBridge } from "@evenrealities/even_hub_sdk";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const time = (hours: number, minutes: number, seconds = 0) => new Date(2026, 9, 8, hours, minutes, seconds).getTime();
function display(model: DotsModel) {
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
  return { api, glasses: new DotsGlasses(api as unknown as EvenAppBridge), model };
}
describe("G2 clock and approximate battery", () => {
  it("uses the phone's local 24-hour time, changes once per minute and crosses midnight", () => {
    const hud = new GlassesHud(time(23, 59));
    expect(hud.text).toBe("23:59  --%");
    expect(hud.tick(time(23, 59, 59))).toBe(false);
    expect(hud.tick(time(24, 0))).toBe(true); expect(hud.text).toBe("00:00  --%");
    expect(hud.tick(time(24, 0, 30))).toBe(false);
  });
  it("keeps battery changes within a ten-percent bucket from causing transfers", () => {
    const hud = new GlassesHud(time(14, 35));
    expect(hud.observeBattery(78)).toBe(true); expect(hud.text).toBe("14:35  ~80%");
    expect(hud.observeBattery(76)).toBe(false); expect(hud.observeBattery(74)).toBe(true);
    expect(hud.batteryText).toBe("~70%"); expect(hud.observeBattery(100)).toBe(true); expect(hud.batteryText).toBe("~100%");
  });
  it("shows low battery without rounding a still-running device to zero", () => {
    const hud = new GlassesHud();
    hud.observeBattery(9); expect(hud.batteryText).toBe("<10%"); expect(hud.observeBattery(1)).toBe(false);
    hud.observeBattery(0); expect(hud.batteryText).toBe("0%");
  });
  it("ignores invalid and missing notifications without losing the last G2 value", () => {
    const hud = new GlassesHud();
    for (const value of [undefined, null, "80", NaN, Infinity, -1, 101]) { expect(hud.observeBattery(value)).toBe(false); expect(hud.batteryText).toBe("--%"); }
    hud.observeBattery(62); expect(hud.observeBattery(undefined)).toBe(false); expect(hud.batteryText).toBe("~60%");
  });
  it("fits the upper-right area beside call and text headings and preserves gesture capture", () => {
    const model = new DotsModel();
    for (const mode of ["phone", "text"] as const) {
      model.inputMode = mode; model.setActivity("waiting");
      const page = buildDotsPage(model), texts = dotsTexts(model);
      expect(page.containerTotalNum).toBe(7); expect(page.textObject).toHaveLength(5);
      expect(validateEvenHubPageContainerZOrder(page).valid).toBe(true);
      expect(page.textObject!.filter(v => v.isEventCapture === 1)).toHaveLength(1);
      const header = texts.find(v => v.name === "dotsHeader")!, hud = texts.find(v => v.name === "dotsHud")!;
      expect(header.x + header.w).toBeLessThanOrEqual(hud.x);
      expect(hud.x + hud.w).toBeLessThanOrEqual(576); expect(hud.y + hud.h).toBeLessThanOrEqual(52);
    }
  });
  it("updates only the HUD text at a minute boundary or battery bucket change, with no page/body rebuild", async () => {
    const { api, glasses, model } = display(new DotsModel()); model.hud.tick(time(14, 35)); model.hud.observeBattery(78);
    await glasses.initialize(model); expect(api.textContainerUpgrade).not.toHaveBeenCalled();
    model.hud.tick(time(14, 35, 59)); model.hud.observeBattery(76); await glasses.render(model);
    expect(api.textContainerUpgrade).not.toHaveBeenCalled();
    model.hud.tick(time(14, 36)); await glasses.render(model);
    expect(api.textContainerUpgrade).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ containerID: 27, containerName: "dotsHud", content: "14:36  ~80%" }));
    model.hud.observeBattery(74); await glasses.render(model); expect(api.textContainerUpgrade).toHaveBeenCalledTimes(2);
    expect(api.rebuildPageContainer).not.toHaveBeenCalled();
  });
  it("does not keep the display awake, send telemetry while blank or wake for a battery update", async () => {
    vi.useFakeTimers(); vi.setSystemTime(time(14, 35));
    const { api, glasses, model } = display(new DotsModel()), off = new AutoOff(30);
    await glasses.initialize(model);
    for (let second = 1; second <= 30; second++) {
      vi.setSystemTime(time(14, 35, second)); model.hud.tick(); model.hud.observeBattery(80 - second / 10);
      if (off.due(model.awake, false)) model.sleepDisplay();
      await glasses.render(model);
    }
    expect(model.awake).toBe(false);
    const updates = api.textContainerUpgrade.mock.calls.length, rebuilds = api.rebuildPageContainer.mock.calls.length;
    vi.setSystemTime(time(14, 40)); model.hud.observeBattery(60); await glasses.render(model);
    expect(model.awake).toBe(false); expect(api.textContainerUpgrade).toHaveBeenCalledTimes(updates); expect(api.rebuildPageContainer).toHaveBeenCalledTimes(rebuilds);
    model.wakeDisplay(); model.hud.tick(); await glasses.render(model);
    const page = api.rebuildPageContainer.mock.calls.at(-1)![0] as ReturnType<typeof buildDotsPage>;
    expect(page.textObject!.find(v => v.containerName === "dotsHud")!.content).toBe("14:40  ~60%");
  });
});
