import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
function setup() {
  const storage = new Map(), messages: any[] = []; let clicks = 0;
  const location = { href: "https://chatgpt.com/dots/test" };
  let visible: any[] = [];
  const button = (label: string, click?: () => void, pressed = "false", text = label) => ({ disabled: false, innerText: text, getClientRects: () => [{}],
    getAttribute: (name: string) => name === "aria-label" ? label : name === "aria-pressed" ? pressed : null,
    click: () => { clicks++; click?.(); },
  });
  const idle = () => { visible = [button("Start call", active)]; };
  const active = () => { visible = [button("End call", idle), button("Mute microphone")]; };
  idle();
  const sandbox: any = { setInterval, clearInterval, setTimeout, clearTimeout, Date, Map, Promise };
  runInNewContext(readFileSync("browser/dots-bridge/call-control.js", "utf8"), sandbox);
  const control = new sandbox.DotsCallControl({ document: { querySelectorAll: () => visible }, location,
    storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    report: (message: any) => messages.push(message), timeoutMs: 10,
  });
  return { control, location, messages, idle, active, clicks: () => clicks, visible: (items: any[]) => { visible = items; }, button };
}
const command = (id: string, action: string, sessionId = "test-call") => ({ id, action, sessionId, url: "https://chatgpt.com/dots/test" });
afterEach(() => vi.useRealTimers());
describe("Dots browser call controller", () => {
  it("uses the working profile action instead of a header icon with the same name", async () => {
    const t = setup(); let headerClicks = 0;
    t.visible([t.button("通話を開始", () => { headerClicks++; }, "false", ""),
      t.button("通話を開始", t.active, "false", "通話する")]);
    expect((await t.control.execute(command("start", "start"))).snapshot).toMatchObject({ state: "active" });
    expect(headerClicks).toBe(0); expect(t.clicks()).toBe(1);
  });
  it("reveals a closed profile even when an inert header call icon is present", async () => {
    const t = setup(); let headerClicks = 0;
    t.visible([t.button("通話を開始", () => { headerClicks++; }, "false", ""),
      t.button("プロフィールの表示を切り替え", t.idle, "false", "")]);
    expect(t.control.snapshot().state).toBe("unknown");
    expect((await t.control.execute({ id: "prepare", action: "prepare", url: t.location.href })).snapshot).toMatchObject({ state: "idle" });
    expect(headerClicks).toBe(0); expect(t.clicks()).toBe(1);
  });
  it("does not close an already open profile whose call control is missing", async () => {
    const t = setup(); t.visible([t.button("通話を開始", undefined, "false", ""),
      t.button("プロフィールの表示を切り替え", undefined, "true", "")]);
    expect((await t.control.execute({ id: "prepare", action: "prepare", url: t.location.href })).error).toContain("unavailable");
    expect(t.clicks()).toBe(0); expect(t.control.ownedSession).toBe(null);
  });
  it("reveals a closed profile without starting a call or taking ownership", async () => {
    const t = setup(); t.visible([t.button("あなたのdotのプロフィールを開く", t.idle)]);
    expect(t.control.snapshot().state).toBe("unknown");
    expect((await t.control.execute({ id: "prepare", action: "prepare", url: t.location.href })).snapshot)
      .toMatchObject({ state: "idle", ownedSession: null });
    expect(t.clicks()).toBe(1);
    await t.control.execute({ id: "prepare-again", action: "prepare", url: t.location.href });
    expect(t.clicks()).toBe(1);
  });
  it("reports a manual call revealed by the profile and never presses Start", async () => {
    const t = setup(); t.visible([t.button("あなたのdotのプロフィールを開く", t.active)]);
    expect((await t.control.execute({ id: "prepare", action: "prepare", url: t.location.href })).snapshot)
      .toMatchObject({ state: "active", ownedSession: null });
    expect((await t.control.execute(command("start", "start"))).error).toContain("already present");
    expect(t.clicks()).toBe(1);
  });
  it("leaves ownership untouched when the profile cannot reveal call controls", async () => {
    const t = setup(); t.visible([t.button("あなたのdotのプロフィールを開く")]);
    expect((await t.control.execute({ id: "prepare", action: "prepare", url: t.location.href })).error).toContain("not repeated");
    expect(t.control.ownedSession).toBe(null); expect(t.clicks()).toBe(1);
  });
  it("uses visible call controls, remembers ownership, and clears it after confirmed end", async () => {
    const t = setup(); expect(t.control.snapshot().state).toBe("idle");
    expect((await t.control.execute(command("1", "start"))).snapshot).toMatchObject({ state: "active", ownedSession: "test-call", muted: false });
    expect((await t.control.execute(command("2", "stop"))).snapshot).toMatchObject({ state: "idle", ownedSession: null }); expect(t.clicks()).toBe(2);
  });
  it("does not repeat the same command ID or interfere with a manual call", async () => {
    const t = setup(); await t.control.execute(command("1", "start")); await t.control.execute(command("1", "start")); expect(t.clicks()).toBe(1);
    const other = setup(); other.active();
    expect((await other.control.execute(command("1", "start"))).error).toContain("already present");
    expect((await other.control.execute(command("2", "stop"))).error).toContain("did not start"); expect(other.clicks()).toBe(0);
  });
  it("rejects a changed dot and leaves uncertain ownership for cleanup", async () => {
    const t = setup(); t.location.href += "-other";
    expect((await t.control.execute(command("1", "start"))).error).toContain("configured dot"); expect(t.clicks()).toBe(0);
    const uncertain = setup(); uncertain.visible([uncertain.button("Start call")]);
    expect((await uncertain.control.execute(command("1", "start"))).error).toContain("not confirmed");
    expect(uncertain.control.ownedSession).toBe("test-call"); expect(uncertain.clicks()).toBe(1);
    await uncertain.control.execute(command("2", "stop")); expect(uncertain.control.ownedSession).toBe(null);
  });
  it("waits a minute before ending only its owned call if the browser transport stays disconnected", async () => {
    vi.useFakeTimers();
    const t = setup(); await t.control.execute(command("1", "start")); t.control.disconnect();
    await vi.advanceTimersByTimeAsync(59_999); expect(t.control.snapshot().state).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    await t.control.queue; expect(t.control.snapshot()).toMatchObject({ state: "idle", ownedSession: null });
    const manual = setup(); manual.active(); manual.control.disconnect(); expect(manual.clicks()).toBe(0);
  });
  it("cancels fallback hangup on reconnect and repeated disconnects do not extend the deadline", async () => {
    vi.useFakeTimers(); const t = setup(); await t.control.execute(command("1", "start")); t.control.disconnect();
    await vi.advanceTimersByTimeAsync(30_000); t.control.connected(); await vi.advanceTimersByTimeAsync(60_000);
    expect(t.control.snapshot().state).toBe("active"); expect(t.clicks()).toBe(1);
    t.control.disconnect(); await vi.advanceTimersByTimeAsync(30_000); t.control.disconnect(); await vi.advanceTimersByTimeAsync(30_000);
    await t.control.queue; expect(t.control.snapshot().state).toBe("idle");
  });
});
