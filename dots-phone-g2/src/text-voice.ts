import type { EchoPhase, ServerMessage } from "../../shared/protocol";
import { DotsModel } from "./model";
import type { WireMessage } from "./socket";

export interface TextVoicePort { ready: boolean; send(message: WireMessage): boolean }
interface Turn { notificationId?: string; completed: boolean; deadline: number; submitted?: boolean }

/** Local Mac ASR → Dot text conversation. */
export class TextVoiceSession {
  available = false;
  reviewSupported = false;
  busy = false;
  phase: EchoPhase = "idle";
  private sessionId = "";
  private turnId = 0;
  private ignoredThrough = -1;
  private turns = new Map<number, Turn>();
  private starting?: { resolve(): void; reject(error: Error): void; deadline: number };
  constructor(private port: TextVoicePort, private model: DotsModel, private callbacks: {
    active(): boolean;
    review?(): boolean;
    changed(): void;
    displayed(): Promise<void>;
    error(error: unknown): void;
    disconnected(): void;
  }) {}
  startInput(): Promise<void> {
    if (!this.port.ready || !this.available) return Promise.reject(new Error("音声→テキストのブリッジを確認してください（Dot接続・Macの音声認識）"));
    if (!this.callbacks.active() || this.busy) return Promise.reject(new Error("今の入力・返答が終わるまでお待ちください"));
    const review = this.callbacks.review?.() === true;
    if (review && !this.reviewSupported) return Promise.reject(new Error("ASR確認にはMacのテキスト会話ブリッジの更新が必要です"));
    this.model.transcript = ""; this.model.pendingTranscript = false; this.model.asrOffset = 0; this.busy = true;
    return new Promise((resolve, reject) => {
      this.starting = { resolve, reject, deadline: Date.now() + 10_000 };
      if (!this.port.send({ type: "echo.voice.start", ...(review ? { reviewTranscript: true } : {}) })) this.fail(new Error("Macへの接続が切れました"));
      this.callbacks.changed();
    });
  }
  stopInput(): void {
    if (this.phase !== "listening") return;
    this.setPhase("transcribing");
    if (!this.port.send({ type: "echo.voice.stop" })) this.fail(new Error("音声入力を送信できませんでした"));
  }
  submitTranscript(): void {
    if (!this.model.pendingTranscript || !this.callbacks.active()) return;
    if (!this.port.send({ type: "echo.transcript.submit", turnId: this.turnId })) { this.fail(new Error("認識結果を送信できませんでした")); return; }
    this.model.pendingTranscript = false;
    const item = this.turns.get(this.turnId); if (item) { item.deadline = Date.now() + 120_000; item.submitted = true; }
    this.setPhase("thinking");
  }
  discardTranscript(): void {
    if (!this.model.pendingTranscript) return;
    this.model.transcript = ""; this.cancel();
    this.model.notice = "認識結果を破棄しました。Dotには送信していません"; this.callbacks.changed();
  }
  tick(now: number): void {
    if (this.starting && now >= this.starting.deadline) { this.cancel(); this.callbacks.error(new Error("音声認識の開始が時間内に完了しませんでした")); }
    const item = this.turns.get(this.turnId);
    if (this.busy && !this.starting && !this.model.pendingTranscript && this.phase !== "listening" && item && !item.completed && now >= item.deadline) {
      this.fail(new Error("返答が時間内に届きませんでした。入力方法を切り替えるか、もう一度お試しください"));
    }
  }
  cancel(): void {
    this.ignoredThrough = Math.max(this.ignoredThrough, this.turnId);
    if (this.busy) this.port.send({ type: "echo.cancel" });
    this.starting?.reject(new Error("音声入力を取り消しました")); this.starting = undefined;
    this.turns.clear(); this.busy = false; this.model.pendingTranscript = false; this.setPhase("idle");
  }
  disconnected(): void {
    this.starting?.reject(new Error("テキスト会話ブリッジとの接続が切れました")); this.starting = undefined;
    this.available = false; this.reviewSupported = false; this.busy = false; this.model.pendingTranscript = false; this.turns.clear(); this.sessionId = "";
    this.setPhase("idle"); if (this.callbacks.active()) this.model.setActivity("reconnecting"); this.callbacks.disconnected();
  }
  handle(message: ServerMessage): void {
    if (message.type === "echo.snapshot") {
      if (this.sessionId && this.sessionId !== message.snapshot.sessionId) this.disconnected();
      const config = message.snapshot.config;
      this.reviewSupported = config.transcriptReview === true;
      this.available = !!(config.dedicatedDots && config.dotsReady && config.asrReady);
      if (this.sessionId !== message.snapshot.sessionId) {
        this.sessionId = message.snapshot.sessionId; this.turnId = 0; this.ignoredThrough = -1; this.turns.clear();
      }
      if (!this.available && this.busy) { this.cancel(); this.callbacks.disconnected(); }
      // Periodic readiness reports must not reset an active recording or draft.
      if (!this.available) this.setPhase("error");
      else if (!this.busy) this.setPhase(message.snapshot.phase);
      else this.callbacks.changed();
      return;
    }
    if (message.type === "error") { this.fail(new Error(message.message)); return; }
    if (!("turnId" in message) || typeof message.turnId !== "number") return;
    const turn = message.turnId;
    if (turn <= this.ignoredThrough || turn < this.turnId) return;
    this.turnId = turn;
    const item: Turn = this.turns.get(turn) ?? { completed: false, deadline: Date.now() + 120_000 };
    this.turns.set(turn, item);
    while (this.turns.size > 100) this.turns.delete(this.turns.keys().next().value!);
    switch (message.type) {
      case "echo.state":
        if (this.model.pendingTranscript) break;
        if (message.phase === "listening" && this.starting) {
          this.setPhase("listening"); this.starting.resolve(); this.starting = undefined;
        } else if (message.phase === "listening" && !this.busy) {
          // A late acknowledgement must never reopen capture.
          this.ignoredThrough = turn; this.port.send({ type: "echo.cancel" });
        } else if (message.phase === "idle") {
          if (message.message?.startsWith("NO SPEECH")) {
            this.busy = false; item.completed = true; this.setPhase("idle");
            this.model.notice = "音声を認識できませんでした。もう一度、長押しで話してください"; this.callbacks.changed();
          } else if (!this.busy || item.completed) { this.busy = false; this.setPhase("idle"); }
        } else if (!item.completed) this.setPhase(message.phase);
        break;
      case "echo.transcript":
        this.model.transcript = message.text;
        this.model.asrOffset = Math.min(this.model.asrOffset, this.model.viewport.pages - 1);
        if (message.final && message.awaitingConfirmation && message.text.trim() && !item.submitted) {
          this.model.pendingTranscript = true; this.busy = true;
          this.model.wakeDisplay(); this.model.phase = "idle"; this.model.setActivity("reviewing");
        }
        this.callbacks.changed(); break;
      case "echo.dots.incoming":
      case "echo.notification": {
        item.notificationId = message.notificationId;
        this.model.textReply(message.notificationId.replace(/^dots:/, ""), message.content, message.createdAt);
        if (this.callbacks.active()) this.busy = true;
        this.callbacks.changed();
        if (message.type === "echo.notification") {
          const session = this.sessionId;
          void this.callbacks.displayed().then(() => {
            if (this.sessionId === session && this.turns.get(turn) === item) this.port.send({ type: "echo.notification.displayed", turnId: turn, notificationId: message.notificationId });
          }).catch(this.callbacks.error);
        }
        break;
      }
      case "echo.reply":
        if (!message.provisional && !item.notificationId) {
          this.model.textReply(`text:${this.sessionId}:${turn}`, message.text);
          this.callbacks.changed();
        }
        break;
      case "echo.done":
        item.completed = true; this.busy = false; this.setPhase("idle"); break;
      case "echo.error": this.fail(new Error(message.message)); break;
    }
  }
  private setPhase(phase: EchoPhase): void {
    this.phase = phase;
    if (this.callbacks.active()) {
      this.model.phase = phase;
      this.model.setActivity(phase === "listening" ? "recording" : phase === "transcribing" ? "recognizing" : phase === "thinking" ? "waiting" : phase === "error" ? "error" : "ready");
    }
    this.callbacks.changed();
  }
  private fail(error: Error): void {
    if (this.busy) this.port.send({ type: "echo.cancel" });
    this.starting?.reject(error); this.starting = undefined;
    this.ignoredThrough = Math.max(this.ignoredThrough, this.turnId);
    this.turns.clear(); this.busy = false; this.model.pendingTranscript = false; this.setPhase("error"); this.callbacks.disconnected(); this.callbacks.error(error);
  }
}
