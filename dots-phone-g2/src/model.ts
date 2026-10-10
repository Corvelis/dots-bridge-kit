import type { EchoPhase } from "../../shared/protocol";
import { TextViewportCache } from "../../shared/display/text-viewport";
import { GlassesHud } from "./hud";
import { historyLimit, type HistoryLimit } from "./history-limit";
import type { GlassesSide } from "../../src/gestures";

export const PHASE_LABEL: Record<EchoPhase, string> = {
  idle: "待機中", listening: "録音中", transcribing: "音声を文字に変換中",
  thinking: "dotの返答待ち", speaking: "音声を再生中", error: "接続・音声を確認",
};
export type Activity = "ready" | "connecting" | "ending" | "arming" | "recording" | "recognizing" | "reviewing" | "waiting" | "playing" | "switching" | "reconnecting" | "error";
export const ACTIVITY: Record<Activity, { code: string; label: string; detail: string; step: number }> = {
  ready: { code: "READY", label: "待機中", detail: "左/R1長押しで話す · 右長押しで入力切替 · 2タップで消灯", step: -1 },
  connecting: { code: "LINK", label: "接続中", detail: "dotとの通話をつないでいます", step: -1 },
  ending: { code: "END", label: "通話を終了中", detail: "通話の終了を確認しています", step: -1 },
  arming: { code: "MIC", label: "マイクを準備中", detail: "長押しを続けてください · 録音中になったら話してください", step: 0 },
  recording: { code: "REC", label: "録音中", detail: "G2マイクで聞いています · 離すと送信", step: 0 },
  recognizing: { code: "ASR", label: "文字に変換中", detail: "受け取った音声をテキストにしています", step: 1 },
  reviewing: { code: "CHECK", label: "認識結果を確認", detail: "まだDotに送っていません · G2 / R1長押しで送信 / 2タップで破棄", step: 1 },
  waiting: { code: "DOT", label: "dotの返答待ち", detail: "テキストを送信しました · dotが考えています", step: 2 },
  playing: { code: "PLAY", label: "音声を再生中", detail: "スマホ・イヤホンでdotの声を再生しています", step: -1 },
  switching: { code: "SWITCH", label: "入力方法を切替中", detail: "前の音声入力を閉じています", step: -1 },
  reconnecting: { code: "RELINK", label: "接続を復旧中", detail: "接続と通話状態を確認しています", step: -1 },
  error: { code: "CHECK", label: "接続を確認", detail: "画面の案内を確認して、もう一度お試しください", step: -1 },
};
export interface DotMessage { id: string; sequence: number; text: string; receivedAt: number; role?: "user" | "assistant"; inputId?: string; sourceId?: string }
export interface SavedInbox { cursor: number; initialized: boolean; history: DotMessage[]; seen: string[]; conversation?: { epoch: string; revision: number } }
export interface ConversationSnapshot { epoch: string; revision: number; ready: boolean; gap: boolean; items: DotMessage[] }
export type InputMode = "phone" | "text";
export const TEXT_STAGES = ["READY", "REC", "ASR", "DOT"] as const;
const layout = { columns: 32, bodyLines: 4 };
export class DotsModel {
  private readonly replyViewport = new TextViewportCache(layout);
  private readonly asrViewport = new TextViewportCache(layout);
  readonly hud = new GlassesHud();
  awake = true;
  screenSide: GlassesSide = "right";
  animateCharacter = false;
  wakeOnIncoming = true;
  private manuallySleeping = false;
  phase: EchoPhase = "idle";
  connected = false;
  reply = "";
  transcript = "";
  pendingTranscript = false;
  asrOffset = 0;
  offset = 0;
  notice = "";
  notificationId?: string;
  cursor = 0;
  initialized = false;
  history: DotMessage[] = [];
  historyRevision = 0;
  conversation?: { epoch: string; revision: number };
  private pendingWakeSource?: string;
  private pendingWakeLatest = false;
  get orderedHistory(): boolean { return !!this.conversation; }
  seen = new Set<string>();
  inputMode: InputMode = "phone";
  callActive = false;
  activity: Activity = "ready";
  activityAt = Date.now();
  audioReady = false;
  selectedId?: string;
  private latestReadId?: string;
  private visibleLimit: HistoryLimit = 100;
  constructor(saved?: SavedInbox) {
    if (saved && Number.isSafeInteger(saved.cursor) && saved.cursor >= 0) {
      this.cursor = saved.cursor; this.initialized = saved.initialized === true;
      this.history = Array.isArray(saved.history) ? saved.history.filter(validMessage).slice(-100) : [];
      this.seen = new Set(Array.isArray(saved.seen) ? saved.seen.filter(v => typeof v === "string").slice(-2048) : []);
      if (saved.conversation && typeof saved.conversation.epoch === "string" && Number.isSafeInteger(saved.conversation.revision)) this.conversation = { ...saved.conversation };
      this.latest();
    }
  }
  get historyLimit(): HistoryLimit { return this.visibleLimit; }
  get messageCount(): number { return Math.min(this.history.length, this.visibleLimit); }
  private get firstVisibleIndex(): number { return this.history.length - this.messageCount; }
  get visibleHistory(): readonly DotMessage[] { return this.history.slice(this.firstVisibleIndex); }
  setHistoryLimit(value: unknown): void {
    this.visibleLimit = historyLimit(value);
    this.keepSelectionVisible();
  }
  private keepSelectionVisible(): void {
    if (this.selectedId && this.history.length && this.history.findIndex(item => item.id === this.selectedId) < this.firstVisibleIndex) {
      this.select(this.history[this.firstVisibleIndex]!.id);
    }
  }
  incoming(item: DotMessage, wake = true): boolean {
    if (!validMessage(item) || item.sequence < 1) return false;
    this.cursor = Math.max(this.cursor, item.sequence);
    if (this.orderedHistory) return item.role !== "user" && this.notifyOnly(item.id, item.sourceId, wake);
    return item.role === "user" ? this.historyMessage(item) : this.message(item, wake);
  }
  /** Text replies do not advance the independent notification cursor. */
  textReply(id: string, text: string, receivedAt = Date.now(), wake = true): boolean {
    if (this.orderedHistory) return this.notifyOnly(id, undefined, wake);
    return this.message({ id, text, receivedAt, sequence: 0 }, wake);
  }
  historyReply(id: string, text: string, receivedAt: number): boolean {
    if (this.orderedHistory) return false;
    return this.historyMessage({ id, text, receivedAt, sequence: 0 });
  }
  /** Replace legacy arrival-sorted cache with an authoritative DOM window. Silent. */
  applyConversation(snapshot: ConversationSnapshot): boolean {
    if (!snapshot || typeof snapshot.epoch !== "string" || !snapshot.epoch || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || typeof snapshot.ready !== "boolean" || typeof snapshot.gap !== "boolean" || !Array.isArray(snapshot.items) || snapshot.items.length > 100
      || snapshot.items.some(row => !validMessage(row) || !row.text.trim() || typeof row.sourceId !== "string"
        || row.id !== `dom:${row.sourceId}` || row.role !== "user" && row.role !== "assistant")
      || new Set(snapshot.items.map(row => row.id)).size !== snapshot.items.length) throw new Error("会話履歴の同期結果が不正です");
    if (this.conversation?.epoch === snapshot.epoch && snapshot.revision <= this.conversation.revision) return false;
    const selected = this.selectedId, offset = this.offset;
    const migrating = !this.conversation;
    const follow = !selected || selected === this.history.at(-1)?.id
      || selected === [...this.history].reverse().find(row => row.role !== "user")?.id;
    this.conversation = { epoch: snapshot.epoch, revision: snapshot.revision };
    this.history = snapshot.items.map(row => ({ ...row })); this.historyRevision++;
    const wakingItem = this.pendingWakeSource ? this.history.find(row => row.sourceId === this.pendingWakeSource) : undefined;
    if (wakingItem) { this.select(wakingItem.id); this.pendingWakeSource = undefined; this.pendingWakeLatest = false; }
    else if (this.pendingWakeLatest && this.history.at(-1)?.role === "assistant") { this.latest(); this.pendingWakeLatest = false; }
    else if (!migrating && selected && this.history.findIndex(row => row.id === selected) >= this.firstVisibleIndex
      && (!follow || selected === this.history.at(-1)?.id)) {
      this.select(selected); this.offset = Math.min(offset, this.replyViewport.get(this.reply, 0).pages - 1);
    } else if (this.history.length) this.latest();
    else { this.selectedId = undefined; this.reply = ""; this.offset = 0; }
    return true;
  }
  /** Live notifications drive wake only; their arrival order never changes history. */
  private notifyOnly(id: string, sourceId: string | undefined, wake: boolean): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id); while (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    this.notificationId = id;
    if (wake && this.wakeFromDot()) {
      const item = sourceId ? this.history.find(row => row.sourceId === sourceId) : undefined;
      if (item) this.select(item.id);
      else if (sourceId) this.pendingWakeSource = sourceId;
      else { this.latest(); this.pendingWakeLatest = true; }
    }
    return true;
  }
  private historyMessage(item: DotMessage): boolean {
    const selected = this.selectedId, offset = this.offset;
    const changed = this.message(item, false);
    if (!changed) return false;
    this.history.sort((a, b) => a.receivedAt - b.receivedAt);
    if (selected && this.history.findIndex(value => value.id === selected) >= this.firstVisibleIndex) {
      this.select(selected); this.offset = Math.min(offset, this.replyViewport.get(this.reply, 0).pages - 1);
    } else if (selected && this.history.length) this.select(this.history[this.firstVisibleIndex]!.id);
    else this.latest();
    return true;
  }
  private message(item: DotMessage, wake: boolean): boolean {
    if (!validMessage(item) || !item.text.trim()) return false;
    const existing = this.history.find(v => v.id === item.id);
    if (existing) {
      existing.sequence = Math.max(existing.sequence, item.sequence);
      if (existing.text === item.text) return false;
      existing.text = item.text;
      this.historyRevision++;
      if (this.selectedId === item.id) { this.reply = item.text; this.offset = Math.min(this.offset, this.viewport.pages - 1); }
      return true;
    }
    if (this.seen.has(item.id)) return false;
    const follow = !this.selectedId || this.selectedId === this.history.at(-1)?.id
      || this.selectedId === [...this.history].reverse().find(value => value.role !== "user")?.id;
    this.seen.add(item.id);
    while (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    this.history = [...this.history, item].sort((a, b) => a.receivedAt - b.receivedAt).slice(-100);
    this.historyRevision++;
    if (item.role !== "user") this.notificationId = item.id;
    if (follow && item.role !== "user") this.latest();
    else this.keepSelectionVisible();
    if (item.role !== "user" && wake && this.wakeFromDot()) this.latest();
    return true;
  }
  sleepDisplay(): void { this.awake = false; this.manuallySleeping = true; }
  wakeDisplay(): void { this.awake = true; this.manuallySleeping = false; }
  /** Return true only when this notification actually lights the display. */
  wakeFromDot(): boolean {
    if (this.manuallySleeping && !this.wakeOnIncoming) return false;
    const waking = !this.awake; this.wakeDisplay(); return waking;
  }
  toggleDisplay(): void { if (this.awake) this.sleepDisplay(); else this.wakeDisplay(); }
  select(id: string, firstPage = true): void {
    const index = this.history.findIndex(v => v.id === id); if (index < this.firstVisibleIndex) return;
    const item = this.history[index]; if (!item) return;
    this.selectedId = id; this.reply = item.text;
    if (id === this.history.at(-1)?.id) this.latestReadId = id;
    this.offset = firstPage ? this.replyViewport.get(item.text, 0).pages - 1 : 0;
  }
  latest(): void { const item = this.history.at(-1); if (item) this.select(item.id); }
  /** Positive means older: pages first, then the preceding message. */
  scroll(delta: number): void {
    if (this.asrVisible) { this.asrOffset = Math.max(0, Math.min(this.viewport.pages - 1, this.asrOffset + Math.sign(delta))); return; }
    const index = this.history.findIndex(v => v.id === this.selectedId);
    if (delta > 0) {
      if (this.offset < this.viewport.pages - 1) this.offset++;
      else if (index > this.firstVisibleIndex) this.select(this.history[index - 1]!.id, false);
    } else if (delta < 0) {
      if (this.offset > 0) this.offset--;
      else if (index >= 0 && index < this.history.length - 1) this.select(this.history[index + 1]!.id);
    }
  }
  get messageIndex(): number { const index = this.history.findIndex(v => v.id === this.selectedId); return index < this.firstVisibleIndex ? -1 : index - this.firstVisibleIndex; }
  get canOlder(): boolean { return this.asrVisible ? this.asrOffset < this.viewport.pages - 1 : this.offset < this.viewport.pages - 1 || this.messageIndex > 0; }
  get canNewer(): boolean { return this.asrVisible ? this.asrOffset > 0 : this.offset > 0 || (this.messageIndex >= 0 && this.messageIndex < this.messageCount - 1); }
  get unread(): number {
    const read = this.history.findIndex(value => value.id === this.latestReadId);
    return this.latestReadId ? this.history.slice(Math.max(this.firstVisibleIndex, read + 1)).filter(value => value.role !== "user").length : 0;
  }
  get selectedRole(): "user" | "assistant" { return this.history.find(value => value.id === this.selectedId)?.role === "user" ? "user" : "assistant"; }
  get normalSide(): GlassesSide { return this.screenSide === "right" ? "left" : "right"; }
  get screenSideLabel(): string { return this.screenSide === "right" ? "右" : "左"; }
  get normalSideLabel(): string { return this.normalSide === "right" ? "右" : "左"; }
  get controlsHint(): string {
    if (this.awake && this.textInputActive && this.pendingTranscript) return "G2左右 / R1: 長押しでDotに送信 · 2タップで破棄\n通常操作側のスワイプで認識結果のページ移動\nタップ→長押しのメニューでも送信 / 破棄";
    return `G2${this.normalSideLabel} / R1長押しで話す · G2${this.screenSideLabel}長押しで入力切替\n${this.callActive ? "点灯中はG2右2タップで通話終了" : `G2${this.screenSideLabel}2タップで消灯 / 点灯`} · 消灯中も通話PTTを維持\nタップ→長押しでメニュー · 通常操作側のスワイプで履歴`;
  }
  get textInputActive(): boolean { return this.inputMode === "text" && !this.callActive; }
  get asrCardVisible(): boolean { return this.textInputActive && !!this.transcript
    && (this.pendingTranscript || ["recording", "recognizing"].includes(this.activity)); }
  get modeLabel(): string { return this.inputMode === "phone" ? "電話" : "音声→テキスト"; }
  setActivity(activity: Activity): void { if (this.activity !== activity) { this.activity = activity; this.activityAt = Date.now(); } }
  get status() {
    const status = ACTIVITY[this.activity];
    if (this.activity !== "ready") return status;
    if (!this.awake) return { ...status, code: "SLEEP", label: "G2は消灯中", detail: `${this.screenSideLabel}2タップで点灯 · 接続済みの通話では長押しでPTT` };
    return { ...status, detail: this.callActive ? `${this.normalSideLabel}/R1長押しでPTT · 右2タップで通話終了` : `${this.normalSideLabel}/R1長押しで話す · ${this.screenSideLabel}長押しで入力切替 · ${this.screenSideLabel}2タップで消灯` };
  }
  get linkHeading(): string { return `DOT / ${this.callActive ? "CALL" : this.inputMode === "text" ? "TEXT" : "PHONE"}  ·  ${this.status.code}`; }
  get textStage(): number { return this.status.step >= 0 ? this.status.step + 1 : this.activity === "ready" ? 0 : -1; }
  get footer(): string {
    if (this.textInputActive) return TEXT_STAGES.map((v, i) => i === this.textStage ? `[${v}]` : v).join(" > ")
      + (this.pendingTranscript ? " / 長押し:送信 · 2タップ:破棄" : "");
    return this.callActive ? `${this.normalSideLabel}/R1: PTT · 右2タップ: 終了` : `${this.normalSideLabel}/R1: 話す · ${this.screenSideLabel}: 切替/消灯`;
  }
  // Once submitted, leave the reply pane free for history even while Dot is thinking.
  get asrVisible(): boolean { return this.asrCardVisible; }
  get viewport() { return this.asrVisible ? this.asrViewport.get(this.transcript, this.asrOffset) : this.replyViewport.get(this.reply || (this.orderedHistory && this.conversation?.revision === 0 ? "履歴を同期中。\nChromeのDotsページを開いてね。" : "ここにいるよ。\n長押しで話してね。"), this.offset); }
  get heading(): string {
    if (this.asrVisible) return `${this.pendingTranscript ? "ASR確認 · 長押しで送信" : "あなた / ASR"}${this.viewport.pages > 1 ? ` P${this.viewport.page}/${this.viewport.pages}` : ""}`;
    return `${this.selectedRole === "user" ? "あなた" : "dot"} ${this.history.length ? `${this.messageIndex + 1}/${this.messageCount}` : "から"}${this.viewport.pages > 1 ? ` P${this.viewport.page}/${this.viewport.pages}` : ""}${this.unread ? ` 新着${this.unread}` : ""}`;
  }
  save(): SavedInbox { return { cursor: this.cursor, initialized: this.initialized, history: this.history, seen: [...this.seen], ...(this.conversation ? { conversation: this.conversation } : {}) }; }
}
function validMessage(value: unknown): value is DotMessage {
  const v = value as DotMessage;
  return !!v && typeof v.id === "string" && typeof v.text === "string" && Number.isSafeInteger(v.sequence) && v.sequence >= 0 && Number.isFinite(v.receivedAt)
    && (v.role === undefined || v.role === "user" || v.role === "assistant")
    && (v.inputId === undefined || typeof v.inputId === "string");
}
