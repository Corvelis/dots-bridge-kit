import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayWork } from "../dots-phone-g2/src/display-work";
import { PhonePushToTalk } from "../dots-phone-g2/src/push-to-talk";
import { OwnedMicrophone } from "../dots-phone-g2/src/microphone";
import { IdleAudioGuard } from "../dots-phone-g2/src/idle-audio";
import { DeviceConnectionLifecycle } from "../dots-phone-g2/src/device-lifecycle";
import { PowerDiagnostics } from "../dots-phone-g2/src/power-diagnostics";
import { PhoneSocket } from "../dots-phone-g2/src/socket";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); vi.stubGlobal("window", { setInterval, clearInterval }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Sleeping G2 runtime", () => {
  it("returns to fast deadlines immediately for a hold after prolonged idle, retaining the 60-second limit", async () => {
    let busy = false;
    const mic = vi.fn(async () => {}), foreground = vi.fn(), background = vi.fn();
    const ptt = new PhonePushToTalk({ ensureCall: async () => {}, owned: () => true, setInput: async () => {}, microphone: mic,
      changed: open => { busy = open; work.update(false, false, false, busy); },
      preparing: pending => { work.update(false, false, false, pending || busy); }, error: vi.fn(),
    });
    const work = new DisplayWork({ maintenance: now => ptt.tick(now), foreground, background });
    work.update(false, false, false); work.start();
    await vi.advanceTimersByTimeAsync(57_000);
    ptt.hold("g2-left"); await flush();
    expect(work.maintenanceIntervalMs).toBe(500); expect(ptt.recording).toBe(true);
    await vi.advanceTimersByTimeAsync(59_999); expect(ptt.recording).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect(ptt.recording).toBe(false);
    expect(mic.mock.calls).toEqual([[true], [false]]);
    expect(work.maintenanceIntervalMs).toBe(5000);
    expect(foreground).not.toHaveBeenCalled(); expect(background).not.toHaveBeenCalled();
  });
  it("wakes and performs visual work on the next frame without waiting for the idle timer", () => {
    const foreground = vi.fn(), work = new DisplayWork({ maintenance: vi.fn(), foreground, background: vi.fn() });
    work.update(false, false, false); work.start(); vi.advanceTimersByTime(1100);
    work.update(true, true, false); vi.advanceTimersByTime(99); expect(foreground).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(foreground).toHaveBeenCalledOnce(); expect(work.maintenanceIntervalMs).toBe(500);
  });
  it("keeps response/recovery watchdogs fast while blank and creates no extra timers through repeated updates", () => {
    const maintenance = vi.fn(), work = new DisplayWork({ maintenance, foreground: vi.fn(), background: vi.fn() });
    work.update(false, false, false, true); work.start();
    for (let i = 0; i < 100; i++) work.update(false, false, false, true);
    vi.advanceTimersByTime(2000); expect(maintenance).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(1);
    work.update(false, false, false); vi.advanceTimersByTime(5000); expect(maintenance).toHaveBeenCalledTimes(5);
    work.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it("requests fast maintenance for authentication, reconnect and outstanding RPC deadlines", async () => {
    const socket = { readyState: 1, bufferedAmount: 0, binaryType: "", send: vi.fn(), close: vi.fn(), onopen: null as any, onmessage: null as any };
    const client = new PhoneSocket("ws://localhost", { type: "voice.hello" }, { message: vi.fn(), closed: vi.fn() }, () => socket as any);
    expect(client.needsFastMaintenance).toBe(true); client.connect(); socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: "voice.ready", version: 1 }) }); expect(client.needsFastMaintenance).toBe(false);
    const result = client.request("status", {}, 1000); expect(client.needsFastMaintenance).toBe(true);
    socket.onmessage({ data: JSON.stringify({ id: "1", result: { phase: "active" } }) }); await result;
    expect(client.needsFastMaintenance).toBe(false); client.dispose();
  });
  it("does not spin when Even Hub visits newly inserted timers in the same native tick", () => {
    const timers = new Map<number, () => void>(); let id = 0;
    vi.stubGlobal("window", { setInterval: (callback: () => void) => { timers.set(++id, callback); return id; }, clearInterval: (value: number) => timers.delete(value) });
    const maintenance = vi.fn(() => work.update(false, false, false, true));
    const work = new DisplayWork({ maintenance, foreground: vi.fn(), background: vi.fn() });
    work.update(false, false, false); work.start(); vi.setSystemTime(5000);
    let visits = 0;
    for (const callback of timers.values()) { if (++visits > 5) throw new Error("native timer loop"); callback(); }
    expect(visits).toBe(2); expect(maintenance).toHaveBeenCalledOnce(); expect(timers.size).toBe(1);
    work.dispose(); expect(timers.size).toBe(0);
  });
});

