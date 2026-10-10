import { describe, expect, it, vi } from "vitest";
import { SettingsStore, type NativeSettingsStorage } from "../dots-phone-g2/src/settings-store";
import { CONNECTION_SETTINGS_KEY, connectionFromBaseUrl, decodeConnection } from "../dots-phone-g2/src/connection-settings";
import { DEFAULT_PREFERENCES, decodePreferences } from "../dots-phone-g2/src/preferences";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function nativeStorage(): NativeSettingsStorage {
  const values = storage();
  return { getLocalStorage: async key => values.getItem(key) ?? "", setLocalStorage: async (key, value) => { values.setItem(key, value); return true; } };
}
const key = "preferences";
const custom = { ...DEFAULT_PREFERENCES, inputMode: "phone" as const, reviewTranscript: true, displayOffSeconds: 0 };
const make = (browser = storage()) => new SettingsStore(key, DEFAULT_PREFERENCES, decodePreferences, browser);

describe("durable G2 settings", () => {
  it("uses first-launch defaults and preserves an explicit phone mode and disabled timer after WebView replacement", async () => {
    const native = nativeStorage(), first = make();
    expect(await first.load(native)).toEqual(DEFAULT_PREFERENCES);
    await first.save(custom);
    expect(await make().load(native)).toEqual(custom);
  });
  it("migrates existing plain WebView settings into the native app store", async () => {
    const browser = storage(), native = nativeStorage(); browser.setItem(key, JSON.stringify(custom));
    expect(await make(browser).load(native)).toEqual(custom);
    expect(await make().load(native)).toEqual(custom);
  });
  it("restores native settings when browser storage is blocked", async () => {
    const native = nativeStorage(), first = make(); await first.load(native); await first.save(custom);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const reopened = new SettingsStore(key, DEFAULT_PREFERENCES, decodePreferences, broken);
    expect(await reopened.load(native)).toEqual(custom); await reopened.save(DEFAULT_PREFERENCES);
    expect(await make().load(native)).toEqual(DEFAULT_PREFERENCES);
  });
  it("serializes rapid changes so a slow earlier write cannot overwrite the latest choice", async () => {
    const native = nativeStorage(); let release!: () => void;
    const write = native.setLocalStorage.bind(native);
    native.setLocalStorage = vi.fn().mockImplementationOnce(async (key, value) => {
      await new Promise<void>(resolve => { release = resolve; }); return write(key, value);
    }).mockImplementation(write);
    const settings = make(); await settings.load(native);
    const first = settings.save(custom), second = settings.save(DEFAULT_PREFERENCES);
    await Promise.resolve(); await Promise.resolve();
    expect(native.setLocalStorage).toHaveBeenCalledTimes(1); release(); await Promise.all([first, second]);
    expect(await make().load(native)).toEqual(DEFAULT_PREFERENCES);
  });
  it("retains the browser cache after a failed native save and retries the newest value on reopen", async () => {
    const browser = storage(), native = nativeStorage(), settings = make(browser);
    await settings.load(native); await settings.save(custom);
    const write = native.setLocalStorage; native.setLocalStorage = async () => false;
    await expect(settings.save(DEFAULT_PREFERENCES)).rejects.toThrow("設定を保存");
    native.setLocalStorage = write;
    expect(await make(browser).load(native)).toEqual(DEFAULT_PREFERENCES);
    expect(await make().load(native)).toEqual(DEFAULT_PREFERENCES);
  });
  it("does not replace unread native settings with defaults when restoration fails", async () => {
    const native = nativeStorage(); native.getLocalStorage = async () => { throw new Error("unavailable"); };
    native.setLocalStorage = vi.fn(); const settings = make();
    expect(await settings.load(native)).toEqual(DEFAULT_PREFERENCES);
    expect(settings.restoreError).toBeInstanceOf(Error); expect(native.setLocalStorage).not.toHaveBeenCalled();
  });
  it("ignores corrupt saved data and rejects a save when neither storage is available", async () => {
    const browser = storage(); browser.setItem(key, "{bad"); expect(await make(browser).load()).toEqual(DEFAULT_PREFERENCES);
    const settings = new SettingsStore(key, DEFAULT_PREFERENCES, decodePreferences);
    await expect(settings.save(custom)).rejects.toThrow("設定を保存");
  });
  it("isolates the native namespace while migrating a legacy browser key", async () => {
    const native = nativeStorage(), browser = storage(); browser.setItem(key, JSON.stringify(custom));
    const publicStore = new SettingsStore(key, DEFAULT_PREFERENCES, decodePreferences, browser, Date.now, "public.preferences");
    await publicStore.load(native);
    expect(await native.getLocalStorage(key)).toBe(""); expect(await native.getLocalStorage("public.preferences")).not.toBe("");
  });
});

describe("initial preferences", () => {
  it("defaults to text input and thirty-second display sleep", () => {
    expect(DEFAULT_PREFERENCES.inputMode).toBe("text"); expect(DEFAULT_PREFERENCES.displayOffSeconds).toBe(30);
  });
  it("fills only missing fields while retaining existing choices", () => {
    expect(decodePreferences({ inputMode: "phone", displayOffSeconds: 120, reviewTranscript: true })).toEqual({ ...DEFAULT_PREFERENCES, inputMode: "phone", displayOffSeconds: 120, reviewTranscript: true });
    expect(decodePreferences({ inputMode: "text" })).toEqual(DEFAULT_PREFERENCES);
    expect(decodePreferences({})).toBeUndefined();
  });
});

it("restores the configured Mac and token before connecting after WebView replacement", async () => {
  const settings = connectionFromBaseUrl("ws://mac.example.invalid:8799", "a".repeat(64));
  const defaults = { ...settings, token: "" }, native = nativeStorage();
  const first = new SettingsStore(CONNECTION_SETTINGS_KEY, defaults, decodeConnection, storage());
  await first.load(native); await first.save(settings);
  const reopened = new SettingsStore(CONNECTION_SETTINGS_KEY, defaults, decodeConnection, storage());
  expect(await reopened.load(native)).toEqual(settings);
});

it("defaults the screen-control side to right, migrates old settings and restores a swapped choice", async () => {
  expect(DEFAULT_PREFERENCES.screenSide).toBe("right");
  expect(decodePreferences({ inputMode: "phone", displayOffSeconds: 120 })?.screenSide).toBe("right");
  expect(decodePreferences({ screenSide: "invalid" })?.screenSide).toBe("right");
  const native = nativeStorage(), settings = make(); await settings.load(native);
  await settings.save({ ...custom, screenSide: "left" });
  expect((await make().load(native)).screenSide).toBe("left");
});

it("defaults to a fixed character and restores an explicitly enabled animation after WebView replacement", async () => {
  expect(DEFAULT_PREFERENCES.animateCharacter).toBe(false);
  expect(decodePreferences({ inputMode: "phone" })?.animateCharacter).toBe(false);
  expect(decodePreferences({ animateCharacter: "true" })?.animateCharacter).toBe(false);
  const native = nativeStorage(), settings = make(); await settings.load(native);
  await settings.save({ ...custom, animateCharacter: true });
  expect((await make().load(native)).animateCharacter).toBe(true);
});

it.each([10, 30, 50, 100] as const)("restores a %i-message history limit after WebView storage replacement", async historyLimit => {
  const native = nativeStorage(), settings = make(); await settings.load(native);
  await settings.save({ ...custom, historyLimit });
  expect(await make().load(native)).toEqual({ ...custom, historyLimit });
});
