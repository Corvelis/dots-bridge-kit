import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageRawDataUpdateResult, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DOT_SIZE, EYES, FIXED_DOT_POSE, dotGlassesPose, dotGray4 } from "../dots-phone-g2/src/avatar";
import { DotsGlasses } from "../dots-phone-g2/src/glasses";
import { DotsModel } from "../dots-phone-g2/src/model";
import { DisplayWork } from "../dots-phone-g2/src/display-work";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true),
    textContainerUpgrade: vi.fn(async () => true),
    updateImageRawData: vi.fn(async (_image: { containerID?: number; imageData?: Uint8Array }) => ImageRawDataUpdateResult.success) };
  return { api, model: new DotsModel(), glasses: new DotsGlasses(api as unknown as EvenAppBridge) };
}
describe("optional character animation", () => {
  it.each(["phone", "text"] as const)("paints a fixed character once while %s states and text continue updating", async mode => {
    const { api, model, glasses } = setup(); model.inputMode = mode; model.connected = true;
    expect(model.animateCharacter).toBe(false); await glasses.initialize(model); await glasses.animate(model, 1, 1);
    for (let time = 2; time < 30; time++) {
      model.phase = time % 2 ? "speaking" : "thinking"; model.setActivity(time % 2 ? "playing" : "waiting");
      model.textReply("reply", `返答${time}`); await glasses.render(model); await glasses.animate(model, time, .9);
    }
    expect(api.updateImageRawData).toHaveBeenCalledTimes(2);
    expect(api.updateImageRawData.mock.calls[0]![0].imageData).toEqual(dotGray4(FIXED_DOT_POSE));
    expect(api.updateImageRawData.mock.calls[1]![0].imageData).toEqual(dotGray4(FIXED_DOT_POSE, EYES));
    expect(api.textContainerUpgrade.mock.calls.length).toBeGreaterThan(1);
    expect(api.rebuildPageContainer).not.toHaveBeenCalled();
    model.sleepDisplay(); await glasses.render(model); await glasses.animate(model, 30, 1);
    expect(api.updateImageRawData).toHaveBeenCalledTimes(2);
    model.wakeDisplay(); await glasses.render(model); await glasses.animate(model, 31, 1);
    expect(api.updateImageRawData).toHaveBeenCalledTimes(4);
  });
  it("resumes eye animation when enabled and restores the neutral face when disabled", async () => {
    const { api, model, glasses } = setup(); await glasses.initialize(model); await glasses.animate(model, 0, 0);
    model.animateCharacter = true; model.phase = "thinking"; await glasses.render(model); await glasses.animate(model, 2, 1);
    expect(api.updateImageRawData).toHaveBeenCalledTimes(3);
    expect(api.updateImageRawData.mock.calls.at(-1)![0].imageData).not.toEqual(dotGray4(FIXED_DOT_POSE, EYES));
    model.animateCharacter = false; await glasses.render(model); await glasses.animate(model, 3, 1);
    expect(api.updateImageRawData.mock.calls.at(-1)![0].imageData).toEqual(dotGray4(FIXED_DOT_POSE, EYES));
    const count = api.updateImageRawData.mock.calls.length;
    for (let time = 4; time < 20; time++) await glasses.animate(model, time, 1);
    expect(api.updateImageRawData).toHaveBeenCalledTimes(count);
    expect(api.updateImageRawData.mock.calls.filter(([image]) => image.containerID === 22)).toHaveLength(1);
  });
  it("discards an animated eye frame queued before the setting is disabled", async () => {
    const { api, model, glasses } = setup(); model.animateCharacter = true; model.phase = "thinking";
    await glasses.initialize(model);
    let release!: () => void;
    api.updateImageRawData.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return ImageRawDataUpdateResult.success; });
    const frame = glasses.animate(model, 2, 1);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    model.animateCharacter = false; const rendered = glasses.render(model); release(); await frame; await rendered;
    await glasses.animate(model, 3, 1);
    const eyeFrames = api.updateImageRawData.mock.calls.filter(([image]) => image.containerID === 23);
    expect(eyeFrames).toHaveLength(1); expect(eyeFrames[0]![0].imageData).toEqual(dotGray4(FIXED_DOT_POSE, EYES));
  });
  it("uses the same fixed pose for all states, times and audio levels", () => {
    for (const phase of ["idle", "listening", "transcribing", "thinking", "speaking", "error"] as const) {
      expect(dotGlassesPose(phase, 3.1, 1, false)).toBe(FIXED_DOT_POSE);
      expect(dotGlassesPose(phase, 99, 0, false)).toBe(FIXED_DOT_POSE);
    }
    expect(dotGray4(FIXED_DOT_POSE)).toHaveLength(DOT_SIZE * DOT_SIZE / 2);
  });
  it("stops foreground and background animation timers while keeping maintenance deadlines", () => {
    vi.useFakeTimers(); vi.setSystemTime(0); vi.stubGlobal("window", { setInterval, clearInterval });
    const callbacks = { maintenance: vi.fn(), foreground: vi.fn(), background: vi.fn() }, work = new DisplayWork(callbacks);
    work.update(true, true, false, false, false); work.start(); vi.advanceTimersByTime(2000);
    expect(callbacks.foreground).not.toHaveBeenCalled(); expect(callbacks.maintenance).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
    work.update(true, false, false, true, false); vi.advanceTimersByTime(1000);
    expect(callbacks.background).not.toHaveBeenCalled(); expect(callbacks.maintenance).toHaveBeenCalledTimes(6);
    work.update(true, true, false, false, true); vi.advanceTimersByTime(100);
    expect(callbacks.foreground).toHaveBeenCalledOnce();
    work.update(true, true, false, false, false); vi.advanceTimersByTime(1000);
    expect(callbacks.foreground).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1); work.dispose();
  });
});
