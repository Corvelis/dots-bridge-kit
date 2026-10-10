import { CONNECTION_SETTINGS_KEY, connectionEndpoints, connectionFromBaseUrl, decodeConnection } from "./connection-settings";
import "./styles.css";
import { AudioInputSource, EventSourceType, MenuItemClickEvent, OsEventTypeList, waitForEvenAppBridge, type DeviceStatus, type EvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { gestureEventType } from "../../src/gestures";
import { withFrameTimeout } from "../../src/frame-timeout";
import { PcmStreamPlayer } from "../../shared/audio/pcm-player";
import { DotsGlasses } from "./glasses";
import { DOT_SIZE, FIXED_DOT_POSE, dotGray4, dotPose, dotGlassesPose, drawPinkDot } from "./avatar";
import { DotsModel, type SavedInbox } from "./model";
import { PhoneSocket, type AudioFrame, type WireMessage } from "./socket";
import { synchronizeInbox } from "./inbox";
import { PhonePushToTalk, type PttTiming } from "./push-to-talk";
import { SpeechWake } from "./speech-wake";
import { PROTOCOL_VERSION, type ServerMessage } from "../../shared/protocol";
import { TextVoiceSession } from "./text-voice";
import { OwnedMicrophone, restorePhonePlayback } from "./microphone";
import { OverlayLifecycle } from "./lifecycle";
import { DotsControls } from "./controls";
import { voiceResumeKey } from "./client-identity";
import { DisplayWork } from "./display-work";
import { AutoOff, autoOffSeconds } from "./auto-off";
import { IdleAudioGuard } from "./idle-audio";
import { DeviceConnectionLifecycle } from "./device-lifecycle";
import { PowerDiagnostics } from "./power-diagnostics";
import { InputModeSwitch } from "./input-mode";
import { buildDotsMenu, DOTS_MENU_ITEM_ID } from "./menu";
import { SettingsStore, type NativeSettingsStorage } from "./settings-store";
import { DEFAULT_PREFERENCES, decodePreferences } from "./preferences";

const preview = new URLSearchParams(location.search).has("preview");
const storageKey = "dots-phone-g2.inbox.v1";
function storedInbox(): SavedInbox | undefined { try { return JSON.parse(localStorage.getItem(storageKey) || "null") ?? undefined; } catch { return undefined; } }
const model = new DotsModel(preview ? undefined : storedInbox());
if (preview) model.hud.observeBattery(78);
// Restore app settings before creating sockets or the glasses display.
if (!preview) document.querySelector<HTMLDivElement>("#app")!.innerHTML = '<main><p role="status">設定を読み込んでいます…</p></main>';
const startupBridge = preview ? undefined : await withFrameTimeout(waitForEvenAppBridge(), "Even App", 10000).catch(() => undefined);
let settingsStorage: Storage | undefined;
try { settingsStorage = localStorage; } catch { /* Native storage can still work. */ }
const nativeSettings: NativeSettingsStorage | undefined = startupBridge && {
  getLocalStorage: key => withFrameTimeout(startupBridge.getLocalStorage(key), "設定の復元", 3000),
  setLocalStorage: (key, value) => withFrameTimeout(startupBridge.setLocalStorage(key, value), "設定の保存", 3000),
};
const preferencesStore = new SettingsStore("dots-phone-g2.preferences.v1", DEFAULT_PREFERENCES, decodePreferences, settingsStorage, Date.now, "dots-bridge-kit.preferences.v1");
const preferences = await preferencesStore.load(nativeSettings);
model.inputMode = preferences.inputMode;
model.screenSide = preferences.screenSide;
model.animateCharacter = preferences.animateCharacter;
model.setHistoryLimit(preferences.historyLimit);
let reviewTranscript = preferences.reviewTranscript, displayOffSeconds = preferences.displayOffSeconds;
function savePreferences(): void { void preferencesStore.save({ historyLimit: model.historyLimit, animateCharacter: model.animateCharacter, screenSide: model.screenSide, inputMode: model.inputMode, reviewTranscript, displayOffSeconds }).catch(notice); }
if (preferencesStore.restoreError) model.notice = "設定の復元に失敗しました。アプリを開き直してください";
const autoOff = new AutoOff(displayOffSeconds);
const power = new PowerDiagnostics();
let observedAwake = model.awake, observedHistory = model.historyRevision;
const wake = new SpeechWake();
let bridge: EvenAppBridge | undefined, glasses: DotsGlasses | undefined;
let clientId: string | undefined, state: WireMessage = { phase: "idle", owner: null, browserOnline: false };
let startPending: Promise<void> | undefined, stopPending: Promise<void> | undefined, activeStream: string | undefined;
let disposed = false, userTalking = false, lastAudioAt = 0, renderPending = false, renderAgain = false, previewEnergy = 0;
let phoneVisible = !document.hidden, lastCanvasAwake: boolean | undefined, visualTicks = 0;
let historyRevision = -1, renderedHistoryLimit = -1, historySelection: string | undefined;
let fixedPinkPainted = false, fixedG2Image: ImageData | undefined;
let lastResumeAt = -Infinity;
const inputTransitions = new Set<"phone" | "text">();
let lastPttTiming: (PttTiming & { route: "phone" | "text"; firstPcmMs?: number }) | undefined;
let lastEndSeen = 0;
const env = import.meta.env;
const packagedBase = document.querySelector<HTMLMetaElement>('meta[name="dots-bridge-base-url"]')?.content;
const connectionDefaults = {
  voiceUrl: env.VITE_DOTS_PHONE_URL || "ws://127.0.0.1:8799/voice/ws",
  inboxUrl: env.VITE_DOTS_NOTIFICATION_URL || "ws://127.0.0.1:8799/dots/ws",
  textVoiceUrl: env.VITE_DOTS_TEXT_VOICE_URL || "ws://127.0.0.1:8799/ws", token: "",
  ...(packagedBase ? connectionEndpoints(packagedBase) : {}),
};
const connectionStore = new SettingsStore(CONNECTION_SETTINGS_KEY, connectionDefaults, decodeConnection, settingsStorage);
const connectionSettings = await connectionStore.load(nativeSettings);
if (connectionStore.restoreError) model.notice = "接続設定の復元に失敗しました。アプリを開き直してください";
const { voiceUrl, inboxUrl, textVoiceUrl, token } = connectionSettings;
let identityStorage: Storage | undefined;
try { identityStorage = sessionStorage; } catch { /* Keep identity in memory if storage is unavailable. */ }
const resumeKey = preview ? undefined : voiceResumeKey(identityStorage);

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main><header><span class="wordmark">dots <small>PHONE / G2</small></span><span id="connection" class="badge">接続待ち</span></header>
  <details id="connection-settings"><summary>Macへの接続設定</summary><form id="connection-form">
    <label>Macの接続先<input id="connection-base" type="url" placeholder="ws://YOUR_MAC_HOST:8799" required></label>
    <label>ペアリングトークン<input id="connection-token" type="password" autocomplete="off" required></label>
    <button type="submit">保存して接続</button><p class="hint">Macで npm run token を実行してトークンを入力します。設定はこのアプリ内に保存します。</p>
  </form></details>
  <section class="companion"><canvas id="pink" width="144" height="144" aria-label="口のない丸いDotsキャラクター"></canvas><h1>ここにいるよ。</h1><p id="phase">あなたのdotと、声でつながる。</p></section>
  <section class="activity-card" aria-live="polite"><div class="activity-top"><span>DOT / VOICE LINK</span><span id="activity-code">READY</span></div><strong id="activity-label">待機中</strong><p id="activity-detail"></p><div id="activity-steps" class="activity-steps" hidden><span>READY</span><span>REC</span><span>ASR</span><span>DOT</span></div><div class="activity-bottom"><span id="activity-time"></span><span id="audio-status"></span></div></section>
  <section class="input-modes" aria-label="入力方法"><button id="phone-mode">電話</button><button id="text-mode">音声→テキスト</button></section>
  <section class="controls"><button id="call" class="primary">通話を始める</button><button id="end">通話を終える</button><button id="hold">長押しで話す</button><button id="cancel-text" hidden>入力・返答を中止</button><button id="screen">表示をオフ</button><button id="output">音声をオン</button></section>
  <p id="gesture-hint" class="hint">G2左 / R1長押しで話す · G2右長押しで入力切替<br>2タップで消灯 / 点灯 · 消灯中も通話PTTを維持<br>タップ→長押しでメニュー · スワイプで履歴</p>
  <section id="asr-card" class="asr-card" hidden aria-live="polite"><div class="activity-top"><span>YOUR VOICE / ASR</span><span id="asr-label"></span></div><p id="transcript"></p><p id="asr-hint" class="hint"></p><div id="asr-actions" class="controls" hidden><button id="asr-send" class="primary">Dotに送信</button><button id="asr-discard">送信せず破棄</button></div></section>
  <section class="display"><div class="section-label">EVEN G2 <span>576 × 288</span></div><canvas id="g2" width="576" height="288" aria-label="Even G2表示プレビュー"></canvas></section>
  <section id="message-card" class="message"><span id="message-label" class="section-label">DOTからのメッセージ</span><p id="reply">ここにいるよ。長押しで話してね。</p><div class="pager"><button id="prev">前へ</button><span id="page"></span><button id="next">次へ</button><button id="latest">最新へ</button></div></section>
  <p id="notice" role="status"></p>
  <details id="operation-settings"><summary>操作・表示の設定</summary><label class="switch"><input id="character-animation" type="checkbox">キャラを動かす</label><p class="hint">初期値は固定表示です。オンにするとまばたきや視線の動きが付きます。</p><label>G2の左右の操作<select id="screen-side"><option value="right">右：画面オフ／左：通常操作</option><option value="left">左：画面オフ／右：通常操作</option></select></label><p class="hint">画面オフ側は2タップで消灯・点灯、長押しで入力モード切替。点灯中の通話終了は左右設定に関係なくG2右の2タップです。消灯中の2タップは点灯を優先します。通常操作側はタップ・スワイプ・長押しPTTを使えます。消灯中は接続済み通話のPTTを両側で使えます。</p><label>履歴の最大表示数<select id="history-limit"><option value="10">10件</option><option value="30">30件</option><option value="50">50件</option><option value="100">100件</option></select></label><p class="hint">G2とスマホの履歴に適用します。初期値は100件。件数を減らしても直近100件は保持し、設定を戻すと再表示できます。</p><label>G2画面の自動オフ<select id="auto-off"><option value="0">無効</option><option value="15">15秒</option><option value="30">30秒</option><option value="60">1分</option><option value="120">2分</option><option value="300">5分</option></select></label><p class="hint">操作や新着からの待機時間です。録音・返答処理・送信確認中は消灯しません。通話は継続し、Dotからの話しかけで自動点灯します。</p><label class="switch"><input id="asr-review" type="checkbox">ASR結果を確認してからDotに送信する</label><p id="asr-setting-hint" class="hint">オフなら自動送信。オンならG2に結果を表示し、G2／R1の長押しで送信・2タップで破棄します。メニューも使えます。電話には適用しません。</p></details>
  <details id="history-details"><summary>メッセージ履歴</summary><div id="history"></div></details>
  <details><summary>PTT開始の診断</summary><p class="hint">長押しがアプリへ届いてからの時間を測ります。</p><pre id="ptt-timing">長押しで話すと記録します。</pre></details>
  <details id="power-details"><summary>消灯中・電池の診断</summary><p class="hint">このアプリを開いてからの記録です。G2の電池通知を利用し、追加の問い合わせは行いません。時間はアプリの表示・マイク状態です。</p><pre id="power-status"></pre></details>
  <footer id="setup">通話と音声→テキストは、同じMacのDots Bridge Kitへ接続します。<br>通話の音声はスマホのスピーカーや接続中のイヤホンから再生します。</footer>
  ${preview ? `<section id="demo"><span class="section-label">表示の確認</span><div class="controls"><button id="demo-input">あなたの入力</button><button data-demo="idle">待機</button><button data-demo="listening">録音</button><button data-demo="transcribing">文字変換</button><button data-demo="reviewing">ASR送信確認</button><button data-demo="thinking">返答待ち</button><button data-demo="speaking">再生</button><button data-demo="incoming">dotから話しかけ</button><button id="demo-double">G2ダブルタップ</button><button id="demo-double-left">G2左ダブルタップ</button><button id="demo-double-right">G2右ダブルタップ</button><button id="demo-right">G2右長押し</button><button id="demo-left">G2左長押し</button><button id="demo-release">長押しを離す</button><button id="demo-tap">G2タップ</button><button id="demo-scroll">G2スワイプ</button><button id="demo-overlay">通知を表示</button><button id="demo-resume">通知から復帰</button><button id="demo-link-lost">接続を復旧中</button><button id="demo-link-back">接続が復旧</button><button id="demo-menu-mode">メニュー: 入力切替</button><button id="demo-menu-submit">メニュー: Dotに送信</button><button id="demo-menu-discard">メニュー: ASR破棄</button><pre id="demo-menu-items"></pre></div></section>` : ""}
  </main>`;
function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function notice(error: unknown): void { model.notice = error instanceof Error ? error.message : String(error); changed(); }
function save(): void { if (!preview) try { localStorage.setItem(storageKey, JSON.stringify(model.save())); } catch { model.notice = "履歴を保存できません。空き容量を確認してください"; } }
for (const [id, value] of [["connection-base", new URL(voiceUrl).origin], ["connection-token", token]]) element<HTMLInputElement>(id!).value = value!;
if (!token && !preview) element<HTMLDetailsElement>("connection-settings").open = true;
element<HTMLFormElement>("connection-form").onsubmit = async event => {
  event.preventDefault();
  if (preview) return;
  if (state.phase !== "idle" || startPending || textSession.busy) { notice("通話・録音・返答を終えてから接続設定を変更してください"); return; }
  try {
    await connectionStore.save(connectionFromBaseUrl(element<HTMLInputElement>("connection-base").value,
      element<HTMLInputElement>("connection-token").value));
    location.reload();
  } catch (error) { notice(error); }
};
const player = new PcmStreamPlayer(() => {}, undefined, notice, true);
const textSocket = new PhoneSocket(textVoiceUrl, { type: "hello", version: PROTOCOL_VERSION, token, client: "dots" }, {
  message: message => textSession.handle(message as ServerMessage),
  closed: reason => { textSession.disconnected(); if (textRouteActive()) notice(`音声→テキスト: ${reason}`); },
});
const textSession = new TextVoiceSession(textSocket, model, {
  active: textRouteActive, review: () => reviewTranscript,
  changed: () => { save(); changed(); },
  displayed: async () => { if (glasses) await glasses.render(model); },
  error: notice, disconnected: () => { void textPtt.clear(); },
});
const voice = new PhoneSocket(voiceUrl, { type: "voice.hello", version: 1, token, resumeKey }, {
  message: onVoiceMessage, audio: onAudio,
  inputCongested() { notice("マイク転送が混雑しています。通話と長押しは継続しますが、音声が一部途切れる場合があります"); },
  inputRecovered() { notice("マイク転送が戻りました。そのまま話せます"); },
  closed(reason) {
    clientId = undefined; state = { phase: state.phase === "idle" ? "idle" : "unknown", owner: null, browserOnline: false };
    player.clearBufferedAudio("voice disconnected"); wake.reset(); void ptt.clear(); if (model.inputMode === "phone") { model.notice = reason; model.setActivity("reconnecting"); } changed();
  },
});
const inbox = new PhoneSocket(inboxUrl, { type: "dots.hello", version: 1, appId: "dots-phone-g2", token }, {
  message(message) {
    if (message.type === "dots.ready") void synchronizeInbox(inbox, model, () => { save(); changed(); }, message.conversationHistory === true).catch(notice);
    if (message.type === "dots.history") { if (model.applyConversation(message.history)) { save(); changed(); } }
    if (message.type === "dots.notification") { if (model.incoming(message.notification)) { save(); changed(); } }
    if (message.type === "dots.error") notice(message.message);
  },
  closed(reason) { if (!disposed) notice(`メッセージ: ${reason}`); },
});
const ptt = new PhonePushToTalk({
  ensureCall: async () => {
    if (preview) return;
    if (!bridge) throw new Error("マイクはEven App内で利用できます");
    if (!model.awake && !owned()) throw new Error("消灯中のPTTは接続済みの通話で使えます");
    await startCall();
  },
  owned: () => preview || owned(),
  setInput: enabled => preview ? Promise.resolve() : voice.request("audio.input", { enabled }),
  microphone: enabled => microphone(enabled, "phone"),
  changed(open) { if (!textRouteActive()) { userTalking = open; model.phase = open ? "listening" : wake.speaking ? "speaking" : "idle"; model.setActivity(phoneRecovering() ? "reconnecting" : open ? "recording" : wake.speaking ? "playing" : "ready"); changed(); } },
  error: notice,
  preparing: pending => inputPreparing("phone", pending), timing: value => recordPttTiming("phone", value),
});
const textPtt = new PhonePushToTalk({
  ensureCall: async () => {
    if (preview) return;
    if (!bridge) throw new Error("マイクはEven App内で利用できます");
    if (!model.awake || !textRouteActive() || startPending || inputModes.busy || state.phase !== "idle") throw new Error("通話を終えて音声→テキストに切り替えてください");
  },
  owned: () => preview || (textRouteActive() && textSocket.ready && textSession.available && state.phase === "idle"),
  setInput: async enabled => { if (!preview) { if (enabled) await textSession.startInput(); else textSession.stopInput(); } },
  microphone: enabled => microphone(enabled, "text"),
  changed: open => { if (textRouteActive()) { userTalking = open; if (open || preview) { model.phase = open ? "listening" : "idle"; model.setActivity(open ? "recording" : "ready"); } changed(); } },
  error: notice,
  preparing: pending => inputPreparing("text", pending), timing: value => recordPttTiming("text", value),
});
function inputPreparing(route: "phone" | "text", pending: boolean): void {
  if (pending) inputTransitions.add(route); else inputTransitions.delete(route);
  glasses?.setInputPending(inputTransitions.size > 0);
  if (pending && !userTalking) model.setActivity("arming");
  else if (!inputTransitions.size && model.activity === "arming") model.setActivity(model.phase === "error" ? "error" : "ready");
  changed();
}
function recordPttTiming(route: "phone" | "text", value: PttTiming): void {
  lastPttTiming = { ...value, route }; paintPttTiming(); console.info("[Dots Phone G2 PTT]", lastPttTiming);
}
function paintPttTiming(): void {
  if (!lastPttTiming || !phoneIsVisible()) return;
  const t = lastPttTiming, ms = (v: number) => `${Math.round(v)} ms`;
  element("ptt-timing").textContent = `${t.route.toUpperCase()} / ${t.source} / ${t.result}\n開始まで: ${ms(t.totalMs)}\n処理キュー: ${ms(t.queueMs)}\n通話・音声準備: ${ms(t.ensureCallMs)}\nブリッジ入力許可: ${ms(t.inputGateMs)}\nG2マイク開始: ${ms(t.nativeMicMs)}\n最初の音声: ${t.firstPcmMs === undefined ? "未受信" : ms(t.firstPcmMs)}`;
}
function firstPcm(route: "phone" | "text"): void {
  if (lastPttTiming?.route !== route || lastPttTiming.result !== "ready" || lastPttTiming.firstPcmMs !== undefined) return;
  lastPttTiming.firstPcmMs = performance.now() - lastPttTiming.requestedAt; paintPttTiming();
}
function textRouteActive(): boolean { return model.textInputActive; }
const nativeMicrophone = new OwnedMicrophone(async (enabled, route) => {
  if (!bridge) { if (enabled && !preview) throw new Error("Even G2に接続されていません"); return; }
  if (enabled) {
    glasses?.setMicrophone(true);
    // The WebView is not recording the phone mic. Keep its playback route,
    // while the native SDK provides the glasses PCM.
    if (route === "phone") player.prepareForRecording({ keepPlayback: true });
  }
  const ok = await withFrameTimeout(bridge.audioControl(enabled, enabled ? AudioInputSource.Glasses : undefined), "G2 microphone", 8000);
  if (!ok) throw new Error("G2マイクを切り替えられませんでした");
  glasses?.setMicrophone(enabled);
  // The native SDK can change/suspend the iPhone audio session after the
  // preparation above. Reassert duplex playback after its acknowledgement.
  if (route === "phone") restorePhonePlayback(player, enabled ? "phone" : undefined);
});
function microphone(enabled: boolean, route: "phone" | "text"): Promise<void> { return nativeMicrophone.set(enabled, route); }
function microphoneIdle(): boolean { return !disposed && !lifecycle.visible && !inputTransitions.size && !userTalking && !ptt.recording && !textPtt.recording; }
const idleAudio = new IdleAudioGuard({
  idle: microphoneIdle,
  close: () => nativeMicrophone.closeIfIdle(textRouteActive() ? "text" : "phone", microphoneIdle),
  corrected: () => { power.microphoneRepaired(); notice("待機中に流れていたG2マイク音声を停止しました"); },
  error: error => { if (!disposed) notice(error); },
});
function routeChanged(): void {
  model.phase = "idle"; model.setActivity("ready"); model.notice = `${model.modeLabel}に切り替えました。長押しで話してね。`; savePreferences(); changed();
}
const inputModes = new InputModeSwitch(model, {
  phase: () => state.phase, starting: () => !!startPending || !!stopPending,
  canStopCall: () => preview || voice.ready && !!clientId && (!state.owner || state.owner === clientId),
  stopCall, clearInputs, cancelText: () => textSession.cancel(),
  committed: () => { userTalking = false; routeChanged(); }, changed,
});
function setInputMode(mode: "phone" | "text"): Promise<void> { return inputModes.set(mode); }
function switchInputMode(): void {
  if (model.awake) void setInputMode(model.inputMode === "phone" ? "text" : "phone").catch(notice);
}
function doubleTap(): void { toggleDisplay(); }
function singleTap(): void { if (!model.awake || model.pendingTranscript) return; model.latest(); changed(); }
function submitAsr(): void {
  if (!model.pendingTranscript) return;
  if (preview) { model.pendingTranscript = false; model.phase = "thinking"; model.setActivity("waiting"); changed(); }
  else textSession.submitTranscript();
}
function discardAsr(): void {
  if (!model.pendingTranscript) return;
  if (preview) { model.pendingTranscript = false; model.transcript = ""; model.phase = "idle"; model.setActivity("ready"); model.notice = "認識結果を破棄しました。Dotには送信していません"; changed(); }
  else textSession.discardTranscript();
}
function canEndCall(): boolean {
  return !!stopPending || (preview ? state.phase === "active" : !!clientId && (!state.owner || state.owner === clientId) && ["active", "stopping", "needs-stop"].includes(state.phase));
}
function endCall(): void { void stopCall().catch(notice); }
function hasOwnedCall(): boolean { return preview ? state.phase === "active" && !phoneRecovering() : owned(); }
function hold(source: string): void {
  if (!preview && !token) { model.notice = "スマホの「Macへの接続設定」でトークンを保存してください"; changed(); return; }
  autoOff.touch(); if (stopPending || inputModes.busy || model.pendingTranscript || !lifecycle.acceptsGesture || !model.awake && !hasOwnedCall() || !textRouteActive() && phoneRecovering()) return;
  if (textRouteActive()) { if (!preview) textSocket.connect(); textPtt.hold(source); } else { if (!preview) voice.connect(); ptt.hold(source); }
  maintenance();
}
function release(source: string): void { void ptt.release(source); void textPtt.release(source); }
async function clearInputs(): Promise<void> { await Promise.all([ptt.clear(), textPtt.clear()]); }
function phoneRecovering(): boolean { return !!state.recovery?.browser || !!state.recovery?.client || !!state.recovery?.audio; }
function owned(): boolean { return voice.ready && !!clientId && state.owner === clientId && state.phase === "active" && !phoneRecovering(); }
function applyState(next: WireMessage): void {
  const wasRecovering = phoneRecovering() || state.phase === "unknown";
  state = next; model.callActive = state.phase === "active";
  if (model.callActive) { model.inputMode = "phone"; textSession.cancel(); void textPtt.clear(); }
  if (state.phase === "idle" || state.phase === "needs-stop" || state.phase === "stopping") {
    void ptt.clear(); player.clearBufferedAudio("call inactive"); wake.reset(); if (!textRouteActive()) userTalking = false;
  }
  if (textRouteActive()) { changed(); return; }
  if (state.phase === "active" && phoneRecovering()) {
    void ptt.clear(); userTalking = false; model.setActivity("reconnecting"); model.notice = state.recovery?.audio ? "Macの音声を復旧しています。通話は維持し、マイク入力を止めています" : "接続を復旧しています。通話は維持し、マイク入力を止めています";
  }
  else if (state.phase === "stopping") { model.setActivity("ending"); }
  else if (state.phase === "starting") { model.phase = "thinking"; model.setActivity("connecting"); }
  else if (state.phase === "needs-stop") { model.phase = "error"; model.setActivity("error"); model.notice = "通話終了の確認が必要です。「通話を終える」を押してください"; }
  else if (state.phase === "unknown") { model.phase = "error"; model.setActivity("reconnecting"); }
  else if (!userTalking) { model.phase = wake.speaking ? "speaking" : "idle"; model.setActivity(wake.speaking ? "playing" : "ready"); }
  if (wasRecovering && state.phase === "active" && !phoneRecovering() && state.owner === clientId) model.notice = "接続が戻りました。同じ通話を続けられます。もう一度長押しで話してください";
  if ((state.phase === "idle" || state.phase === "needs-stop") && state.lastEnd?.at > lastEndSeen) {
    lastEndSeen = state.lastEnd.at;
    const reasons: Record<string, string> = { "client-request": "通話を終了しました", "dots-ended": "Dots側で通話が終了しました", "client-recovery-timeout": "スマホとの接続が60秒以内に戻らず、通話を終了しました", "browser-recovery-timeout": "Chrome側の接続・通話状態が60秒以内に復旧しませんでした", "native-audio-failed": "Macの音声取得が停止したため、通話の終了処理を行いました", "native-audio-recovery-timeout": "Macの音声が60秒以内に復旧せず、通話を終了しました", "bridge-shutdown": "Macのブリッジを停止したため、通話を終了しました" };
    model.notice = reasons[state.lastEnd.reason] || "通話の終了処理を行いました。Macの切断ログを確認できます";
  }
  changed();
}
function onVoiceMessage(message: WireMessage): void {
  if (message.type === "voice.ready") {
    clientId = message.clientId; applyState(message.state);
    void voice.request("status").then(applyState).catch(notice);
    if (state.phase === "idle" && !textRouteActive()) model.notice = state.browserOnline ? "通話を始められます" : "Chrome拡張を再読み込みし、dotの画面を開いてください";
    else if (state.owner && state.owner !== clientId) model.notice = "他の端末が通話中です";
    changed();
  } else if (message.type === "voice.state") applyState(message);
  else if (message.type === "browser.state") { state.browserOnline = message.online; model.connected = voice.ready && message.online === true; changed(); }
  else if (message.type === "audio.reset") {
    state.streamId = message.streamId;
    activeStream = message.streamId; player.setStreamProfile(activeStream, 80);
    // A stream reset during a dismissed utterance is not a new utterance.
    wake.reset(!model.awake && wake.speaking);
  } else if (message.type === "voice.notice" || message.type === "voice.error") { if (message.type === "voice.error") void ptt.clear(); notice(message.message); }
}
function onAudio(meta: AudioFrame, bytes: Uint8Array): void {
  if (!owned() || meta.streamId !== state.streamId) return;
  maintenance();
  if (activeStream !== meta.streamId) { activeStream = meta.streamId; player.setStreamProfile(meta.streamId, 80); }
  const started = wake.feed(bytes, meta.sampleRate, meta.channels); lastAudioAt = performance.now();
  if (started) model.wakeFromDot();
  const phase = userTalking ? "listening" : wake.speaking ? "speaking" : "idle";
  if (model.phase !== phase || started) { model.phase = phase; model.setActivity(userTalking ? "recording" : wake.speaking ? "playing" : "ready"); changed(); }
  if (player.ready) {
    let binary = ""; for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    player.enqueue({ data: btoa(binary), sampleRate: meta.sampleRate, numChannels: meta.channels, samplesPerChannel: bytes.length / (2 * meta.channels), streamId: meta.streamId });
  }
}
async function startCall(): Promise<void> {
  if (inputModes.busy) throw new Error("入力方法の切り替えが完了するまでお待ちください");
  if (textSession.busy || userTalking && textRouteActive()) throw new Error("テキスト入力・返答が終わってから電話してください");
  if (preview) { state.phase = "active"; model.callActive = true; model.inputMode = "phone"; model.connected = true; changed(); return; }
  if (owned()) return;
  if (state.phase === "active" && state.owner === clientId && phoneRecovering()) throw new Error("通話は維持しています。接続の復旧後にもう一度長押ししてください");
  if (startPending) return startPending;
  if (!voice.ready) throw new Error("Macの電話ブリッジに接続されていません");
  if (state.phase !== "idle") throw new Error("別の通話が進行中か、通話終了の確認が必要です");
  if (!state.browserOnline) throw new Error("Chromeでdotを開き、拡張を再読み込みしてください");
  model.inputMode = "phone"; savePreferences();
  model.notice = "dotに電話しています…"; model.awake = true; model.setActivity("connecting"); changed();
  startPending = (async () => { await player.enable({ confirmationTone: false }); applyState(await voice.request("session.start")); model.notice = "つながったよ。長押しで話してね。"; changed(); })();
  changed();
  try { await startPending; } finally { startPending = undefined; changed(); }
}
async function stopCall(): Promise<void> {
  if (stopPending) return stopPending;
  stopPending = (async () => {
    const closing = ptt.clear();
    if (preview) { state.phase = "idle"; model.callActive = false; wake.reset(); model.phase = "idle"; model.setActivity("ready"); await closing; changed(); return; }
    if (!voice.ready) { await closing; throw new Error("Macに再接続して通話状態を確認してください"); }
    if (state.owner && state.owner !== clientId) { await closing; throw new Error("他の端末が使っている通話です"); }
    model.setActivity("ending"); changed();
    try { applyState(await voice.request("session.stop")); } finally { await closing; }
  })();
  changed();
  try { await stopPending; } finally { stopPending = undefined; changed(); }
}
function sleepDisplay(): void {
  model.sleepDisplay(); if (!hasOwnedCall()) void clearInputs(); changed();
}
function toggleDisplay(): void { if (model.awake) sleepDisplay(); else { model.wakeDisplay(); changed(); } }
function changed(): void {
  if (disposed) return;
  if (model.awake) model.hud.tick();
  if (model.awake && (!observedAwake || observedHistory !== model.historyRevision)) autoOff.touch();
  observedAwake = model.awake; observedHistory = model.historyRevision;
  model.connected = preview || (textRouteActive() ? textSocket.ready && textSession.available : voice.ready && state.browserOnline === true && !phoneRecovering());
  power.state(model.awake, !!nativeMicrophone.activeRoute);
  paintUi();
  glasses?.setDesiredAwake(model.awake);
  updateDisplayWork();
  if (phoneIsVisible() && (!model.animateCharacter || lastCanvasAwake !== model.awake)) paintCanvas(performance.now() / 1000);
  requestRender();
}
function phoneIsVisible(): boolean { return phoneVisible && !document.hidden; }
function updateDisplayWork(): void {
  const active = userTalking || !!inputTransitions.size || !!nativeMicrophone.activeRoute || textSession.busy
    || !!startPending || !!stopPending || inputModes.busy || wake.speaking || phoneRecovering()
    || !preview && (voice.needsFastMaintenance || inbox.needsFastMaintenance || textSocket.needsFastMaintenance);
  displayWork.update(model.awake, phoneIsVisible(), lifecycle.visible, !!active, model.animateCharacter);
}
function requestRender(): void {
  if (!glasses || disposed) return;
  if (renderPending) { renderAgain = true; return; }
  renderPending = true;
  // Coalesce changes while native BLE transfers are in flight; retain only the latest model.
  void glasses.render(model).catch(noticeRender).finally(() => {
    renderPending = false;
    if (renderAgain) { renderAgain = false; requestRender(); }
    else if (!disposed) animateGlasses();
  });
}
function noticeRender(error: unknown): void { model.notice = `G2表示: ${error instanceof Error ? error.message : error}`; paintUi(); }
function paintUi(): void {
  if (stopPending && state.phase !== "idle") model.setActivity("ending");
  else if (inputTransitions.size && !userTalking && state.phase !== "starting" && !phoneRecovering()) model.setActivity("arming");
  model.audioReady = !textRouteActive() && player.ready;
    if (!phoneIsVisible()) return;
  element("phase").textContent = !model.awake ? model.callActive ? "G2は消灯中 · 通話は継続しています" : "G2は消灯中 · 2タップで点灯" : model.callActive ? "電話でつながっています" : model.modeLabel;
  const needsSetup = !preview && !token;
  element("activity-code").textContent = needsSetup ? "SETUP" : model.status.code; element("activity-label").textContent = needsSetup ? "接続設定を入力してください" : model.status.label;
  element("activity-detail").textContent = needsSetup ? "Macで生成したペアリングトークンを保存すると接続します" : model.status.detail;
  element("activity-label").closest<HTMLElement>(".activity-card")!.dataset.stage = model.activity;
  element("activity-steps").hidden = !textRouteActive();
  [...element("activity-steps").children].forEach((node, i) => { node.setAttribute("data-active", String(i === model.textStage)); node.setAttribute("data-complete", String(i < model.textStage)); });
  element("audio-status").textContent = textRouteActive() ? "TEXT REPLY" : model.audioReady ? "VOICE · 準備済み" : "VOICE · 未準備";
  paintElapsed();
  element("connection").textContent = needsSetup ? "初回設定" : preview ? "プレビュー" : textRouteActive() ? model.connected ? "テキスト 接続済み" : "テキスト 接続待ち" : !voice.ready ? "Mac 接続待ち" : !state.browserOnline ? "Chrome 接続待ち" : state.phase === "active" ? "通話中" : state.phase === "starting" ? "接続中" : "接続済み";
  for (const mode of ["phone", "text"] as const) { const button = element<HTMLButtonElement>(`${mode}-mode`); button.disabled = !inputModes.canSet(mode); button.setAttribute("aria-pressed", String(model.inputMode === mode)); }
  element("call").hidden = textRouteActive(); element("end").hidden = textRouteActive();
  element("cancel-text").hidden = !textRouteActive() || !textSession.busy;
  element<HTMLButtonElement>("call").disabled = state.phase !== "idle" || !!startPending || textSession.busy || (!preview && (!voice.ready || !state.browserOnline));
  element<HTMLButtonElement>("end").disabled = !!stopPending || state.phase === "idle" || (!preview && (!voice.ready || (!!state.owner && state.owner !== clientId)));
  element<HTMLButtonElement>("hold").disabled = !!stopPending || inputModes.busy || model.pendingTranscript || !textRouteActive() && phoneRecovering() || !model.awake && !hasOwnedCall() || (!preview && (!bridge || (textRouteActive() ? !textSocket.ready || !textSession.available || textSession.busy && !userTalking || state.phase !== "idle" : !voice.ready || state.phase !== "idle" && !owned())));
  element("hold").textContent = userTalking ? "聞いているよ…" : inputTransitions.size ? "マイクを準備中…" : "長押しで話す";
  element("screen").textContent = model.awake ? "表示をオフ" : "表示をオン";
  element("output").hidden = textRouteActive();
  element("output").textContent = player.ready ? "通話音声をオフ" : "通話音声をオン";
  if (preview) {
    const items = buildDotsMenu(model).menuItems!;
    element("demo-menu-items").textContent = `Even OSメニューの追加項目\n${items.map(item => item.itemName).join("\n")}`;
    element("demo-menu-mode").textContent = `メニュー: ${items[0]!.itemName}`;
    element("demo-menu-submit").hidden = !model.pendingTranscript;
    element("demo-menu-discard").hidden = !model.pendingTranscript;
  }
  const hint = model.controlsHint.split("\n").join("<br>");
  if (element("gesture-hint").innerHTML !== hint) element("gesture-hint").innerHTML = hint;
  element<HTMLInputElement>("character-animation").checked = model.animateCharacter;
  element<HTMLSelectElement>("screen-side").value = model.screenSide;
  element<HTMLSelectElement>("screen-side").disabled = userTalking || !!inputTransitions.size || ptt.recording || textPtt.recording || inputModes.busy;
  element<HTMLSelectElement>("history-limit").value = String(model.historyLimit);
  element<HTMLSelectElement>("history-limit").disabled = userTalking || !!inputTransitions.size || ptt.recording || textPtt.recording || inputModes.busy;
  element<HTMLSelectElement>("auto-off").value = String(displayOffSeconds);
  element<HTMLInputElement>("asr-review").checked = reviewTranscript;
  element<HTMLInputElement>("asr-review").disabled = textSession.busy || userTalking || model.pendingTranscript;
  element("asr-setting-hint").textContent = reviewTranscript && !preview && textSocket.ready && !textSession.reviewSupported ? "Macのテキスト会話ブリッジの更新が必要です。更新前は確認入力を開始しません。" : "オフなら自動送信。オンならG2に結果を表示し、G2／R1の長押しで送信・2タップで破棄します。メニューも使えます。電話には適用しません。";
  element("asr-card").hidden = !model.asrCardVisible;
  element("asr-actions").hidden = !model.pendingTranscript;
  element("asr-label").textContent = model.pendingTranscript ? "送信前" : model.activity === "recording" ? "認識中" : "認識結果";
  element("asr-hint").textContent = model.pendingTranscript ? "まだDotに送っていません。G2左右 / R1: 長押しで送信 / 2タップで破棄。メニューからも選べます" : "音声から認識したテキストです。";
  element("message-card").hidden = model.asrVisible;
  element("message-label").textContent = model.asrVisible ? model.pendingTranscript ? "ASR / 送信前の確認" : "あなた / ASR" : model.selectedRole === "user" ? "あなたの入力" : "DOTからのメッセージ";
  element("reply").textContent = model.viewport.text;
  element("page").textContent = `${model.history.length ? `${model.messageIndex + 1}/${model.messageCount}件 · ` : ""}${model.viewport.page}/${model.viewport.pages}頁`;
  element<HTMLButtonElement>("prev").disabled = !model.canOlder; element<HTMLButtonElement>("next").disabled = !model.canNewer;
  element("latest").textContent = model.unread ? `最新へ (${model.unread})` : "最新へ";
  element("transcript").textContent = model.transcript;
  element("notice").textContent = model.notice;
  paintHistory();
}
function paintHistory(): void {
  if (!phoneIsVisible() || !element<HTMLDetailsElement>("history-details").open || inputTransitions.size || userTalking) return;
  const history = element("history");
  if (historyRevision !== model.historyRevision || renderedHistoryLimit !== model.historyLimit) {
    historyRevision = model.historyRevision; renderedHistoryLimit = model.historyLimit; historySelection = undefined; history.replaceChildren();
    for (const item of model.visibleHistory.slice().reverse()) {
      const button = document.createElement("button"); button.className = "history-item"; button.dataset.messageId = item.id; button.textContent = `${item.role === "user" ? "あなた" : "Dot"} · ${model.orderedHistory ? "会話順" : new Date(item.receivedAt).toLocaleString("ja-JP")}\n${item.text}`;
      button.addEventListener("click", () => { model.select(item.id); model.wakeDisplay(); changed(); }); history.append(button);
    }
  }
  if (historySelection !== model.selectedId) {
    historySelection = model.selectedId;
    for (const button of history.children) button.setAttribute("aria-pressed", String((button as HTMLElement).dataset.messageId === model.selectedId));
  }
}
function paintCanvas(time: number): void {
  if (!phoneIsVisible() || inputTransitions.size) return;
  lastCanvasAwake = model.awake;
  const pose = model.awake && model.animateCharacter ? dotPose(model.phase, time, preview ? previewEnergy : textRouteActive() ? 0 : wake.energy) : FIXED_DOT_POSE;
  const moving = model.awake && model.animateCharacter;
  if (moving || !fixedPinkPainted) drawPinkDot(element<HTMLCanvasElement>("pink").getContext("2d")!, pose);
  fixedPinkPainted = !moving;
  const canvas = element<HTMLCanvasElement>("g2"), ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, 576, 288);
  if (!model.awake) return;
  let image = !model.animateCharacter ? fixedG2Image : undefined;
  if (!image) {
    const bytes = dotGray4(dotGlassesPose(model.phase, time, preview ? previewEnergy : textRouteActive() ? 0 : wake.energy, model.animateCharacter));
    image = ctx.createImageData(DOT_SIZE, DOT_SIZE);
    for (let i = 0; i < DOT_SIZE * DOT_SIZE; i++) { const gray = ((bytes[i >> 1] ?? 0) >> (i % 2 ? 0 : 4)) & 15; image.data.set([gray * 4, gray * 14, gray * 6, 255], i * 4); }
    if (!model.animateCharacter) fixedG2Image = image;
  }
  ctx.putImageData(image, 28, 66);
  ctx.fillStyle = "#80d891"; ctx.font = "18px monospace"; ctx.fillText(model.linkHeading, 20, 30);
  ctx.fillText(model.hud.text, 400, 30);
  ctx.strokeStyle = "#31543a"; ctx.beginPath(); ctx.roundRect(204, 52, 352, 180, 12); ctx.stroke();
  ctx.font = "18px sans-serif"; ctx.fillText(model.heading, 214, 79);
  model.viewport.text.split("\n").forEach((line, i) => ctx.fillText(line, 214, 110 + i * 28));
  ctx.font = "18px monospace"; ctx.fillText(model.status.code, 20, 240);
  ctx.font = "16px sans-serif"; ctx.fillText(model.footer, 20, 275);
}
element("call").addEventListener("click", () => void startCall().catch(notice));
element("end").addEventListener("click", endCall);
element("phone-mode").addEventListener("click", () => void setInputMode("phone").catch(notice));
element("text-mode").addEventListener("click", () => void setInputMode("text").catch(notice));
element("cancel-text").addEventListener("click", () => { if (model.pendingTranscript) discardAsr(); else textSession.cancel(); void textPtt.clear(); });
element("asr-send").addEventListener("click", submitAsr);
element("asr-discard").addEventListener("click", discardAsr);
element("asr-review").addEventListener("change", () => { reviewTranscript = element<HTMLInputElement>("asr-review").checked; savePreferences(); changed(); });
element("history-limit").addEventListener("change", () => {
  if (userTalking || inputTransitions.size || ptt.recording || textPtt.recording || inputModes.busy) { notice("長押しを離してから履歴の表示件数を変更してください"); return; }
  model.setHistoryLimit(Number(element<HTMLSelectElement>("history-limit").value));
  savePreferences(); changed();
});
element("auto-off").addEventListener("change", () => { displayOffSeconds = autoOffSeconds(Number(element<HTMLSelectElement>("auto-off").value)); autoOff.configure(displayOffSeconds); savePreferences(); changed(); });
element("character-animation").addEventListener("change", () => {
  model.animateCharacter = element<HTMLInputElement>("character-animation").checked;
  savePreferences(); changed();
  if (phoneIsVisible()) paintCanvas(performance.now() / 1000);
});
element("screen-side").addEventListener("change", () => {
  if (userTalking || inputTransitions.size || ptt.recording || textPtt.recording || inputModes.busy) { notice("長押しを離してから左右の操作を変更してください"); return; }
  model.screenSide = element<HTMLSelectElement>("screen-side").value === "left" ? "left" : "right";
  savePreferences(); changed();
});
document.addEventListener("pointerdown", () => autoOff.touch(), { passive: true });
document.addEventListener("click", () => autoOff.touch(), { capture: true });
element("screen").addEventListener("click", toggleDisplay);
element("output").addEventListener("click", () => {
  if (textRouteActive()) return;
  if (player.ready) { player.disable(); changed(); } else void player.enable({ confirmationTone: false }).then(changed).catch(notice);
});
element("prev").addEventListener("click", () => { model.scroll(1); changed(); });
element("next").addEventListener("click", () => { model.scroll(-1); changed(); });
element("latest").addEventListener("click", singleTap);
element("hold").addEventListener("pointerdown", event => { (event.target as HTMLElement).setPointerCapture(event.pointerId); hold("phone"); });
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) element("hold").addEventListener(type, () => release("phone"));
element("g2").addEventListener("dblclick", doubleTap);
if (preview) element("demo-double").addEventListener("click", () => onEvenEvent({ jsonData: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource: model.screenSide === "right" ? EventSourceType.TOUCH_EVENT_FROM_GLASSES_R : EventSourceType.TOUCH_EVENT_FROM_GLASSES_L } }));
const gestures = new DotsControls({
  screenSide: () => model.screenSide,
  reviewingAsr: () => textRouteActive() && model.pendingTranscript,
  awake: () => model.awake, ownedCall: hasOwnedCall, canEndCall, endCall, switchMode: switchInputMode,
  discardAsr, submitAsr,
  doubleTap, tap: singleTap, hold, release,
  scroll: delta => { model.scroll(-delta); changed(); },
});
const lifecycle = new OverlayLifecycle({
  overlay: visible => { glasses?.setOverlayVisible(visible); updateDisplayWork(); },
  resume: recover,
});
function paintElapsed(): void {
  if (!phoneIsVisible()) return;
  const label = model.status.step < 0 ? "LINK / STANDBY" : `${String(Math.floor((Date.now() - model.activityAt) / 1000)).padStart(2, "0")}s / ${model.modeLabel}`;
  if (element("activity-time").textContent !== label) element("activity-time").textContent = label;
  paintPower();
}
function paintPower(): void {
  if (!phoneIsVisible() || !element<HTMLDetailsElement>("power-details").open) return;
  const value = power.snapshot(), minutes = (ms: number) => `${(ms / 60_000).toFixed(1)}分`, battery = value.battery;
  element("power-status").textContent = `使用: ${minutes(value.elapsedMs)} / 点灯: ${minutes(value.awakeMs)} / 消灯: ${minutes(value.sleepMs)}\nマイク: ${minutes(value.microphoneMs)} / 待機マイク停止: ${value.repairs}回\nG2送信要求: 画面${value.transfers.page} / 文章${value.transfers.text} / 画像${value.transfers.image}\n消灯中の送信要求: 画面${value.sleepTransfers.page} / 文章${value.sleepTransfers.text} / 画像${value.sleepTransfers.image}\n監視間隔: ${displayWork.maintenanceIntervalMs / 1000}秒\n電池: ${battery ? `${battery.from} → ${battery.level}% / ${minutes(battery.elapsedMs)}` : "G2の電池通知待ち"}\n消費率: ${battery?.percentPerHour === undefined ? "30分以上・2%以上の減少で表示" : `${battery.percentPerHour.toFixed(1)}%/時（今回の使用全体）`}`;
}
element("power-details").addEventListener("toggle", paintPower);
element("history-details").addEventListener("toggle", paintHistory);
function maintenance(force = false): void { displayWork.check(force); }
function maintain(now: number): void {
  if (disposed) return;
  if (!preview && token) { voice.tick(now); inbox.tick(now); textSocket.tick(now); ptt.tick(now); textPtt.tick(now); textSession.tick(now); }
  if (wake.speaking && performance.now() - lastAudioAt > 1500 && !preview) { wake.reset(); if (!userTalking) { model.phase = "idle"; model.setActivity("ready"); } changed(); }
  const busy = userTalking || !!inputTransitions.size || model.pendingTranscript || textSession.busy || !!startPending || !!stopPending || inputModes.busy || lifecycle.visible || model.phase !== "idle" && model.phase !== "error";
  if (autoOff.due(model.awake, busy, now)) sleepDisplay();
  if (model.awake && model.hud.tick(now)) {
    requestRender();
    if (phoneIsVisible()) paintCanvas(performance.now() / 1000);
  }
  updateDisplayWork();
  if (!model.animateCharacter) animateGlasses();
  paintElapsed();
}
function recover(rebuild = false): void {
  if (disposed) return;
  lastCanvasAwake = undefined;
  updateDisplayWork(); maintenance(true);
  if (!preview && Date.now() - lastResumeAt > 1500) { lastResumeAt = Date.now(); voice.probe(); inbox.probe(); textSocket.probe(); }
  if (!textRouteActive()) restorePhonePlayback(player, nativeMicrophone.activeRoute);
  // Phone focus/visibility does not replace the G2 page. Rebuild only after
  // a real device reconnection; OS overlay restoration invalidates its page.
  if (rebuild) glasses?.restoreCapture();
  paintPttTiming();
  changed();
}
const displayWork = new DisplayWork({ maintenance: maintain, foreground: frame, background: animateGlasses });
function onEvenEvent(event: EvenHubEvent): void {
  const type = gestureEventType(event);
  if (!event.audioEvent && lifecycle.accepts(type) && type !== undefined && [OsEventTypeList.CLICK_EVENT, OsEventTypeList.DOUBLE_CLICK_EVENT, OsEventTypeList.LONG_PRESS_EVENT, OsEventTypeList.LONG_PRESS_RELEASE_EVENT, OsEventTypeList.SCROLL_TOP_EVENT, OsEventTypeList.SCROLL_BOTTOM_EVENT].includes(type)) autoOff.touch();
  maintenance();
  if (event.menuItemClickEvent) {
    // Menu selections arrive while the OS foreground overlay is still open.
    // They are separate actions, not taps subject to the overlay gesture gate.
    if (model.awake) { autoOff.touch(); gestures.route(event); }
    return;
  }
  if (event.audioEvent) {
    if (event.audioEvent.source === AudioInputSource.Glasses) idleAudio.feed();
    if (event.audioEvent.source === AudioInputSource.Glasses) { if (ptt.recording) firstPcm("phone"); if (textPtt.recording) firstPcm("text"); }
    if (ptt.recording && event.audioEvent.source === AudioInputSource.Glasses && !voice.sendPcm(event.audioEvent.audioPcm)) { void ptt.clear(); notice("音声送信が遅れています。長押しを離してから試してください"); }
    if (textPtt.recording && event.audioEvent.source === AudioInputSource.Glasses && !textSocket.sendPcm(event.audioEvent.audioPcm)) { textSession.cancel(); void textPtt.clear(); notice("音声認識への送信が遅れています。長押しを離してから試してください"); }
    return;
  }
  if (lifecycle.handle(type)) return;
  if (type === OsEventTypeList.SYSTEM_EXIT_EVENT || type === OsEventTypeList.ABNORMAL_EXIT_EVENT) { dispose(); return; }
  if (lifecycle.accepts(type)) gestures.route(event);
}
let offEvents: (() => void) | undefined, offDevice: (() => void) | undefined;
async function initialize(): Promise<void> {
  if (preview) { model.connected = true; state.browserOnline = true; changed(); return; }
  if (token) { voice.connect(); inbox.connect(); textSocket.connect(); }
  try {
    bridge = startupBridge;
    if (!bridge) throw new Error("Even Appに接続されていません");
    glasses = new DotsGlasses(bridge, (kind, awake) => power.transfer(kind, awake)); await glasses.initialize(model);
    offEvents = bridge.onEvenHubEvent(onEvenEvent);
    const connection = new DeviceConnectionLifecycle({ lost: () => { gestures.resetHolds(); void clearInputs(); }, resume: recover });
    let deviceStatusRevision = 0;
    const observeDevice = (status: DeviceStatus) => {
      power.observeBattery(status.batteryLevel, status.isCharging);
      const hudChanged = model.hud.observeBattery(status.batteryLevel);
      connection.handle(status);
      if (hudChanged && model.awake) { requestRender(); if (phoneIsVisible()) paintCanvas(performance.now() / 1000); }
      paintPower();
    };
    offDevice = bridge.onDeviceStatusChanged(status => { deviceStatusRevision++; observeDevice(status); });
    // Seed from the host's device info once. A later result must not replace a
    // newer live status; this read neither blocks PTT startup nor polls the G2.
    const revision = deviceStatusRevision;
    void bridge.getDeviceInfo().then(device => {
      if (!disposed && deviceStatusRevision === revision && device?.isGlasses()) observeDevice(device.status);
    }).catch(() => {});
    changed();
  } catch { model.notice = "G2マイクと表示はEven Appで利用できます。ブラウザでは ?preview=1 で表示を確認できます"; changed(); }
}
document.querySelectorAll<HTMLButtonElement>("[data-demo]").forEach(button => button.addEventListener("click", () => {
  const mode = button.dataset.demo;
  model.pendingTranscript = mode === "reviewing";
  if (mode === "reviewing") { model.inputMode = "text"; model.callActive = false; state.phase = "idle"; model.transcript = "週末は少し遠くまで散歩したいな。\n静かで緑の多い場所を、一緒に考えてくれる？"; model.asrOffset = 0; model.phase = "idle"; model.wakeDisplay(); }
    if (mode === "incoming") { model.incoming({ id: crypto.randomUUID(), sequence: model.cursor + 1, text: model.cursor % 2 ? "今日はどんな一日だった？\nさっきの空の話、続きを聞かせて。" : "おかえり。今日の空、見た？\nちょっと話したくなったんだ。", receivedAt: Date.now() }); model.phase = "speaking"; }
  else if (mode !== "reviewing") model.phase = mode as typeof model.phase;
  model.setActivity(mode === "reviewing" ? "reviewing" : mode === "listening" ? "recording" : mode === "transcribing" ? "recognizing" : mode === "thinking" ? "waiting" : mode === "speaking" || mode === "incoming" ? "playing" : "ready");
  previewEnergy = model.phase === "speaking" ? .7 : 0; changed();
}));
if (preview) {
  element("demo-input").addEventListener("click", () => {
    const id = `preview-input:${Date.now()}`;
    model.incoming({ id, sequence: model.cursor + 1, role: "user", inputId: id, text: "週末は少し遠くまで散歩したいな。\n静かで緑の多い場所を、一緒に考えてくれる？", receivedAt: Date.now() });
    model.select(id); model.setActivity("ready"); model.phase = "idle"; model.wakeDisplay(); changed();
  });
  const demoGesture = (type: OsEventTypeList, side = EventSourceType.TOUCH_EVENT_FROM_GLASSES_L) => onEvenEvent({ jsonData: { eventType: type, eventSource: side } });
  for (const [id, itemID] of [["demo-menu-mode", DOTS_MENU_ITEM_ID.inputMode], ["demo-menu-discard", DOTS_MENU_ITEM_ID.discardAsr], ["demo-menu-submit", DOTS_MENU_ITEM_ID.submitAsr]] as const) element(id).addEventListener("click", () => onEvenEvent({ menuItemClickEvent: new MenuItemClickEvent({ itemID }) }));
  element("demo-double-left").addEventListener("click", () => demoGesture(OsEventTypeList.DOUBLE_CLICK_EVENT, EventSourceType.TOUCH_EVENT_FROM_GLASSES_L));
  element("demo-double-right").addEventListener("click", () => demoGesture(OsEventTypeList.DOUBLE_CLICK_EVENT, EventSourceType.TOUCH_EVENT_FROM_GLASSES_R));
  element("demo-right").addEventListener("click", () => demoGesture(OsEventTypeList.LONG_PRESS_EVENT, EventSourceType.TOUCH_EVENT_FROM_GLASSES_R));
  element("demo-left").addEventListener("click", () => demoGesture(OsEventTypeList.LONG_PRESS_EVENT));
  element("demo-release").addEventListener("click", () => { demoGesture(OsEventTypeList.LONG_PRESS_RELEASE_EVENT); demoGesture(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, EventSourceType.TOUCH_EVENT_FROM_GLASSES_R); });
  element("demo-tap").addEventListener("click", () => demoGesture(OsEventTypeList.CLICK_EVENT, model.normalSide === "left" ? EventSourceType.TOUCH_EVENT_FROM_GLASSES_L : EventSourceType.TOUCH_EVENT_FROM_GLASSES_R));
  element("demo-scroll").addEventListener("click", () => demoGesture(OsEventTypeList.SCROLL_TOP_EVENT, model.normalSide === "left" ? EventSourceType.TOUCH_EVENT_FROM_GLASSES_L : EventSourceType.TOUCH_EVENT_FROM_GLASSES_R));
  element("demo-overlay").addEventListener("click", () => { lifecycle.handle(OsEventTypeList.FOREGROUND_ENTER_EVENT); notice("プレビュー: システム通知を表示中"); });
  element("demo-resume").addEventListener("click", () => { lifecycle.handle(OsEventTypeList.FOREGROUND_EXIT_EVENT); notice("プレビュー: システム通知から復帰しました"); });
  element("demo-link-lost").addEventListener("click", () => { clientId = "preview"; applyState({ ...state, phase: "active", owner: clientId, recovery: { browser: true, client: false, deadline: Date.now() + 60_000 } }); });
  element("demo-link-back").addEventListener("click", () => applyState({ ...state, recovery: { browser: false, client: false, deadline: null } }));
}
function animateGlasses(): void {
  void glasses?.animate(model, performance.now() / 1000, textRouteActive() ? 0 : wake.energy).catch(noticeRender);
}
function frame(): void {
  if (disposed || !displayWork.animating) return;
  paintCanvas(performance.now() / 1000); animateGlasses();
  if (preview) element("demo").dataset.visualTicks = String(++visualTicks);
}
function dispose(): void {
  if (disposed) return; disposed = true; displayWork.dispose(); textSession.cancel(); void clearInputs(); voice.dispose(); inbox.dispose(); textSocket.dispose();
  offEvents?.(); offDevice?.(); gestures.dispose(); player.dispose();
}
// Native G2/R1 holds survive phone notifications/backgrounding. A phone
// pointer hold is released when its page disappears; actual app exit disposes.
window.addEventListener("pagehide", () => { phoneVisible = false; updateDisplayWork(); save(); release("phone"); });
window.addEventListener("beforeunload", dispose);
window.addEventListener("pageshow", () => { phoneVisible = !document.hidden; recover(); });
window.addEventListener("focus", () => { phoneVisible = !document.hidden; recover(); });
window.addEventListener("blur", () => release("phone"));
document.addEventListener("visibilitychange", () => { if (document.hidden) { phoneVisible = false; updateDisplayWork(); release("phone"); save(); } else { phoneVisible = true; recover(); } });
updateDisplayWork(); displayWork.start(); paintUi(); paintCanvas(performance.now() / 1000); void initialize();