describe("Unowned native microphone repair", () => {
  function setup() {
    let idle = true;
    const callbacks = { idle: () => idle, close: vi.fn(async () => true), corrected: vi.fn(), error: vi.fn() };
    return { callbacks, guard: new IdleAudioGuard(callbacks), setIdle: (value: boolean) => { idle = value; } };
  }
  function feed(guard: IdleAudioGuard, from: number, through: number) { for (let now = from; now <= through; now += 40) guard.feed(now); }
  it("ignores late buffered PCM and separated isolated packets", async () => {
    const { guard, callbacks } = setup(); feed(guard, 0, 400); guard.feed(5000); guard.feed(10_000); await flush();
    expect(callbacks.close).not.toHaveBeenCalled();
  });
  it("closes a continuously streaming unowned mic once, without adding a timer", async () => {
    const { guard, callbacks } = setup(); feed(guard, 0, 3000); await flush();
    expect(callbacks.close).toHaveBeenCalledOnce(); expect(callbacks.corrected).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("never repairs a held or pending PTT or OS overlay", async () => {
    const { guard, callbacks, setIdle } = setup(); setIdle(false); feed(guard, 0, 60_000); await flush();
    expect(callbacks.close).not.toHaveBeenCalled(); setIdle(true); feed(guard, 60_040, 61_000); await flush();
    expect(callbacks.close).not.toHaveBeenCalled();
  });
  it("bounds repeated native failures rather than sending a close for every PCM event", async () => {
    const { guard, callbacks } = setup(); callbacks.close.mockRejectedValue(new Error("native unavailable"));
    for (let from = 0; from <= 30_000; from += 2000) { feed(guard, from, from + 1960); await flush(); }
    expect(callbacks.close).toHaveBeenCalledTimes(2); expect(callbacks.error).toHaveBeenCalledTimes(2);
  });
  it("does not close a PTT which begins after the idle repair has been queued", async () => {
    const control = vi.fn(async () => {}), microphone = new OwnedMicrophone(control);
    let pendingPtt = false;
    const repairing = microphone.closeIfIdle("phone", () => !pendingPtt);
    pendingPtt = true; const opening = microphone.set(true, "phone");
    expect(await repairing).toBe(false); await opening;
    expect(control.mock.calls).toEqual([[true, "phone"]]); expect(microphone.activeRoute).toBe("phone");
  });
  it("can retry an idle failed close while preserving the remembered native route", async () => {
    const control = vi.fn(async () => {}), microphone = new OwnedMicrophone(control);
    await microphone.set(true, "phone"); control.mockRejectedValueOnce(new Error("close failed"));
    await expect(microphone.set(false, "phone")).rejects.toThrow("close failed");
    expect(microphone.activeRoute).toBe("phone");
    expect(await microphone.closeIfIdle("text", () => true)).toBe(true);
    expect(control).toHaveBeenLastCalledWith(false, "phone"); expect(microphone.activeRoute).toBeUndefined();
  });
});

describe("Passive device power updates", () => {
  const connected = (extra = {}) => ({ isConnected: () => true, isDisconnected: () => false, ...extra });
  it("does not probe or restore audio on every connected battery/wear update", () => {
    const callbacks = { lost: vi.fn(), resume: vi.fn() }, lifecycle = new DeviceConnectionLifecycle(callbacks);
    lifecycle.handle(connected());
    for (let level = 100; level >= 0; level--) lifecycle.handle(connected({ batteryLevel: level, isWearing: level % 2 === 0 }));
    expect(callbacks.resume.mock.calls).toEqual([[false]]); expect(callbacks.lost).not.toHaveBeenCalled();
  });
  it("clears input once on a lost connection and rebuilds once on reconnection", () => {
    const callbacks = { lost: vi.fn(), resume: vi.fn() }, lifecycle = new DeviceConnectionLifecycle(callbacks);
    lifecycle.handle(connected());
    for (let i = 0; i < 10; i++) lifecycle.handle({ isConnected: () => false, isDisconnected: () => true });
    lifecycle.handle(connected()); lifecycle.handle(connected());
    expect(callbacks.lost).toHaveBeenCalledOnce(); expect(callbacks.resume.mock.calls).toEqual([[false], [true]]);
  });
  it("treats leaving the case as reconnection, without repeating clear RPCs for charging updates", () => {
    const callbacks = { lost: vi.fn(), resume: vi.fn() }, lifecycle = new DeviceConnectionLifecycle(callbacks);
    lifecycle.handle(connected()); lifecycle.handle(connected({ isInCase: true })); lifecycle.handle(connected({ isInCase: true })); lifecycle.handle(connected());
    expect(callbacks.lost).toHaveBeenCalledOnce(); expect(callbacks.resume).toHaveBeenLastCalledWith(true);
  });
  it("records overlapping display and mic durations without polling or discarding sleeping PTT time", () => {
    const power = new PowerDiagnostics(); vi.setSystemTime(10_000); power.state(false, false);
    vi.setSystemTime(20_000); power.state(false, true); vi.setSystemTime(80_000); power.state(false, false);
    vi.setSystemTime(90_000); power.state(true, false); vi.setSystemTime(100_000);
    expect(power.snapshot()).toMatchObject({ elapsedMs: 100_000, awakeMs: 20_000, sleepMs: 80_000, microphoneMs: 60_000 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses observed battery timestamps rather than a stale level to fabricate a falling hourly rate", () => {
    const power = new PowerDiagnostics(); power.observeBattery(100); vi.setSystemTime(3_600_000); power.observeBattery(94);
    expect(power.snapshot().battery?.percentPerHour).toBe(6);
    vi.setSystemTime(7_200_000); expect(power.snapshot().battery?.percentPerHour).toBe(6);
  });
  it("does not extrapolate from a short sample and resets battery measurement on recharge", () => {
    const power = new PowerDiagnostics(); power.observeBattery(100); vi.setSystemTime(60_000); power.observeBattery(98);
    expect(power.snapshot().battery?.percentPerHour).toBeUndefined();
    power.observeBattery(undefined, true); expect(power.snapshot().battery).toBeUndefined();
    power.observeBattery(100, false); expect(power.snapshot().battery?.drop).toBe(0);
    power.observeBattery(undefined); power.observeBattery(NaN); expect(power.snapshot().battery?.level).toBe(100);
  });
  it("separates the one-time blank page from image/text transfers while asleep", () => {
    const power = new PowerDiagnostics(); power.transfer("image", true); power.transfer("text", true); power.transfer("page", false);
    power.microphoneRepaired(); expect(power.snapshot()).toMatchObject({ transfers: { image: 1, text: 1, page: 1 }, sleepTransfers: { image: 0, text: 0, page: 1 }, repairs: 1 });
  });
});
