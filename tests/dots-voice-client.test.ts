import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

describe("Dots phone browser playback", () => {
  function micFixture() {
    const elements = new Map<string, any>(), send = vi.fn(), postMessage = vi.fn();
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: "", disabled: false, value: "", classList: { add() {}, remove() {} }, addEventListener() {} });
      return elements.get(id);
    }, addEventListener() {} };
    const sandbox = createContext({ document, addEventListener() {}, crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(1), randomUUID: () => "request" },
      sessionStorage: { getItem() { return null; }, setItem() {} }, WebSocket: { OPEN: 1 }, send, postMessage,
      bytes: new Uint8Array(640).buffer, setTimeout, clearTimeout });
    runInContext(readFileSync("dots-voice-bridge/public/client.js", "utf8"), sandbox);
    runInContext(`held = true; phase = "active"; owner = clientId = "phone"; connected = true;
      mic = {port: {postMessage}}; socket = {readyState: 1, bufferedAmount: 16000, send};`, sandbox);
    return { sandbox, elements, send, postMessage };
  }
  it("drops congested microphone packets while preserving PTT and resumes without extra delay", () => {
    const t = micFixture(); runInContext("for (let i = 0; i < 100; i++) sendMic(bytes);", t.sandbox);
    expect(t.send).not.toHaveBeenCalled(); expect(t.postMessage).not.toHaveBeenCalled(); expect(runInContext("held", t.sandbox)).toBe(true);
    runInContext("socket.bufferedAmount = 0; sendMic(bytes);", t.sandbox);
    expect(t.send).toHaveBeenCalledOnce(); expect(t.send.mock.calls[0]![0]).toBeInstanceOf(ArrayBuffer);
    expect(runInContext("inputBytes", t.sandbox)).toBe(640);
  });
  it("pauses PTT during helper recovery without a hangup and enables fresh PTT after recovery", () => {
    const t = micFixture();
    runInContext(`applyState({phase: "active", owner: "phone", browserOnline: true, recovery: {audio: true}});
      for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({}); } pending.clear();`, t.sandbox);
    expect(t.elements.get("ptt").disabled).toBe(true); expect(t.postMessage).toHaveBeenCalledWith(false);
    expect(t.send).toHaveBeenCalledOnce(); expect(JSON.parse(t.send.mock.calls[0]![0])).toMatchObject({ method: "audio.input", params: { enabled: false } });
    runInContext(`applyState({phase: "active", owner: "phone", browserOnline: true, recovery: {audio: false}});`, t.sandbox);
    expect(t.elements.get("ptt").disabled).toBe(false); expect(runInContext("held", t.sandbox)).toBe(false);
  });
  it("drops late buffered playback without sending a hangup command", () => {
    const elements = new Map<string, any>();
    const document = { getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", disabled: false, value: "", classList: { add() {}, remove() {} }, addEventListener() {} });
      return elements.get(id);
    }, addEventListener() {} };
    const start = vi.fn(), stale = { stop: vi.fn() }, send = vi.fn();
    const playback = { state: "running", currentTime: 0, destination: {},
      createBuffer: (_channels: number, frames: number) => ({ duration: frames / 48000, getChannelData: () => new Float32Array(frames) }),
      createBufferSource: () => ({ connect() {}, start, stop() {} }),
    };
    const sandbox = createContext({ document, addEventListener() {}, crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) },
      sessionStorage: { getItem() { return null; }, setItem() {} }, WebSocket: { OPEN: 1 }, playback, stale, send, bytes: new Uint8Array(8).buffer,
      setTimeout, clearTimeout });
    runInContext(readFileSync("dots-voice-bridge/public/client.js", "utf8"), sandbox);
    runInContext(`context = playback; streamId = "current"; playbackAt = 3; connected = true; socket = {readyState: 1, send}; sources.add(stale);
      play(bytes, {streamId: "current", route: "original", channels: 1, sampleRate: 48000, byteLength: 8});`, sandbox);
    expect(stale.stop).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledExactlyOnceWith(.04);
    expect(send).not.toHaveBeenCalled(); expect(elements.get("log").textContent).toContain("通話は継続します");
  });
});
