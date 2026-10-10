import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function setup() {
  const event = () => {
    let listener: (value?: any) => void = () => {};
    return { addListener: (fn: typeof listener) => { listener = fn; }, emit: (value?: any) => listener(value) };
  };
  const port = { onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() };
  const controls = { monitor: vi.fn(), connected: vi.fn(), disconnect: vi.fn(), close: vi.fn(), execute: vi.fn() };
  const initialized = vi.fn(), observed = vi.fn(), timers = vi.fn(), window: any = {};
  window.top = window;
  const row = { dataset: { messageId: "example" }, querySelector: () => ({ innerText: "Example", textContent: "Example" }),
    closest: () => ({ classList: { contains: () => false } }) };
  const document = { body: {}, querySelectorAll: () => [row], querySelector: () => ({}), addEventListener: vi.fn() };
  class Watch { initialize = initialized; scan = () => []; }
  class History { capture = () => null; }
  class Observer { observe = observed; disconnect = vi.fn(); }
  runInNewContext(readFileSync("browser/dots-bridge/content.js", "utf8"), {
    window, document, location: { href: "https://chatgpt.com/dots/home" }, sessionStorage: {},
    chrome: { runtime: { id: "extension", connect: () => port } },
    DotsMessageWatch: Watch, DotsHistoryWatch: History, DotsCallControl: function () { return controls; },
    MutationObserver: Observer, setTimeout: timers, clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
    addEventListener: vi.fn(), console,
  });
  return { port, controls, initialized, observed, timers };
}

describe("shared extension content ownership", () => {
  it("keeps history observers and call monitoring inactive until the selected Dot is accepted", () => {
    const t = setup();
    expect(t.port.postMessage).toHaveBeenCalledWith({ type: "ready" });
    expect(t.controls.monitor).not.toHaveBeenCalled(); expect(t.observed).not.toHaveBeenCalled();
    t.port.onMessage.emit({ type: "watch-ready" });
    expect(t.controls.monitor).toHaveBeenCalledTimes(1); expect(t.initialized).toHaveBeenCalledTimes(1);
    expect(t.observed).toHaveBeenCalledTimes(1);
    t.port.onMessage.emit({ type: "watch-ready" });
    expect(t.controls.monitor).toHaveBeenCalledTimes(1); expect(t.initialized).toHaveBeenCalledTimes(1);
  });
  it("does not retry or end a call when a different Dot is excluded", () => {
    const t = setup(); t.port.onMessage.emit({ type: "inactive" }); t.port.onDisconnect.emit();
    expect(t.timers).not.toHaveBeenCalled(); expect(t.controls.disconnect).not.toHaveBeenCalled();
    expect(t.controls.monitor).not.toHaveBeenCalled(); expect(t.observed).not.toHaveBeenCalled();
  });
});
