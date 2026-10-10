import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
// @ts-expect-error Setup also uses this JavaScript module.
import { hostName } from "../scripts/configuration.mjs";
// @ts-expect-error Chrome's service worker also imports this JavaScript module.
import { normalDotTab, prepareDotTab, openNormalDot } from "../browser/dots-bridge/tab-routing.js";
// @ts-expect-error The shared extension reads local native-host settings.
import { readConfiguredDotUrl } from "../browser/dots-bridge/settings.js";

const dotUrl = "https://chatgpt.com/dots/home";
function event() {
  const listeners: Array<(value?: any) => void> = [];
  return { addListener: (listener: (value?: any) => void) => listeners.push(listener),
    emit: (value?: any) => listeners.forEach(listener => listener(value)) };
}
function port(tabId: number) {
  return { name: "dots-page", sender: { url: dotUrl, frameId: 0, tab: { id: tabId } },
    onMessage: event(), onDisconnect: event(), postMessage: vi.fn(),
    disconnect: vi.fn(function (this: any) { this.onDisconnect.emit(); }) };
}
function setup(tabs: any[] = [], windows: any[] = []) {
  const native = { onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() };
  const chrome = {
    tabs: {
      get: vi.fn(async (id: number) => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error("Closed tab"); return tab; }),
      query: vi.fn(async () => tabs.filter(tab => tab.url === dotUrl)),
      update: vi.fn(async (id: number, changes: any) => ({ ...tabs.find(tab => tab.id === id), ...changes })),
      create: vi.fn(async (options: any) => ({ id: 99, ...options })),
    },
    windows: {
      get: vi.fn(async (id: number) => { const window = windows.find(window => window.id === id); if (!window) throw new Error("Closed window"); return window; }),
      getAll: vi.fn(async () => windows), update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 90, tabs: [{ id: 99 }] })),
    },
    runtime: { onConnect: event(), onStartup: event(), onInstalled: event(), connectNative: vi.fn(() => native),
      sendNativeMessage: vi.fn(async () => ({ type: "config", dotUrl })), openOptionsPage: vi.fn(async () => {}) },
    action: { onClicked: event(), setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  };
  const background = () => runInNewContext(readFileSync("browser/dots-bridge/background.js", "utf8").replace(/^import .*;\n/gm, ""),
    { chrome, readConfiguredDotUrl, normalDotTab, prepareDotTab, openNormalDot, setTimeout, clearTimeout, console });
  return { chrome, native, background };
}

