import { afterEach, describe, expect, it, vi } from "vitest";
import { DotsModel } from "../dots-phone-g2/src/model";
import { SpeechWake } from "../dots-phone-g2/src/speech-wake";
import { PhonePushToTalk, type TalkRoute } from "../dots-phone-g2/src/push-to-talk";
import { PhoneSocket } from "../dots-phone-g2/src/socket";
import { synchronizeInbox } from "../dots-phone-g2/src/inbox";
import { buildDotsPage, buildDotsSleepPage, dotsTexts, DotsGlasses } from "../dots-phone-g2/src/glasses";
import { PowerDiagnostics } from "../dots-phone-g2/src/power-diagnostics";
import type { Activity } from "../dots-phone-g2/src/model";
import { dotGray4, dotPose, EYES } from "../dots-phone-g2/src/avatar";
import { ImageRawDataUpdateResult, validateEvenHubPageContainerZOrder, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { OwnedMicrophone } from "../dots-phone-g2/src/microphone";
import { OverlayLifecycle } from "../dots-phone-g2/src/lifecycle";
import { EventSourceType, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { DotsControls } from "../dots-phone-g2/src/controls";
import { InputModeSwitch } from "../dots-phone-g2/src/input-mode";
import { voiceResumeKey } from "../dots-phone-g2/src/client-identity";
afterEach(() => vi.unstubAllGlobals());
describe("Persistent text conversation stages", () => {
  it.each<[Activity, string]>([["ready", "READY"], ["recording", "REC"], ["recognizing", "ASR"], ["reviewing", "ASR"], ["waiting", "DOT"]])("shows all four stages with %s highlighted", (activity, stage) => {
    const model = new DotsModel(); model.inputMode = "text"; model.setActivity(activity);
    if (activity === "recording") { model.phase = "listening"; model.transcript = "認識中の文章"; }
    expect(model.footer.replace(/[[\]]/g, "")).toBe("READY > REC > ASR > DOT");
    expect(model.footer).toContain(`[${stage}]`);
    expect(dotsTexts(model).find(item => item.name === "dotsFooter")!.content).toBe(model.footer);
  });
  it("keeps ASR review actions visible alongside the permanent stages", () => {
    const model = new DotsModel(); model.inputMode = "text"; model.transcript = "確認する文章"; model.pendingTranscript = true; model.setActivity("reviewing");
    expect(model.heading).toContain("長押しで送信"); expect(model.footer).toContain("2タップ:破棄"); expect(model.footer).toContain("[ASR]");
  });
  it("keeps the phone call controls instead of showing the text pipeline", () => {
    const model = new DotsModel(); model.callActive = true; expect(model.footer).toContain("PTT"); expect(model.footer).not.toContain("ASR");
  });
});

function pcm(level: number, ms = 40, rate = 48000, channels = 2): Uint8Array {
  const bytes = new Uint8Array(rate * ms / 1000 * channels * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 2; i++) view.setInt16(i * 2, Math.round(level * 32767 * Math.sin(i * .11)), true);
  return bytes;
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
describe("Dots Phone G2 wake policy", () => {
  it("ignores silence and a short click, then wakes at a sustained utterance", () => {
    const wake = new SpeechWake();
    expect(wake.feed(pcm(0), 48000, 2)).toBe(false);
    expect(wake.feed(pcm(.4, 20), 48000, 2)).toBe(false);
    wake.feed(pcm(0), 48000, 2);
    expect(wake.feed(pcm(.1), 48000, 2)).toBe(false);
    expect(wake.feed(pcm(.1), 48000, 2)).toBe(true);
    expect(wake.feed(pcm(.1), 48000, 2)).toBe(false);
  });
  it("keeps a dismissed utterance dismissed across a stream reset, rearms after silence", () => {
    const wake = new SpeechWake(); wake.feed(pcm(.2, 80), 48000, 2); wake.reset(true);
    expect(wake.feed(pcm(.2, 80), 48000, 2)).toBe(false);
    expect(wake.feed(pcm(0, 500), 48000, 2)).toBe(false);
    expect(wake.feed(pcm(.2, 80, 48000, 1), 48000, 1)).toBe(true);
  });
  it("does not wake on repeated notifications after manual display-off or restoration", () => {
    const model = new DotsModel(); const item = { id: "first", sequence: 1, text: "おかえり", receivedAt: 1 };
    model.incoming(item); model.toggleDisplay(); expect(model.awake).toBe(false);
    expect(model.incoming(item)).toBe(false); expect(model.awake).toBe(false);
    const restored = new DotsModel(model.save()); restored.awake = false;
    expect(restored.incoming(item)).toBe(false); expect(restored.awake).toBe(false);
    expect(restored.incoming({ ...item, id: "second", sequence: 2 })).toBe(true); expect(restored.awake).toBe(true);
  });
  it("baselines old history silently and synchronizes all pages before live subscription", async () => {
    const model = new DotsModel(); model.awake = false;
    const request = vi.fn().mockResolvedValueOnce({ items: [{ id: "1", sequence: 1, text: "過去", receivedAt: 1 }], nextCursor: 1, hasMore: true })
      .mockResolvedValueOnce({ items: [], nextCursor: 1, hasMore: false });
    await synchronizeInbox({ request }, model, vi.fn());
    expect(request).toHaveBeenLastCalledWith("notification/sync", { after: 1, limit: 100, includeInputs: true });
    expect(model.initialized).toBe(true); expect(model.awake).toBe(false);
    request.mockResolvedValue({ items: [{ id: "2", sequence: 2, text: "新着", receivedAt: 2 }], nextCursor: 2, hasMore: false });
    await synchronizeInbox({ request }, model, vi.fn()); expect(model.awake).toBe(true);
  });
});
describe("Dots Phone G2 microphone sequencing", () => {
  function setup(start = Promise.resolve(), gate = Promise.resolve()) {
    const route: TalkRoute = { ensureCall: vi.fn(() => start), owned: () => true, setInput: vi.fn(() => gate), microphone: vi.fn(async () => {}), changed: vi.fn(), error: vi.fn() };
    return { route, ptt: new PhonePushToTalk(route) };
  }
  it("does not open a microphone when released while the call is connecting", async () => {
    const call = deferred(), { route, ptt } = setup(call.promise);
    ptt.hold("r1"); await flush(); const released = ptt.release("r1"); call.resolve(); await released;
    expect(route.setInput).not.toHaveBeenCalled(); expect(route.microphone).not.toHaveBeenCalled(); expect(ptt.recording).toBe(false);
  });
  it("closes the input gate if release arrives before its acknowledgement", async () => {
    const gate = deferred(), { route, ptt } = setup(Promise.resolve(), gate.promise);
    ptt.hold("left"); await flush(); const released = ptt.release("left"); gate.resolve(); await released;
    expect(route.setInput).toHaveBeenNthCalledWith(1, true); expect(route.setInput).toHaveBeenNthCalledWith(2, false);
    expect(route.microphone).not.toHaveBeenCalledWith(true); expect(ptt.recording).toBe(false);
  });
  it("supports overlapping holds and closes the native microphone after disconnect", async () => {
    const { route, ptt } = setup(); let owned = true; route.owned = () => owned;
    ptt.hold("left"); ptt.hold("r1"); await flush(); expect(ptt.recording).toBe(true);
    await ptt.release("left"); expect(ptt.recording).toBe(true);
    owned = false; await ptt.clear(); expect(route.microphone).toHaveBeenLastCalledWith(false);
    expect(ptt.recording).toBe(false);
  });
  it("closes a native microphone even when its open operation fails", async () => {
    const { route, ptt } = setup(); route.microphone = vi.fn().mockRejectedValueOnce(new Error("open failed")).mockResolvedValue(undefined);
    ptt.hold("r1"); await flush(); await ptt.clear();
    expect(route.microphone).toHaveBeenNthCalledWith(1, true); expect(route.microphone).toHaveBeenNthCalledWith(2, false); expect(route.error).toHaveBeenCalled();
  });
  it("closes a delayed native open immediately when the hold has already been released", async () => {
    const native = deferred(), { route, ptt } = setup();
    route.microphone = vi.fn().mockImplementationOnce(() => native.promise).mockResolvedValue(undefined);
    ptt.hold("r1"); await flush(); expect(ptt.recording).toBe(false);
    const released = ptt.release("r1"); native.resolve(); await released;
    expect(route.microphone).toHaveBeenNthCalledWith(1, true); expect(route.microphone).toHaveBeenNthCalledWith(2, false);
    expect(route.changed).not.toHaveBeenCalledWith(true); expect(ptt.recording).toBe(false);
  });
  it("stops display work at hold time and measures the connection, gate and native waits separately", async () => {
    const call = deferred(), gate = deferred(), native = deferred(), closing = deferred(); let now = 0;
    const { route } = setup(call.promise, gate.promise); route.microphone = vi.fn(enabled => enabled ? native.promise : closing.promise);
    route.preparing = vi.fn(); route.timing = vi.fn();
    const ptt = new PhonePushToTalk(route, () => now); ptt.hold("g2-left");
    expect(route.preparing).toHaveBeenCalledWith(true); expect(route.ensureCall).not.toHaveBeenCalled();
    now = 2; await flush(); now = 102; call.resolve(); await flush();
    now = 132; gate.resolve(); await flush(); now = 332; native.resolve(); await flush();
    expect(route.timing).toHaveBeenCalledWith(expect.objectContaining({ source: "g2-left", queueMs: 2, ensureCallMs: 100, inputGateMs: 30, nativeMicMs: 200, totalMs: 332, result: "ready" }));
    expect(ptt.recording).toBe(true); expect(route.preparing).toHaveBeenLastCalledWith(false);
    const released = ptt.release("g2-left"); expect(route.preparing).toHaveBeenLastCalledWith(true);
    await flush(); expect(ptt.recording).toBe(false); closing.resolve(); await released;
    expect(route.preparing).toHaveBeenLastCalledWith(false);
  });
  it("holds PTT for a full minute and does not extend it when another source joins", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const { route, ptt } = setup(); ptt.hold("g2-left"); await flush();
      ptt.tick(26_000); expect(ptt.recording).toBe(true);
      clock.mockReturnValue(31_000); ptt.hold("r1"); await flush();
      ptt.tick(60_999); expect(ptt.recording).toBe(true);
      ptt.tick(61_000); await flush(); expect(ptt.recording).toBe(false);
      expect(route.microphone).toHaveBeenLastCalledWith(false); expect(route.setInput).toHaveBeenLastCalledWith(false);
    } finally { clock.mockRestore(); }
  });
});
describe("Dots Phone G2 reconnect identity", () => {
  it("retains one WebView's identity across reloads and separates different WebViews", () => {
    const saved = new Map<string, string>(), storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    const random = vi.fn((bytes: Uint8Array) => bytes.fill(7));
    const first = voiceResumeKey(storage, random); expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(voiceResumeKey(storage, random)).toBe(first); expect(random).toHaveBeenCalledOnce();
    expect(voiceResumeKey(undefined, bytes => bytes.fill(8))).not.toBe(first);
  });
  it("replaces an invalid stored identity and can reconnect with storage disabled", () => {
    const storage = { getItem: () => "invalid", setItem: vi.fn() };
    expect(voiceResumeKey(storage, bytes => bytes.fill(1))).toMatch(/^[a-f0-9]{64}$/); expect(storage.setItem).toHaveBeenCalledOnce();
    expect(voiceResumeKey({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }, bytes => bytes.fill(2))).toMatch(/^[a-f0-9]{64}$/);
  });
});
describe("Dots Phone G2 sleeping controls", () => {
  function setup(active = true) {
    const model = new DotsModel(); model.callActive = active; let owned = active, now = 1000;
    const actions = { awake: () => model.awake, ownedCall: () => owned, canEndCall: () => owned && model.callActive, endCall: vi.fn(() => { model.callActive = false; }), switchMode: vi.fn(() => { model.inputMode = model.inputMode === "phone" ? "text" : "phone"; }), discardAsr: vi.fn(), submitAsr: vi.fn(), doubleTap: vi.fn(() => model.toggleDisplay()), tap: vi.fn(), scroll: vi.fn(), hold: vi.fn(), release: vi.fn() };
    const controls = new DotsControls(actions, () => now);
    const event = (type: OsEventTypeList, source = EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) => controls.route({ jsonData: { eventType: type, eventSource: source } });
    return { model, actions, controls, event, advance: () => { now += 1000; }, disconnect: () => { owned = false; } };
  }
  it("right hold switches input once without starting PTT; the same hold cannot start PTT after sleep", () => {
    const { model, actions, event } = setup(); event(OsEventTypeList.LONG_PRESS_EVENT);
    expect(model.awake).toBe(true); expect(model.inputMode).toBe("text"); expect(actions.hold).not.toHaveBeenCalled();
    event(OsEventTypeList.LONG_PRESS_EVENT); expect(actions.switchMode).toHaveBeenCalledOnce();
    model.sleepDisplay(); event(OsEventTypeList.LONG_PRESS_EVENT); expect(actions.hold).not.toHaveBeenCalled();
    event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT); event(OsEventTypeList.LONG_PRESS_EVENT);
    expect(actions.hold).toHaveBeenCalledWith("g2-right");
  });
  it("keeps the left and ring holds as PTT when awake", () => {
    const { actions, event } = setup(false);
    event(OsEventTypeList.LONG_PRESS_EVENT, EventSourceType.TOUCH_EVENT_FROM_GLASSES_L);
    event(OsEventTypeList.LONG_PRESS_EVENT, EventSourceType.TOUCH_EVENT_FROM_RING);
    expect(actions.hold.mock.calls).toEqual([["g2-left"], ["r1"]]); expect(actions.switchMode).not.toHaveBeenCalled();
  });
  it("only allows double tap and holds on an owned call while asleep; tap and scroll do nothing", () => {
    const { model, actions, event, advance } = setup(); model.sleepDisplay();
    event(OsEventTypeList.CLICK_EVENT); event(OsEventTypeList.SCROLL_TOP_EVENT); event(OsEventTypeList.SCROLL_BOTTOM_EVENT);
    expect(actions.tap).not.toHaveBeenCalled(); expect(actions.scroll).not.toHaveBeenCalled(); expect(model.awake).toBe(false);
    event(OsEventTypeList.LONG_PRESS_EVENT, EventSourceType.TOUCH_EVENT_FROM_GLASSES_L);
    event(OsEventTypeList.LONG_PRESS_EVENT, EventSourceType.TOUCH_EVENT_FROM_RING);
    expect(actions.hold.mock.calls).toEqual([["g2-left"], ["r1"]]);
    advance(); event(OsEventTypeList.DOUBLE_CLICK_EVENT); expect(actions.doubleTap).toHaveBeenCalledOnce();
    expect(model.awake).toBe(true); expect(model.callActive).toBe(true); expect(model.inputMode).toBe("phone");
    advance(); event(OsEventTypeList.DOUBLE_CLICK_EVENT); expect(actions.endCall).toHaveBeenCalledOnce(); expect(actions.doubleTap).toHaveBeenCalledOnce(); expect(model.awake).toBe(true); expect(model.callActive).toBe(false);
  });
  it("ignores every hold when blank without an owned active call, including a disconnected call", () => {
    const { model, actions, event, disconnect } = setup(); model.sleepDisplay(); disconnect();
    for (const source of [EventSourceType.TOUCH_EVENT_FROM_GLASSES_L, EventSourceType.TOUCH_EVENT_FROM_GLASSES_R, EventSourceType.TOUCH_EVENT_FROM_RING]) event(OsEventTypeList.LONG_PRESS_EVENT, source);
    expect(actions.hold).not.toHaveBeenCalled(); expect(actions.switchMode).not.toHaveBeenCalled(); expect(model.awake).toBe(false);
  });
  it("wakes an idle text mode without changing the selected input or the history position", () => {
    const { model, actions, event } = setup(false); model.inputMode = "text";
    model.textReply("1", "以前の文章"); model.textReply("2", "新しい文章"); model.select("1"); model.sleepDisplay();
    event(OsEventTypeList.DOUBLE_CLICK_EVENT); expect(actions.doubleTap).toHaveBeenCalledOnce();
    expect(model.inputMode).toBe("text"); expect(model.selectedId).toBe("1"); expect(model.awake).toBe(true);
  });
  it("still wakes for new Dot speech or messages after double-tap sleep", () => {
    const { model, event, advance } = setup(false); event(OsEventTypeList.DOUBLE_CLICK_EVENT); expect(model.awake).toBe(false);
    model.incoming({ id: "new", sequence: 1, text: "おかえり", receivedAt: 1 }); expect(model.awake).toBe(true);
    advance(); event(OsEventTypeList.DOUBLE_CLICK_EVENT); expect(model.awake).toBe(false);
    model.wakeFromDot(); expect(model.awake).toBe(true);
  });
});
describe("Dots Phone G2 modes and message navigation", () => {
  const message = (id: number, text = `文章${id}`) => ({ id: String(id), sequence: id, text, receivedAt: id });
  it("toggles only the display while preserving the call, text mode and ASR draft", () => {
    const model = new DotsModel(); model.inputMode = "text"; model.pendingTranscript = true; model.transcript = "送信前の文章";
    model.toggleDisplay(); expect(model.awake).toBe(false); expect(model.pendingTranscript).toBe(true);
    model.toggleDisplay(); expect(model.awake).toBe(true); expect(model.inputMode).toBe("text"); expect(model.transcript).toBe("送信前の文章");
    model.callActive = true; model.inputMode = "phone"; model.toggleDisplay(); expect(model.callActive).toBe(true); expect(model.inputMode).toBe("phone");
  });
  it("traverses pages and message boundaries in both directions", () => {
    const model = new DotsModel(); model.incoming(message(1, Array.from({ length: 12 }, (_, i) => `行${i}`).join("\n"))); model.incoming(message(2));
    model.scroll(1); expect(model.selectedId).toBe("1"); expect(model.viewport.page).toBe(3);
    model.scroll(1); expect(model.viewport.page).toBe(2); model.scroll(1); expect(model.viewport.page).toBe(1); expect(model.canOlder).toBe(false);
    model.scroll(-1); model.scroll(-1); model.scroll(-1); expect(model.selectedId).toBe("2"); expect(model.canNewer).toBe(false);
  });
  it("jumps to the latest message when a new message wakes the display", () => {
    const model = new DotsModel(); model.incoming(message(1)); model.incoming(message(2)); model.select("1"); model.awake = false;
    model.incoming(message(3)); expect(model.awake).toBe(true); expect(model.reply).toBe("文章3"); expect(model.unread).toBe(0);
    model.latest(); expect(model.selectedId).toBe("3"); expect(model.unread).toBe(0);
    expect(new DotsModel(model.save()).selectedId).toBe("3");
  });
  it("upserts ASR replies and merges duplicate notification paths without moving the sync cursor", () => {
    const model = new DotsModel(); model.textReply("reply", "途中"); model.textReply("reply", "返答全文");
    expect(model.history).toHaveLength(1); expect(model.cursor).toBe(0);
    model.textReply("2", "新着"); model.awake = false; expect(model.incoming(message(2, "新着"))).toBe(false);
    expect(model.cursor).toBe(2); expect(model.history).toHaveLength(2); expect(model.awake).toBe(false);
    const restored = new DotsModel(model.save()); expect(restored.history[0]?.text).toBe("返答全文");
  });
  it("keeps a valid selection when its retained message expires", () => {
    const model = new DotsModel(); model.incoming(message(1)); model.incoming(message(2)); model.select("1");
    for (let i = 3; i <= 101; i++) model.incoming(message(i));
    expect(model.history).toHaveLength(100); expect(model.selectedId).toBe("2"); expect(model.unread).toBe(99);
  });
});
describe("Dots Phone G2 shared native microphone", () => {
  it("waits for telephone input to close before opening text capture", async () => {
    const closing = deferred(), control = vi.fn(async (enabled: boolean) => { if (!enabled) await closing.promise; }), mic = new OwnedMicrophone(control);
    await mic.set(true, "phone"); const close = mic.set(false, "phone"); const open = mic.set(true, "text"); await flush();
    expect(mic.activeRoute).toBe("phone");
    expect(control).toHaveBeenCalledTimes(2); closing.resolve(); await close; await open;
    expect(mic.activeRoute).toBe("text");
    expect(control).toHaveBeenNthCalledWith(3, true, "text");
  });
  it("refuses concurrent capture and ignores a stale close from the other route", async () => {
    const control = vi.fn(async () => {}), mic = new OwnedMicrophone(control); await mic.set(true, "phone");
    await expect(mic.set(true, "text")).rejects.toThrow("使用中"); await mic.set(false, "phone"); await mic.set(true, "text"); await mic.set(false, "phone");
    expect(control).toHaveBeenCalledTimes(3); expect(control).toHaveBeenLastCalledWith(true, "text");
  });
  it("retains a failed native open for cleanup before allowing the other route", async () => {
    const control = vi.fn().mockRejectedValueOnce(new Error("open failed")).mockResolvedValue(undefined), mic = new OwnedMicrophone(control);
    await expect(mic.set(true, "phone")).rejects.toThrow("open failed"); expect(mic.activeRoute).toBe("phone"); await expect(mic.set(true, "text")).rejects.toThrow("使用中");
    await mic.set(false, "phone"); await mic.set(true, "text"); expect(control).toHaveBeenNthCalledWith(2, false, "phone");
  });
});

