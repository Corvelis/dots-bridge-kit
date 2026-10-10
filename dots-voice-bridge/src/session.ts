import { randomUUID } from "node:crypto";
import { secretMatches, type AudioRoute, type CallController, type CallSnapshot } from "./protocol";
import { nativeFailureDetails } from "./native-audio";

export const CALL_RECOVERY_GRACE_MS = 60_000;

export class VoiceSession {
  phase: "idle" | "starting" | "active" | "stopping" | "needs-stop" = "idle";
  sessionId?: string;
  owner?: string;
  inputEnabled = false;
  readonly route = "original" as const;
  streamId = randomUUID();
  inputBytes = 0;
  outputBytes = 0;
  private controller?: AbortController;
  private queue: Promise<unknown> = Promise.resolve();
  private callAttempted = false;
  private ownerResumeKey?: string;
  private clientRecoveryUntil = 0;
  private browserRecoveryUntil = 0;
  private audioRecoveryUntil = 0;
  private audioRecoveryTimer?: NodeJS.Timeout;
  private audioRecoveryAbort?: AbortController;
  private audioRecoveryTask?: Promise<void>;
  private audioFailureGeneration = 0;
  private clientRecoveryTimer?: NodeJS.Timeout;
  private browserRecoveryTimer?: NodeJS.Timeout;
  private browserProbeTimer?: NodeJS.Timeout;
  private browserProbeRunning = false;
  private lastEnd?: { reason: string; at: number };
  constructor(private options: {
    browser: CallController; audio: AudioRoute;
    emit(message: unknown): void;
    output(pcm: Buffer, sampleRate: number, channels: number, streamId: string): void;
    saveRecovery(sessionId: string | null): void;
    recoveredSession?: string;
    record?(event: string, detail: Record<string, string | number | boolean | null | undefined>): void;
  }) {
    this.sessionId = options.recoveredSession;
    if (options.audio.heldInput || options.recoveredSession) this.phase = "needs-stop";
  }
  get status() {
    const deadline = Math.min(...[this.browserRecoveryUntil, this.clientRecoveryUntil, this.audioRecoveryUntil].filter(Boolean));
    return { phase: this.phase, sessionId: this.sessionId ?? null, owner: this.owner ?? null,
      inputEnabled: this.inputEnabled, route: this.route, streamId: this.streamId,
      browserOnline: this.options.browser.online, inputHeld: this.options.audio.heldInput,
      inputBytes: this.inputBytes, outputBytes: this.outputBytes,
      recovery: { browser: !!this.browserRecoveryUntil, client: !!this.clientRecoveryUntil, audio: !!this.audioRecoveryUntil,
        deadline: Number.isFinite(deadline) ? deadline : null },
      lastEnd: this.lastEnd ?? null };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => {}); return next;
  }
  start(owner: string, resumeKey?: string): Promise<unknown> {
    if (this.phase !== "idle") return Promise.reject(new Error("A call is already active or requires confirmed cleanup"));
    this.phase = "starting"; this.owner = owner; this.sessionId = randomUUID();
    this.ownerResumeKey = resumeKey;
    this.record("call-starting");
    this.controller = new AbortController(); this.callAttempted = false;
    this.publish();
    return this.serial(async () => {
      const signal = this.controller!.signal;
      try {
        let before = await this.options.browser.command("status");
        signal.throwIfAborted();
        if (before.state === "unknown" && !before.ownedSession) {
          before = await this.options.browser.command("prepare");
          signal.throwIfAborted();
        }
        if (before.state !== "idle" || before.ownedSession) throw new Error("End the existing Dots call before starting a bridge call");
        signal.throwIfAborted();
        this.inputBytes = 0; this.outputBytes = 0;
        await this.options.audio.prepare(pcm => this.sourceAudio(pcm), signal);
        signal.throwIfAborted();
        // Persist before dispatch; a crash or timeout never implies the call ended.
        this.options.saveRecovery(this.sessionId!); this.callAttempted = true;
        const after = await this.options.browser.command("start", this.sessionId);
        if (after.state !== "active" || after.ownedSession !== this.sessionId || after.muted !== false) throw new Error("Dot call readiness or microphone state could not be confirmed");
        signal.throwIfAborted();
        this.phase = "active"; this.inputEnabled = false; this.resetOutput("session-start"); this.publish();
        this.record("call-started");
        return this.status;
      } catch (error) { this.record("call-start-failed"); await this.cleanup("start-failed"); throw error; }
    });
  }
  stop(owner?: string, reason = "client-request"): Promise<unknown> {
    if (owner && this.owner && owner !== this.owner) return Promise.reject(new Error("Another client owns this call"));
    this.inputEnabled = false;
    if (reason !== "dots-ended") { this.controller?.abort(); this.audioRecoveryAbort?.abort(); }
    return this.serial(async () => {
      if (this.phase !== "idle" || this.options.audio.heldInput) { this.record("call-stop-requested", { reason }); await this.cleanup(reason); }
      return this.status;
    });
  }
  setInput(owner: string, enabled: boolean) {
    if (this.phase !== "active" || owner !== this.owner) throw new Error("This client has no active call");
    if (enabled && (this.clientRecoveryUntil || this.browserRecoveryUntil || this.audioRecoveryUntil)) throw new Error("Call connection is recovering; release PTT and try again after recovery");
    if (enabled && !this.inputEnabled) { this.resetOutput("input-start"); }
    this.inputEnabled = enabled; this.publish(); return this.status;
  }
  append(owner: string, pcm: Buffer) {
    if (this.phase !== "active" || owner !== this.owner || !this.inputEnabled) return;
    if (pcm.length === 0 || pcm.length % 2 || pcm.length > 6400) throw new Error("Input must be at most 200ms of 16kHz mono PCM16");
    if (this.options.audio.append(pcm) !== false) this.inputBytes += pcm.length;
  }
  resetForOutputGap(): string {
    this.resetOutput("output-backpressure"); this.publish(); return this.streamId;
  }
  audioFailed(error: Error): void {
    if (this.phase === "starting") { this.controller?.abort(); return; }
    if (this.phase !== "active") return;
    this.audioFailureGeneration++;
    if (this.audioRecoveryUntil) return;
    this.inputEnabled = false; this.audioRecoveryUntil = Date.now() + CALL_RECOVERY_GRACE_MS;
    this.record("native-audio-recovery-started", { graceMs: CALL_RECOVERY_GRACE_MS, ...nativeFailureDetails(error) });
    this.options.emit({ type: "voice.notice", message: "Macの音声処理を復旧しています。通話は維持し、マイク入力を一時停止しています" }); this.publish();
    const abort = new AbortController(); this.audioRecoveryAbort = abort;
    this.audioRecoveryTimer = setTimeout(() => {
      if (this.audioRecoveryUntil && this.phase === "active") void this.stop(undefined, "native-audio-recovery-timeout").catch(() => {});
    }, CALL_RECOVERY_GRACE_MS); this.audioRecoveryTimer.unref();
    const task = this.recoverAudio(this.sessionId!, abort.signal); this.audioRecoveryTask = task;
    void task.finally(() => { if (this.audioRecoveryTask === task) this.audioRecoveryTask = undefined; });
  }
  private async recoverAudio(id: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, attempt === 2 ? 1000 : 3000);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
      if (signal.aborted || this.phase !== "active" || id !== this.sessionId) return;
      try {
        if (!this.options.audio.restart) throw new Error("Audio recovery is unavailable");
        this.record("native-audio-restart-attempt", { attempt });
        const generation = this.audioFailureGeneration;
        await this.options.audio.restart(pcm => this.sourceAudio(pcm), signal);
        if (signal.aborted || this.phase !== "active" || id !== this.sessionId) return;
        if (generation !== this.audioFailureGeneration) throw new Error("Replacement audio helper failed before recovery completed");
        this.clearAudioRecovery(false); this.resetOutput("audio-recovered");
        this.record("native-audio-recovered", { attempt }); this.publish();
        this.options.emit({ type: "voice.notice", message: "Macの音声が復旧しました。同じ通話を続けられます。もう一度長押しで話してください" });
        return;
      } catch (error) {
        if (signal.aborted) return;
        this.record("native-audio-restart-failed", { attempt, ...nativeFailureDetails(error as Error) });
      }
    }
    this.options.emit({ type: "voice.notice", message: "Macの音声復旧を待っています。通話は維持しますが、60秒以内に戻らない場合は終了します" });
  }
  private clearAudioRecovery(cancel = true): void {
    if (cancel) this.audioRecoveryAbort?.abort();
    clearTimeout(this.audioRecoveryTimer); this.audioRecoveryTimer = undefined;
    this.audioRecoveryUntil = 0; this.audioRecoveryAbort = undefined;
  }
  clientDisconnected(owner: string) {
    if (owner !== this.owner || !["active", "starting"].includes(this.phase) || this.clientRecoveryUntil) return;
    this.inputEnabled = false;
    this.clientRecoveryUntil = Date.now() + CALL_RECOVERY_GRACE_MS;
    this.record("client-recovery-started", { reason: "client-connection-lost", graceMs: CALL_RECOVERY_GRACE_MS });
    this.clientRecoveryTimer = setTimeout(() => {
      this.clientRecoveryTimer = undefined;
      if (this.owner === owner && this.clientRecoveryUntil && ["active", "starting"].includes(this.phase)) void this.stop(undefined, "client-recovery-timeout").catch(() => {});
    }, CALL_RECOVERY_GRACE_MS);
    this.clientRecoveryTimer.unref(); this.publish();
  }
  resumeClient(owner: string, key?: string): boolean {
    if (!this.clientRecoveryUntil || Date.now() >= this.clientRecoveryUntil || !this.ownerResumeKey || !secretMatches(this.ownerResumeKey, key)
      || !["active", "starting"].includes(this.phase)) return false;
    this.owner = owner; this.clientRecoveryUntil = 0;
    clearTimeout(this.clientRecoveryTimer); this.clientRecoveryTimer = undefined;
    if (this.phase === "active") this.resetOutput("receiver-resume");
    this.record("client-recovered"); this.publish(); return true;
  }
  pauseInput(reason: string) { this.inputEnabled = false; this.record("input-paused", { reason }); this.publish(); }
  browserChanged(snapshot?: CallSnapshot, reason = "browser-state-uncertain") {
    if (this.phase !== "active") return;
    if (snapshot?.state === "active" && snapshot.ownedSession === this.sessionId) {
      if (this.browserRecoveryUntil) {
        this.clearBrowserRecovery(); this.record("browser-recovered"); this.publish();
      }
      return;
    }
    this.inputEnabled = false;
    if (!this.browserRecoveryUntil) {
      this.browserRecoveryUntil = Date.now() + CALL_RECOVERY_GRACE_MS;
      this.record("browser-recovery-started", { reason, browserState: snapshot?.state ?? "offline", graceMs: CALL_RECOVERY_GRACE_MS });
      this.browserRecoveryTimer = setTimeout(() => {
        this.browserRecoveryTimer = undefined;
        if (this.phase === "active" && this.browserRecoveryUntil) void this.stop(undefined, "browser-recovery-timeout").catch(() => {});
      }, CALL_RECOVERY_GRACE_MS);
      this.browserRecoveryTimer.unref(); this.publish();
    }
    this.scheduleBrowserProbe();
  }
  private scheduleBrowserProbe() {
    if (this.browserProbeTimer || this.browserProbeRunning || !this.browserRecoveryUntil || this.phase !== "active") return;
    this.browserProbeTimer = setTimeout(() => {
      this.browserProbeTimer = undefined; void this.probeBrowser();
    }, 2000); this.browserProbeTimer.unref();
  }
  private async probeBrowser() {
    if (!this.browserRecoveryUntil || this.phase !== "active") return;
    this.browserProbeRunning = true;
    const id = this.sessionId;
    try {
      if (!this.options.browser.online) return;
      const snapshot = await this.options.browser.command("status");
      if (this.phase !== "active" || id !== this.sessionId || !this.browserRecoveryUntil) return;
      if (snapshot.state === "active" && snapshot.ownedSession === id) this.browserChanged(snapshot);
      else if (snapshot.state === "idle" && (!snapshot.ownedSession || snapshot.ownedSession === id)) await this.stop(undefined, "dots-ended");
    } catch { this.record("browser-recheck-failed"); }
    finally { this.browserProbeRunning = false; this.scheduleBrowserProbe(); }
  }
  private clearBrowserRecovery() {
    clearTimeout(this.browserRecoveryTimer); clearTimeout(this.browserProbeTimer);
    this.browserRecoveryTimer = this.browserProbeTimer = undefined; this.browserRecoveryUntil = 0;
  }
  private clearRecovery() {
    this.clearBrowserRecovery(); clearTimeout(this.clientRecoveryTimer); this.clientRecoveryTimer = undefined; this.clientRecoveryUntil = 0;
    this.clearAudioRecovery();
  }
  private record(event: string, detail: Record<string, string | number | boolean | null | undefined> = {}) {
    this.options.record?.(event, { phase: this.phase, sessionId: this.sessionId, clientId: this.owner,
      browserOnline: this.options.browser.online, inputBytes: this.inputBytes, outputBytes: this.outputBytes, ...detail });
  }
  private sourceAudio(pcm: Buffer) {
    if (this.phase !== "active") return;
    this.output(pcm, 48_000, 2);
  }
  private output(pcm: Buffer, rate: number, channels: number) {
    this.outputBytes += pcm.length; this.options.output(pcm, rate, channels, this.streamId);
  }
  private resetOutput(reason: string) { this.streamId = randomUUID(); this.options.emit({ type: "audio.reset", streamId: this.streamId, reason }); }
  private publish() { this.options.emit({ type: "voice.state", ...this.status }); }
  private async cleanup(reason: string) {
    // A tentative Dots-side end may prove transient. Keep recovery running
    // until its fresh status check actually confirms that the call has ended.
    if (reason !== "dots-ended") { this.phase = "stopping"; this.inputEnabled = false; this.publish(); }
    let confirmedIdle = !this.callAttempted && !this.options.recoveredSession;
    try {
      // A fresh status can prove an idle call after reload or a service-side end.
      const status = await this.options.browser.command("status");
      // A tentative idle observation must never become a hangup of a call
      // that a fresh status proves is still active/uncertain.
      if (reason === "dots-ended" && status.state !== "idle") {
        this.phase = "active"; this.record("browser-idle-not-confirmed", { browserState: status.state });
        this.browserChanged(status); this.publish(); return;
      }
      if (status.state === "idle" && (!status.ownedSession || status.ownedSession === this.sessionId)) {
        if (status.ownedSession && this.sessionId) { this.record("browser-marker-release", { reason }); await this.options.browser.command("stop", this.sessionId); }
        confirmedIdle = true;
      }
      else if (this.sessionId && status.ownedSession === this.sessionId) {
        this.record("browser-hangup-dispatched", { reason });
        confirmedIdle = (await this.options.browser.command("stop", this.sessionId)).state === "idle";
      }
    } catch (error) {
      if (reason === "dots-ended") { this.phase = "active"; this.record("browser-idle-recheck-failed"); this.scheduleBrowserProbe(); this.publish(); return; }
      this.record("call-end-unconfirmed", { reason });
      this.options.emit({ type: "voice.notice", message: `通話の終了確認待ちです: ${(error as Error).message}` });
    }
    this.phase = "stopping"; this.inputEnabled = false; this.publish();
    this.audioRecoveryAbort?.abort(); await this.audioRecoveryTask;
    try { await this.options.audio.stop(confirmedIdle); }
    catch (error) { confirmedIdle = false; this.options.emit({ type: "voice.notice", message: `音声入力の復元を確認できません: ${(error as Error).message}` }); }
    this.phase = confirmedIdle && !this.options.audio.heldInput ? "idle" : "needs-stop";
    this.clearRecovery(); this.lastEnd = { reason, at: Date.now() };
    this.record("call-ended", { reason });
    if (this.phase === "idle") {
      this.options.saveRecovery(null); this.options.recoveredSession = undefined; this.sessionId = undefined; this.callAttempted = false;
    }
    this.owner = undefined; this.ownerResumeKey = undefined; this.resetOutput("session-stop"); this.publish();
  }
}
