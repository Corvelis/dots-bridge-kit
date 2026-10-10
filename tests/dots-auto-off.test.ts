import { describe, expect, it } from "vitest";
import { AutoOff, autoOffSeconds } from "../dots-phone-g2/src/auto-off";
import { DotsModel } from "../dots-phone-g2/src/model";

describe("G2 automatic display off", () => {
  it("expires at the configured deadline and resets on genuine activity", () => {
    let now = 0; const off = new AutoOff(30, () => now);
    now = 29_999; expect(off.due(true, false)).toBe(false); off.touch();
    now = 59_998; expect(off.due(true, false)).toBe(false); now++; expect(off.due(true, false)).toBe(true);
  });
  it("waits a full timeout after recording, response, confirmation or overlay finishes", () => {
    let now = 0; const off = new AutoOff(15, () => now);
    now = 300_000; expect(off.due(true, true)).toBe(false);
    now += 14_999; expect(off.due(true, false)).toBe(false); now++; expect(off.due(true, false)).toBe(true);
  });
  it("can be disabled and changing the duration starts a new deadline", () => {
    let now = 0; const off = new AutoOff(0, () => now);
    now = 1_000_000; expect(off.due(true, false)).toBe(false); off.configure(120);
    now += 119_999; expect(off.due(true, false)).toBe(false); now++; expect(off.due(true, false)).toBe(true);
  });
  it("keeps the phone call active and starts a new timeout after Dot or double-tap wakes", () => {
    let now = 0; const off = new AutoOff(60, () => now), model = new DotsModel(); model.callActive = true;
    now = 60_000; if (off.due(model.awake, false)) model.sleepDisplay();
    expect(model.callActive).toBe(true); expect(model.awake).toBe(false); now += 60_000; expect(off.due(false, false)).toBe(false);
    model.incoming({ id: "new", sequence: 1, text: "おかえり", receivedAt: now }); off.touch();
    expect(model.awake).toBe(true); expect(off.due(true, false)).toBe(false);
    model.sleepDisplay(); model.toggleDisplay(); expect(model.awake).toBe(true); off.touch(); expect(model.callActive).toBe(true);
  });
  it("validates persisted values and retains the thirty-second default", () => {
    for (const value of [undefined, null, -1, 1, NaN, "15", Infinity]) expect(autoOffSeconds(value)).toBe(30);
    for (const value of [0, 15, 30, 60, 120, 300]) expect(autoOffSeconds(value)).toBe(value);
  });
});