class FakeSocket {
  binaryType = ""; bufferedAmount = 0; readyState = 1;
  onopen?: () => void; onmessage?: (event: { data: unknown }) => void; onclose?: (event: { code: number }) => void; onerror?: () => void;
  sent: (string | Uint8Array)[] = [];
  send(value: string | Uint8Array) { this.sent.push(value); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  message(value: unknown) { this.onmessage?.({ data: typeof value === "object" && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value }); }
}
describe("Dots Phone G2 voice wire", () => {
  function setup() {
    const sockets: FakeSocket[] = [], audio = vi.fn(), message = vi.fn(), closed = vi.fn(), inputCongested = vi.fn(), inputRecovered = vi.fn();
    const client = new PhoneSocket("ws://mac.example.invalid/voice/ws", { type: "voice.hello", version: 1, token: "secret" }, { audio, message, closed, inputCongested, inputRecovered }, () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as WebSocket; });
    client.connect(); sockets[0]!.onopen?.(); sockets[0]!.message({ type: "voice.ready", version: 1 });
    return { client, sockets, audio, closed, inputCongested, inputRecovered };
  }
  const meta = { type: "audio.chunk", streamId: "s1", route: "original", format: "pcm_s16le", sampleRate: 48000, channels: 2, byteLength: 7680 };
  it("pairs metadata with one binary frame and validates the length", () => {
    const { sockets, audio } = setup(); sockets[0]!.message(meta); sockets[0]!.message(new ArrayBuffer(7680)); expect(audio).toHaveBeenCalledOnce();
    sockets[0]!.message(meta); sockets[0]!.message(new ArrayBuffer(2)); expect(sockets[0]!.readyState).toBe(3); expect(audio).toHaveBeenCalledOnce();
  });
  it("rejects pending commands on reconnect and never replays a call start", async () => {
    const { client, sockets } = setup(); const result = client.request("session.start"); const rejected = expect(result).rejects.toThrow("接続が切れ");
    sockets[0]!.close(); await rejected; client.tick(Date.now() + 3000); sockets[1]!.onopen?.();
    expect(sockets[1]!.sent).toHaveLength(1); expect(JSON.parse(sockets[1]!.sent[0] as string).type).toBe("voice.hello");
  });
  it("splits microphone chunks at 200ms and preserves held PTT when live audio stalls", () => {
    const { client, sockets, closed, inputCongested, inputRecovered } = setup(); expect(client.sendPcm(new Uint8Array(10000))).toBe(true);
    expect(sockets[0]!.sent.filter(v => v instanceof Uint8Array).map(v => (v as Uint8Array).length)).toEqual([6400, 3600]);
    const count = sockets[0]!.sent.length;
    sockets[0]!.bufferedAmount = 15900;
    for (let i = 0; i < 100; i++) expect(client.sendPcm(new Uint8Array(640))).toBe(true);
    expect(sockets[0]!.sent).toHaveLength(count); expect(inputCongested).toHaveBeenCalledOnce(); expect(closed).not.toHaveBeenCalled();
    sockets[0]!.bufferedAmount = 0; expect(client.sendPcm(new Uint8Array(640))).toBe(true);
    expect(inputRecovered).toHaveBeenCalledExactlyOnceWith(64000); expect(sockets[0]!.sent).toHaveLength(count + 1);
  });
  it("still reports congested ASR input instead of silently dropping recognized speech", () => {
    const socket = new FakeSocket(); const client = new PhoneSocket("ws://mac.example.invalid/ws", { type: "hello", version: 16, client: "dots" }, { message: vi.fn(), closed: vi.fn() }, () => socket as unknown as WebSocket);
    client.connect(); socket.onopen?.(); socket.message({ type: "echo.snapshot" }); socket.bufferedAmount = 15900;
    expect(client.sendPcm(new Uint8Array(640))).toBe(false); expect(socket.sent.filter(v => v instanceof Uint8Array)).toEqual([]);
  });
  it("receives half-sized 48kHz mono output without changing playback rate", () => {
    const { sockets, audio } = setup(); sockets[0]!.message({ ...meta, channels: 1, byteLength: 3840 }); sockets[0]!.message(new ArrayBuffer(3840));
    expect(audio).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 48000, channels: 1 }), expect.any(Uint8Array));
  });
  it("does not retry an authentication rejection", () => { const { client, sockets } = setup(); sockets[0]!.close(4401); client.tick(Date.now() + 10000); expect(sockets).toHaveLength(1); });
  it("authenticates the dedicated Dot text protocol and forwards audio with its own id", () => {
    const socket = new FakeSocket(), message = vi.fn();
    const client = new PhoneSocket("ws://mac.example.invalid/ws", { type: "hello", version: 16, client: "dots" }, { message, closed: vi.fn() }, () => socket as unknown as WebSocket);
    client.connect(); socket.onopen?.(); expect(client.ready).toBe(false); socket.message({ type: "echo.snapshot", snapshot: {} }); expect(client.ready).toBe(true);
    socket.message({ type: "echo.audio", id: "clip:1", audioBase64: "AA==" }); expect(message).toHaveBeenLastCalledWith({ type: "echo.audio", id: "clip:1", audioBase64: "AA==" });
  });
  it("rejects a stalled command without replaying it on a live socket", async () => {
    const { client, sockets } = setup(); const promise = client.request("session.start");
    const rejected = expect(promise).rejects.toThrow("時間内に完了");
    client.tick(Date.now() + 121000); await rejected;
    expect(client.ready).toBe(true); expect(sockets[0]!.sent.filter(v => typeof v === "string" && JSON.parse(v).method === "session.start")).toHaveLength(1);
  });
  it("probes state on return without restarting a call and reconnects a silent link", async () => {
    const { client, sockets } = setup(); client.probe(); const sent = sockets[0]!.sent.map(v => typeof v === "string" ? JSON.parse(v) : {});
    expect(sent.at(-1).method).toBe("status"); expect(sent.some(v => v.method === "session.start")).toBe(false);
    client.tick(Date.now() + 11_000); await flush(); expect(client.ready).toBe(false); client.tick(Date.now() + 14_000); expect(sockets).toHaveLength(2);
  });
});
describe("Dots Phone G2 overlay recovery", () => {
  function heldPtt(native = Promise.resolve()) {
    const model = new DotsModel(); model.callActive = true; let now = 0;
    const route: TalkRoute = { ensureCall: vi.fn(async () => {}), owned: () => true, setInput: vi.fn(async () => {}), microphone: vi.fn(enabled => enabled ? native : Promise.resolve()), changed: vi.fn(), error: vi.fn() };
    const ptt = new PhonePushToTalk(route), resume = vi.fn();
    const lifecycle = new OverlayLifecycle({ overlay: vi.fn(), resume }, () => now);
    const controls = new DotsControls({ awake: () => model.awake, ownedCall: () => true, canEndCall: () => false, endCall: vi.fn(), switchMode: vi.fn(), discardAsr: vi.fn(), submitAsr: vi.fn(), doubleTap: vi.fn(), tap: vi.fn(), scroll: vi.fn(), hold: source => ptt.hold(source), release: source => { void ptt.release(source); } }, () => now);
    const event = (type: OsEventTypeList) => { if (!lifecycle.handle(type) && lifecycle.accepts(type)) controls.route({ jsonData: { eventType: type, eventSource: EventSourceType.TOUCH_EVENT_FROM_GLASSES_L } }); };
    return { model, route, ptt, lifecycle, resume, event, time: (value: number) => { now = value; } };
  }
  it("keeps an active PTT through notification entry and exit, then accepts release during the return grace", async () => {
    const { model, route, ptt, lifecycle, event, time } = heldPtt(); event(OsEventTypeList.LONG_PRESS_EVENT); await flush();
    expect(ptt.recording).toBe(true);
    event(OsEventTypeList.FOREGROUND_ENTER_EVENT); event(OsEventTypeList.FOREGROUND_ENTER_EVENT);
    expect(ptt.recording).toBe(true); expect(route.microphone).not.toHaveBeenCalledWith(false);
    event(OsEventTypeList.FOREGROUND_EXIT_EVENT); expect(ptt.recording).toBe(true); expect(model.callActive).toBe(true);
    time(100); expect(lifecycle.acceptsGesture).toBe(false); event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT); await flush();
    expect(ptt.recording).toBe(false); expect(route.microphone.mock.calls).toEqual([[true], [false]]);
    expect(route.setInput.mock.calls).toEqual([[true], [false]]);
  });
  it("accepts physical release during the overlay while blocking new holds and other gestures", async () => {
    const { route, ptt, lifecycle, event } = heldPtt(); event(OsEventTypeList.LONG_PRESS_EVENT); await flush();
    event(OsEventTypeList.FOREGROUND_ENTER_EVENT);
    for (const type of [OsEventTypeList.CLICK_EVENT, OsEventTypeList.DOUBLE_CLICK_EVENT, OsEventTypeList.SCROLL_TOP_EVENT, OsEventTypeList.LONG_PRESS_EVENT]) expect(lifecycle.accepts(type)).toBe(false);
    event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT); await flush(); expect(ptt.recording).toBe(false); expect(route.microphone).toHaveBeenLastCalledWith(false);
    event(OsEventTypeList.LONG_PRESS_EVENT); await flush(); expect(route.microphone.mock.calls).toEqual([[true], [false]]);
  });
  it("allows a pending microphone open to finish when a notification arrives", async () => {
    const native = deferred(), { route, ptt, event } = heldPtt(native.promise);
    event(OsEventTypeList.LONG_PRESS_EVENT); await flush(); expect(route.microphone).toHaveBeenCalledWith(true);
    event(OsEventTypeList.FOREGROUND_ENTER_EVENT); native.resolve(); await flush(); expect(ptt.recording).toBe(true);
    expect(route.microphone).not.toHaveBeenCalledWith(false); event(OsEventTypeList.LONG_PRESS_RELEASE_EVENT); await flush(); expect(ptt.recording).toBe(false);
  });
  it("releases a lost hold at the existing deadline, without ending native holds on phone pagehide", async () => {
    const { route, ptt, event } = heldPtt(); event(OsEventTypeList.LONG_PRESS_EVENT); await flush();
    await ptt.release("phone"); expect(ptt.recording).toBe(true); expect(route.microphone).not.toHaveBeenCalledWith(false);
    event(OsEventTypeList.FOREGROUND_ENTER_EVENT); event(OsEventTypeList.FOREGROUND_EXIT_EVENT);
    ptt.tick(Date.now() + 26_000); await flush(); expect(ptt.recording).toBe(true);
    ptt.tick(Date.now() + 60_000); await flush(); expect(ptt.recording).toBe(false); expect(route.microphone).toHaveBeenLastCalledWith(false);
  });
  it("restores native gesture capture on explicit invalidation without dismissing an OS overlay", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async (_page: ReturnType<typeof buildDotsPage>) => true), textContainerUpgrade: vi.fn(async () => true), updateImageRawData: vi.fn(async () => ImageRawDataUpdateResult.success) };
    const glasses = new DotsGlasses(api as unknown as EvenAppBridge), model = new DotsModel(); await glasses.initialize(model);
    const before = api.rebuildPageContainer.mock.calls.length;
    glasses.restoreCapture(); expect(await glasses.render(model)).toBe(true);
    expect(api.rebuildPageContainer.mock.calls.length).toBe(before + 1);
    expect(api.rebuildPageContainer.mock.calls.at(-1)?.[0]?.textObject?.some(v => v.isEventCapture === 1)).toBe(true);
    glasses.setOverlayVisible(true); glasses.restoreCapture(); expect(await glasses.render(model)).toBe(false);
    expect(api.rebuildPageContainer.mock.calls.length).toBe(before + 1);
  });
  it("pauses native rendering on overlay ENTER and restores it on EXIT, then accepts gestures", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async (_page: ReturnType<typeof buildDotsPage>) => true), textContainerUpgrade: vi.fn(async () => true), updateImageRawData: vi.fn(async () => ImageRawDataUpdateResult.success) };
    const glasses = new DotsGlasses(api as unknown as EvenAppBridge), model = new DotsModel(); await glasses.initialize(model);
    const resume = vi.fn(); let time = 0;
    const lifecycle = new OverlayLifecycle({ overlay: visible => glasses.setOverlayVisible(visible), resume }, () => time);
    expect(lifecycle.handle(OsEventTypeList.FOREGROUND_ENTER_EVENT)).toBe(true); expect(lifecycle.acceptsGesture).toBe(false); expect(await glasses.render(model)).toBe(false);
    lifecycle.handle(OsEventTypeList.FOREGROUND_EXIT_EVENT); expect(resume).toHaveBeenCalledOnce(); expect(await glasses.render(model)).toBe(true);
    time = 500; expect(lifecycle.acceptsGesture).toBe(true); expect(api.rebuildPageContainer.mock.calls.at(-1)?.[0]?.textObject?.filter(v => v.isEventCapture === 1)).toHaveLength(1);
  });
});
describe("Dots Phone G2 native display", () => {
  it("counts actual display requests and performs no repeat transfers during idle sleep", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const power = new PowerDiagnostics(), model = new DotsModel();
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true), updateImageRawData: vi.fn(async () => ImageRawDataUpdateResult.success) };
    const glasses = new DotsGlasses(api as unknown as EvenAppBridge, (kind, awake) => power.transfer(kind, awake));
    await glasses.initialize(model); await glasses.animate(model, 0, 0);
    model.sleepDisplay(); await glasses.render(model);
    const before = power.snapshot();
    for (let i = 0; i < 100; i++) { model.notice = `状態${i}`; await glasses.render(model); await glasses.animate(model, i, 1); }
    expect(power.snapshot().transfers).toEqual(before.transfers);
    expect(power.snapshot().sleepTransfers).toEqual({ page: 1, image: 0, text: 0 });
    model.incoming({ id: "wake", sequence: 1, text: "おかえり", receivedAt: 1 }); await glasses.render(model); await glasses.animate(model, 100, 0);
    expect(power.snapshot().transfers.page).toBe(before.transfers.page + 1);
    expect(power.snapshot().transfers.image).toBeGreaterThan(before.transfers.image);
  });
  it("stops queued animation and text at PTT intent, even while an image transfer is in flight", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const body = deferred();
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async (_page: ReturnType<typeof buildDotsPage>) => true), textContainerUpgrade: vi.fn(async () => true), updateImageRawData: vi.fn().mockImplementationOnce(async () => { await body.promise; return ImageRawDataUpdateResult.success; }).mockResolvedValue(ImageRawDataUpdateResult.success) };
    const glasses = new DotsGlasses(api as unknown as EvenAppBridge), model = new DotsModel(); await glasses.initialize(model);
    const animation = glasses.animate(model, 1, 0); await flush(); expect(api.updateImageRawData).toHaveBeenCalledOnce();
    const textCount = api.textContainerUpgrade.mock.calls.length;
    model.setActivity("arming"); const queued = glasses.render(model); glasses.setInputPending(true);
    await glasses.animate(model, 2, 0); body.resolve(); await animation;
    expect(await queued).toBe(false); expect(await glasses.render(model)).toBe(false);
    expect(api.updateImageRawData).toHaveBeenCalledOnce(); expect(api.textContainerUpgrade.mock.calls.length).toBe(textCount);
    glasses.setMicrophone(true); glasses.setInputPending(false); model.setActivity("recording");
    expect(await glasses.render(model)).toBe(true); await glasses.animate(model, 5, 0);
    expect(api.updateImageRawData).toHaveBeenCalledOnce();
    glasses.setMicrophone(false); await glasses.animate(model, 6, 0);
    expect(api.updateImageRawData.mock.calls.length).toBeGreaterThan(1);
  });
  it("fits G2 geometry, assigns one gesture target and preserves gray4 transport", () => {
    const page = buildDotsPage(new DotsModel()); expect(validateEvenHubPageContainerZOrder(page).valid).toBe(true);
    expect(page.textObject!.filter(v => v.isEventCapture === 1)).toHaveLength(1);
    for (const item of [...page.textObject!, ...page.imageObject!]) { expect(item.xPosition + item.width).toBeLessThanOrEqual(576); expect(item.yPosition + item.height).toBeLessThanOrEqual(288); }
    expect(buildDotsSleepPage().textObject![0]!.content).toBe("");
    expect(dotGray4(dotPose("idle", 0))).toHaveLength(144 * 144 / 2);
    expect(dotGray4(dotPose("listening", 1), EYES)).toHaveLength(EYES.width * EYES.height / 2);
  });
  it("discards stale sleep renders when a message wakes the display", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async (_page: ReturnType<typeof buildDotsPage>) => true), textContainerUpgrade: vi.fn(async () => true), updateImageRawData: vi.fn(async () => ImageRawDataUpdateResult.success) };
    const glasses = new DotsGlasses(api as unknown as EvenAppBridge), model = new DotsModel(); await glasses.initialize(model);
    model.awake = false; const sleep = glasses.render(model);
    model.incoming({ id: "new", sequence: 1, text: "おかえり", receivedAt: 1 }); const awake = glasses.render(model);
    expect(await sleep).toBe(false); expect(await awake).toBe(true);
    expect(api.rebuildPageContainer).not.toHaveBeenCalled(); // Startup remains valid when sleep was discarded.
  });
  it("keeps the startup page and full body stable through both call and text state updates", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    for (const mode of ["phone", "text"] as const) {
      const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async (_page: ReturnType<typeof buildDotsPage>) => true), textContainerUpgrade: vi.fn(async () => true), updateImageRawData: vi.fn(async (_image: { containerID?: number }) => ImageRawDataUpdateResult.success) };
      const glasses = new DotsGlasses(api as unknown as EvenAppBridge), model = new DotsModel(); model.inputMode = mode; model.animateCharacter = true; await glasses.initialize(model);
      expect(api.rebuildPageContainer).not.toHaveBeenCalled(); expect(api.textContainerUpgrade).not.toHaveBeenCalled();
      for (let t = 0; t < 20; t++) { model.phase = t % 2 ? "speaking" : "thinking"; await glasses.render(model); await glasses.animate(model, t, .7); }
      expect(api.rebuildPageContainer).not.toHaveBeenCalled();
      expect(api.updateImageRawData.mock.calls.filter(([image]) => image.containerID === 22)).toHaveLength(1);
      expect(api.updateImageRawData.mock.calls.filter(([image]) => image.containerID === 23).length).toBeGreaterThan(1);
      model.sleepDisplay(); await glasses.render(model); model.wakeDisplay(); await glasses.render(model); await glasses.animate(model, 30, 0);
      expect(api.rebuildPageContainer).toHaveBeenCalledTimes(2);
      expect(api.updateImageRawData.mock.calls.filter(([image]) => image.containerID === 22)).toHaveLength(2);
    }
  });
  it("backs off failed native image transfers instead of flooding a disconnected device", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true), updateImageRawData: vi.fn().mockResolvedValueOnce(ImageRawDataUpdateResult.sendFailed).mockResolvedValue(ImageRawDataUpdateResult.success) };
    const glasses = new DotsGlasses(api as unknown as EvenAppBridge), model = new DotsModel(); await glasses.initialize(model);
    await expect(glasses.animate(model, 0, 0)).rejects.toThrow("image transfer failed");
    await glasses.animate(model, 1, 0); expect(api.updateImageRawData).toHaveBeenCalledOnce();
    await glasses.animate(model, 4, 0); expect(api.updateImageRawData).toHaveBeenCalledTimes(3);
  });
  it("keeps sleep as the final page when waking was already in flight, then sends no repeat updates", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const api = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async (_page: ReturnType<typeof buildDotsPage>) => true), textContainerUpgrade: vi.fn(async () => true), updateImageRawData: vi.fn(async () => ImageRawDataUpdateResult.success) };
    const glasses = new DotsGlasses(api as unknown as EvenAppBridge), model = new DotsModel(); await glasses.initialize(model);
    model.sleepDisplay(); await glasses.render(model);
    const waking = deferred(); api.rebuildPageContainer.mockImplementationOnce(async () => { await waking.promise; return true; });
    model.wakeDisplay(); const on = glasses.render(model); await flush();
    model.sleepDisplay(); const off = glasses.render(model); waking.resolve(); await on; expect(await off).toBe(true);
    expect(api.rebuildPageContainer.mock.calls.at(-1)?.[0]?.containerTotalNum).toBe(1);
    const rebuilds = api.rebuildPageContainer.mock.calls.length, texts = api.textContainerUpgrade.mock.calls.length;
    for (let i = 0; i < 100; i++) { model.setActivity(i % 2 ? "recording" : "ready"); await glasses.render(model); await glasses.animate(model, i, 1); }
    expect(api.rebuildPageContainer).toHaveBeenCalledTimes(rebuilds); expect(api.textContainerUpgrade).toHaveBeenCalledTimes(texts);
    expect(api.updateImageRawData).not.toHaveBeenCalled();
  });
});
