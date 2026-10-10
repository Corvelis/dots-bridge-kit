import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayWork } from "../dots-phone-g2/src/display-work";
import { PhonePushToTalk } from "../dots-phone-g2/src/push-to-talk";
import { DotsModel } from "../dots-phone-g2/src/model";

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.stubGlobal("window", { setInterval, clearInterval });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  const callbacks = { maintenance: vi.fn(), foreground: vi.fn(), background: vi.fn() };
  const work = new DisplayWork(callbacks); work.start();
  return { callbacks, work };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("Dots Phone G2 display power", () => {
  it("cancels visual work while asleep and retains only a five-second idle timer", () => {
    const { callbacks, work } = setup(); vi.advanceTimersByTime(1000);
    expect(callbacks.foreground).toHaveBeenCalledTimes(10);
    callbacks.foreground.mockClear(); callbacks.maintenance.mockClear();
    work.update(false, true, false); vi.advanceTimersByTime(10_000);
    expect(callbacks.foreground).not.toHaveBeenCalled(); expect(callbacks.background).not.toHaveBeenCalled();
    expect(callbacks.maintenance).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
  });
  it("keeps a lit G2 at 500ms while the phone is hidden and restores one visual timer on return", () => {
    const { callbacks, work } = setup(); work.update(true, false, false); vi.advanceTimersByTime(2000);
    expect(callbacks.foreground).not.toHaveBeenCalled(); expect(callbacks.background).toHaveBeenCalledTimes(4);
    work.update(true, true, false); for (let i = 0; i < 50; i++) work.update(true, true, false);
    vi.advanceTimersByTime(1000); expect(callbacks.foreground).toHaveBeenCalledTimes(10);
    expect(callbacks.background).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(2);
  });
  it("does not let continuous silent PCM accelerate idle maintenance", () => {
    const { callbacks, work } = setup(); work.update(false, true, false);
    for (let ms = 0; ms < 10_000; ms += 40) { vi.advanceTimersByTime(40); work.check(); }
    expect(callbacks.maintenance.mock.calls.length).toBeLessThanOrEqual(3);
    expect(callbacks.maintenance.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(callbacks.foreground).not.toHaveBeenCalled();
  });
  it("checks overdue deadlines on a native event even if OS timers did not run", () => {
    const { callbacks, work } = setup(); work.update(false, false, false); work.check();
    vi.setSystemTime(65_000); work.check();
    expect(callbacks.maintenance).toHaveBeenLastCalledWith(65_000);
    for (let i = 0; i < 25; i++) work.check();
    expect(callbacks.maintenance).toHaveBeenCalledTimes(2);
  });
  it("preserves held PTT with all displays asleep and closes its mic at 60 seconds", async () => {
    const route = { ensureCall: vi.fn(async () => {}), owned: () => true, setInput: vi.fn(async () => {}), microphone: vi.fn(async () => {}), changed: vi.fn(), error: vi.fn() };
    const ptt = new PhonePushToTalk(route);
    const foreground = vi.fn(), background = vi.fn();
    const work = new DisplayWork({ maintenance: now => ptt.tick(now), foreground, background });
    work.update(false, false, false, true); work.start(); ptt.hold("g2-left"); await flush();
    await vi.advanceTimersByTimeAsync(59_999); expect(ptt.recording).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect(ptt.recording).toBe(false);
    expect(route.microphone.mock.calls).toEqual([[true], [false]]);
    expect(foreground).not.toHaveBeenCalled(); expect(background).not.toHaveBeenCalled();
  });
  it("restarts visuals on a new Dot message and double-tap wake without touching a call", () => {
    const model = new DotsModel(), { callbacks, work } = setup();
    model.sleepDisplay(); work.update(model.awake, true, false); vi.advanceTimersByTime(1000);
    expect(callbacks.foreground).not.toHaveBeenCalled();
    model.incoming({ id: "new", sequence: 1, text: "おかえり", receivedAt: 1 });
    work.update(model.awake, true, false); vi.advanceTimersByTime(100);
    expect(callbacks.foreground).toHaveBeenCalledOnce();
    model.callActive = true; model.sleepDisplay(); work.update(model.awake, true, false);
    model.toggleDisplay(); expect(model.awake).toBe(true); work.update(model.awake, true, false);
    vi.advanceTimersByTime(100); expect(callbacks.foreground).toHaveBeenCalledTimes(2); expect(model.callActive).toBe(true);
  });
  it("pauses both visual paths for an OS overlay while maintenance continues", () => {
    const { callbacks, work } = setup(); work.update(true, true, true); vi.advanceTimersByTime(1000);
    work.update(true, false, true); vi.advanceTimersByTime(1000);
    expect(callbacks.foreground).not.toHaveBeenCalled(); expect(callbacks.background).not.toHaveBeenCalled();
    expect(callbacks.maintenance).toHaveBeenCalledTimes(4);
    work.update(true, false, false); vi.advanceTimersByTime(500); expect(callbacks.background).toHaveBeenCalledOnce();
  });
  it("releases all timers on exit and cannot restart after disposal", () => {
    const { callbacks, work } = setup(); work.dispose(); work.start(); work.update(true, true, false); work.check(true);
    vi.advanceTimersByTime(1000); expect(vi.getTimerCount()).toBe(0);
    expect(callbacks.foreground).not.toHaveBeenCalled(); expect(callbacks.maintenance).not.toHaveBeenCalled();
  });
  it("changes history revision only for a new message or edited text, not state or selection", () => {
    const model = new DotsModel(), item = { id: "one", sequence: 1, text: "おかえり", receivedAt: 1 };
    model.incoming(item); expect(model.historyRevision).toBe(1);
    model.setActivity("recording"); model.sleepDisplay(); model.select("one"); model.incoming(item);
    expect(model.historyRevision).toBe(1);
    model.incoming({ ...item, text: "おかえり。" }); expect(model.historyRevision).toBe(2);
    model.incoming({ ...item, id: "two", sequence: 2 }); expect(model.historyRevision).toBe(3);
  });
});