describe("Dots normal Chrome tabs", () => {
  it("waits for saved settings and rejects another Dot without claiming or controlling it", async () => {
    const t = setup([{ id: 1, windowId: 10, url: dotUrl }], [{ id: 10, type: "normal" }]);
    let resolveSettings!: (value: any) => void;
    t.chrome.runtime.sendNativeMessage.mockImplementationOnce(() => new Promise(resolve => { resolveSettings = resolve; }));
    t.background();
    const normal = port(1), wrong = port(2); wrong.sender.url = dotUrl + "-other";
    t.chrome.runtime.onConnect.emit(wrong); wrong.onMessage.emit({ type: "ready" });
    t.chrome.runtime.onConnect.emit(normal); normal.onMessage.emit({ type: "ready" });
    expect(t.chrome.runtime.connectNative).not.toHaveBeenCalled();
    resolveSettings({ type: "config", dotUrl });
    await vi.waitFor(() => expect(t.chrome.runtime.connectNative).toHaveBeenCalledTimes(1));
    expect(wrong.postMessage).toHaveBeenCalledWith({ type: "inactive" });
    expect(wrong.disconnect).toHaveBeenCalledTimes(1);
    expect(t.chrome.runtime.sendNativeMessage).toHaveBeenCalledTimes(1);
    expect(t.chrome.runtime.sendNativeMessage).toHaveBeenCalledWith(hostName, { type: "config" });
    expect(t.native.postMessage).toHaveBeenCalledWith({ type: "ready", url: dotUrl });
  });

  it("rejects invalid native settings and allows a later retry after setup is repaired", async () => {
    const t = setup([{ id: 1, windowId: 10, url: dotUrl }], [{ id: 10, type: "normal" }]);
    for (const invalid of ["https://example.invalid/dots/home", dotUrl + "?token=example", "https://chatgpt.com/"]) {
      t.chrome.runtime.sendNativeMessage.mockResolvedValueOnce({ type: "config", dotUrl: invalid });
      await expect(readConfiguredDotUrl(t.chrome)).rejects.toThrow();
    }
    t.chrome.runtime.sendNativeMessage.mockRejectedValueOnce(new Error("Native host not installed"));
    t.background(); const first = port(1); t.chrome.runtime.onConnect.emit(first); first.onMessage.emit({ type: "ready" });
    await vi.waitFor(() => expect(first.disconnect).toHaveBeenCalledTimes(1));
    const later = port(1); t.chrome.runtime.onConnect.emit(later); later.onMessage.emit({ type: "ready" });
    await vi.waitFor(() => expect(t.chrome.runtime.connectNative).toHaveBeenCalledTimes(1));
  });
  it("prepares a normal tab without moving or resizing it, and rejects an old popup", async () => {
    const t = setup([{ id: 1, windowId: 10, url: dotUrl }, { id: 2, windowId: 20, url: dotUrl }],
      [{ id: 10, type: "normal", state: "normal" }, { id: 20, type: "popup" }]);
    await prepareDotTab(t.chrome, dotUrl, 1);
    expect(t.chrome.tabs.update).toHaveBeenCalledWith(1, { active: true, autoDiscardable: false });
    expect(t.chrome.windows.create).not.toHaveBeenCalled();
    expect(t.chrome.windows.update).not.toHaveBeenCalled();
    await expect(prepareDotTab(t.chrome, dotUrl, 2)).rejects.toThrow("normal Chrome tab");
    expect(t.chrome.tabs.update).toHaveBeenCalledTimes(1);
  });

  it("leaves background connection quiet but restores a minimized window when a command needs it", async () => {
    const t = setup([{ id: 1, windowId: 10, url: dotUrl }], [{ id: 10, type: "normal", state: "minimized" }]);
    await prepareDotTab(t.chrome, dotUrl, 1, { activate: false });
    expect(t.chrome.tabs.update).toHaveBeenLastCalledWith(1, { autoDiscardable: false });
    expect(t.chrome.windows.update).not.toHaveBeenCalled();
    await prepareDotTab(t.chrome, dotUrl, 1);
    expect(t.chrome.windows.update).toHaveBeenCalledWith(10, { state: "normal" });
  });

  it("selects the normal dot even when the old popup appears first", async () => {
    const t = setup([{ id: 1, windowId: 10, url: dotUrl }, { id: 2, windowId: 20, url: dotUrl }],
      [{ id: 10, type: "popup" }, { id: 20, type: "normal", state: "normal" }]);
    expect((await openNormalDot(t.chrome, dotUrl, { focus: true, preferredTabId: 1 })).id).toBe(2);
    expect(t.chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(t.chrome.windows.update).toHaveBeenCalledWith(20, { focused: true });
    expect(t.chrome.tabs.create).not.toHaveBeenCalled();
    expect(t.chrome.windows.create).not.toHaveBeenCalled();
  });

  it("opens a fresh tab in a regular window when only a popup has the dot", async () => {
    const t = setup([{ id: 1, windowId: 10, url: dotUrl }],
      [{ id: 10, type: "popup", focused: true }, { id: 20, type: "normal" }]);
    await openNormalDot(t.chrome, dotUrl);
    expect(t.chrome.tabs.create).toHaveBeenCalledWith({ windowId: 20, url: dotUrl, active: false });
    expect(t.chrome.windows.update).not.toHaveBeenCalled();
    expect(t.chrome.windows.create).not.toHaveBeenCalled();
  });

  it("creates a desktop-size normal window when no regular window exists", async () => {
    const t = setup([], [{ id: 10, type: "popup" }, { id: 20, type: "normal", incognito: true }]);
    await openNormalDot(t.chrome, dotUrl, { focus: true });
    expect(t.chrome.windows.create).toHaveBeenCalledWith({ url: dotUrl, type: "normal", incognito: false,
      focused: true, width: 1280, height: 900 });
    expect(t.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("rejects another dot and ignores a tab closed while selecting a destination", async () => {
    const t = setup([{ id: 1, windowId: 10, url: `${dotUrl}-other` }, { id: 2, windowId: 99, url: dotUrl }],
      [{ id: 10, type: "normal" }]);
    await expect(normalDotTab(t.chrome, dotUrl, 1)).rejects.toThrow("no longer this dot");
    await openNormalDot(t.chrome, dotUrl);
    expect(t.chrome.tabs.create).toHaveBeenCalledWith({ windowId: 10, url: dotUrl, active: false });
  });

  it("rejects a popup before ownership and preserves an early ready message from the normal tab", async () => {
    const t = setup([{ id: 1, windowId: 10, url: dotUrl }, { id: 2, windowId: 20, url: dotUrl }],
      [{ id: 10, type: "popup" }, { id: 20, type: "normal" }]);
    t.background();
    const popup = port(1), normal = port(2);
    t.chrome.runtime.onConnect.emit(popup); popup.onMessage.emit({ type: "ready" });
    t.chrome.runtime.onConnect.emit(normal); normal.onMessage.emit({ type: "ready" });
    await vi.waitFor(() => expect(t.chrome.runtime.connectNative).toHaveBeenCalledTimes(1));
    expect(t.chrome.runtime.connectNative).toHaveBeenCalledWith(hostName);
    expect(popup.disconnect).toHaveBeenCalledTimes(1);
    expect(popup.postMessage).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("normal Chrome tab") }));
    expect(normal.disconnect).not.toHaveBeenCalled();
    expect(t.chrome.tabs.update).toHaveBeenCalledWith(2, { autoDiscardable: false });
    t.native.onMessage.emit({ type: "voice.command", id: "call", action: "start", url: dotUrl, sessionId: "session" });
    await vi.waitFor(() => expect(normal.postMessage).toHaveBeenCalledWith(expect.objectContaining({ action: "start" })));
    expect(t.chrome.windows.create).not.toHaveBeenCalled();
  });

  it("does not let a disconnected claimant or another normal tab take over the live owner", async () => {
    const t = setup([{ id: 1, windowId: 10, url: dotUrl }, { id: 2, windowId: 20, url: dotUrl }],
      [{ id: 10, type: "normal" }, { id: 20, type: "normal" }]);
    t.background();
    const gone = port(1), live = port(2);
    t.chrome.runtime.onConnect.emit(gone); gone.onDisconnect.emit();
    t.chrome.runtime.onConnect.emit(live); live.onMessage.emit({ type: "ready" });
    await vi.waitFor(() => expect(t.chrome.runtime.connectNative).toHaveBeenCalledTimes(1));
    const other = port(1); t.chrome.runtime.onConnect.emit(other); other.onMessage.emit({ type: "ready" });
    await vi.waitFor(() => expect(other.disconnect).toHaveBeenCalledTimes(1));
    expect(other.postMessage).toHaveBeenCalledWith(expect.objectContaining({ message: "Another dot tab owns the bridge" }));
    t.chrome.action.onClicked.emit();
    await vi.waitFor(() => expect(t.chrome.tabs.update).toHaveBeenCalledWith(2, { active: true }));
    expect(t.chrome.runtime.connectNative).toHaveBeenCalledTimes(1);
  });
});
