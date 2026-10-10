import { MOUTH_FRAME_MS } from "./audio-envelope";
import { PcmMouthTimeline } from "./pcm-mouth";
import { MusicVoiceBoost, type MusicVoiceBoostMode } from "./music-voice-boost";
import { ContinuousPcmClock } from "./pcm-clock";

interface WebAudioSession extends EventTarget {
  type: "auto" | "ambient" | "playback" | "play-and-record";
  readonly state?: string;
}

export interface PcmChunk {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number | null;
  streamId?: string;
}

export interface PcmPlayerDiagnostic {
  event: string;
  detail: string;
  receivedBytes: number;
  playedBytes: number;
  queueLength: number;
  sessionType: string;
  sessionState: string;
  streamId?: string;
  timing?: Record<string, number | string | boolean>;
}

interface QueuedAudio {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
}

export interface RecordingPlaybackOptions {
  keepPlayback?: boolean;
}

export interface PlaybackEnableOptions {
  confirmationTone?: boolean;
}

// The WebSocket can deliver an otherwise continuous reply in bursts. Waiting
// through those short gaps avoids turning every burst into a separate media
// element load on iOS.
const flushDelayMs = 360;
const routeSettleMs = 180;
const scheduledStartLeadSeconds = 0.025;
const scheduledTailHoldMs = 160;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

export class PcmStreamPlayer {
  private readonly speech = new Audio();
  private readonly keeper = new Audio();
  private readonly testTone = new Audio();
  private readonly audioSession = (navigator as Navigator & { audioSession?: WebAudioSession }).audioSession;
  private preferLowLatency: boolean;
  private audioContext: AudioContext | undefined;
  private outputGain: GainNode | undefined;
  private outputLevel = 1;
  private duplexRecording = false;
  private lowLatencyReady = false;
  private scheduledNextTime = 0;
  private scheduledGeneration = 0;
  private scheduledPcmBytes = 0;
  private scheduledSources = new Map<AudioBufferSourceNode, number>();
  private scheduledTailTimer: number | undefined;
  private scheduledResumeInFlight = false;
  private streamId: string | undefined;
  private packetLeadMs: 80 | 250 | undefined;
  private readonly packetClock = new ContinuousPcmClock();
  private readonly audibleSources = new Set<AudioBufferSourceNode>();
  private outputMonitor: number | undefined;
  private outputOnsets: { kind: string; time: number }[] = [];
  private audibleOnsetQueued = false;
  private lastBufferReportAt = 0;
  private enabled = false;
  private backgroundSuspended = true;
  private externalMediaPlaying = false;
  private musicVoiceBoostMode: MusicVoiceBoostMode = "strong";
  private readonly musicVoiceBoost = new MusicVoiceBoost();
  private playing = false;
  private warmingSpeech = false;
  private stopping = false;
  private playInFlight = false;
  private queue: QueuedAudio[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private pendingSampleRate = 48_000;
  private pendingChannels = 2;
  private flushTimer: number | undefined;
  private restoreTimer: number | undefined;
  private objectUrl = "";
  private currentPcmBytes = 0;
  private receivedBytes = 0;
  private playedBytes = 0;
  private readonly mouthTimeline = new PcmMouthTimeline();
  private mouthTimer: number | undefined;
  private mouthLevel = 0;
  private mouthHeldFrames = 0;
  private mouthFrameMs: 125 | 300 = MOUTH_FRAME_MS;

  constructor(
    private readonly onSpeakingChange: (speaking: boolean) => void,
    private readonly onDiagnostic?: (snapshot: PcmPlayerDiagnostic) => void,
    private readonly onError?: (message: string) => void,
    preferLowLatency = true,
    private readonly onMouthChange?: (level: number) => void,
  ) {
    this.preferLowLatency = preferLowLatency;
    this.prepareElement(this.speech);
    this.prepareElement(this.keeper);
    this.prepareElement(this.testTone);
    this.keeper.loop = true;
    this.keeper.src = wavDataUri(silentWavBytes(1_000));
    this.testTone.src = wavDataUri(testToneWavBytes());
    this.keeper.load();
    this.testTone.load();

    this.speech.addEventListener("playing", () => {
      if (this.warmingSpeech) return;
      this.playing = true;
      this.startMouthTracking();
      this.onSpeakingChange(true);
      this.report("playing", `${this.currentPcmBytes} PCM bytes`);
    });
    this.speech.addEventListener("ended", () => {
      if (this.warmingSpeech) {
        this.warmingSpeech = false;
        this.report("warmup-ended", "speech element authorized");
        return;
      }
      this.playedBytes += this.currentPcmBytes;
      this.resetMouthTracking();
      this.currentPcmBytes = 0;
      this.releaseUrl();
      this.report("ended", "speech element ended");
      void this.playNext();
    });
    this.speech.addEventListener("pause", () => {
      this.report("pause", this.stopping ? "requested" : "unexpected");
      if (!this.stopping && this.currentPcmBytes > 0 && !this.speech.ended) this.resumeCurrent();
    });
    this.speech.addEventListener("error", () => {
      const message = this.speech.error?.message || `HTML audio error ${this.speech.error?.code ?? 0}`;
      this.report("error", message);
      this.onError?.(message);
      this.currentPcmBytes = 0;
      this.playing = false;
      this.resetMouthTracking();
      this.releaseUrl();
      this.onSpeakingChange(false);
      void this.playNext();
    });
    this.audioSession?.addEventListener("statechange", this.onAudioSessionStateChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  get ready(): boolean {
    return this.enabled;
  }

  /** Change only visual sampling; keep PCM, its timeline and playback untouched. */
  setMouthFrameInterval(frameMs: 125 | 300): void {
    if (this.mouthFrameMs === frameMs) return;
    this.mouthFrameMs = frameMs;
    if (this.mouthTimer === undefined) return;
    window.clearInterval(this.mouthTimer);
    this.mouthTimer = undefined;
    this.startMouthTracking();
  }

  get playbackMode(): "low-latency" | "compatibility" {
    return this.preferLowLatency && (!this.enabled || this.lowLatencyReady)
      ? "low-latency"
      : "compatibility";
  }

  get requestedPlaybackMode(): "low-latency" | "compatibility" {
    return this.preferLowLatency ? "low-latency" : "compatibility";
  }

  setPlaybackMode(mode: "low-latency" | "compatibility"): void {
    if (this.playing || this.currentPcmBytes > 0 || this.scheduledSources.size > 0) return;
    this.preferLowLatency = mode === "low-latency";
    this.report("mode", this.playbackMode);
  }

  /** Called at stream boundaries, never for an individual packet. */
  setStreamProfile(streamId?: string, leadMs?: 80 | 250): void {
    this.clearBufferedAudio("stream profile changed");
    this.streamId = streamId;
    this.packetLeadMs = leadMs;
  }

  async enable(options: PlaybackEnableOptions = {}): Promise<void> {
    if (this.enabled) return;
    const confirmationTone = options.confirmationTone !== false;
    this.selectPlaybackSession();
    this.backgroundSuspended = false;

    // Start Web Audio from the same direct tap as the persistent media
    // elements. Its clock lets us schedule the 40 ms PCM frames without gaps.
    let contextReady: Promise<boolean> | undefined;
    try {
      const Context = window.AudioContext
        || (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
      if (Context) {
        this.audioContext ??= new Context({ latencyHint: "interactive", sampleRate: 48_000 });
        this.audioContext.addEventListener("statechange", this.onContextStateChange);
        this.ensureOutputGain(this.audioContext);
        // Attach rejection handling immediately. Startup auto-enable is
        // expected to be denied by standard iOS WebKit and must not leave an
        // unhandled AudioContext promise behind while media elements settle.
        contextReady = this.audioContext.resume().then(() => true, () => false);
        if (confirmationTone) this.scheduleEnableTone(this.audioContext);
      }
    } catch {
      this.audioContext = undefined;
    }

    // iOS authorizes each persistent HTMLAudioElement only inside a direct tap.
    // Keep a silent carrier alive and warm the speech element during that tap.
    const keeperPlay = this.keeper.play();
    this.speech.src = wavDataUri(silentWavBytes(20));
    this.speech.load();
    this.warmingSpeech = true;
    const speechWarmup = this.speech.play();
    const testPlay = confirmationTone ? this.testTone.play() : Promise.resolve();
    await Promise.all([keeperPlay, speechWarmup, testPlay]);
    if (contextReady) this.lowLatencyReady = await contextReady && this.audioContext?.state === "running";
    this.enabled = true;
    this.report(
      "enabled",
      this.playbackMode === "low-latency"
        ? `low-latency scheduler ready; ${confirmationTone ? "two test tones requested" : "silent auto-enable"}`
        : `compatibility player ready; ${confirmationTone ? "one test tone requested" : "silent auto-enable"}`,
    );
  }

  disable(): void {
    this.stop();
    this.enabled = false;
    this.backgroundSuspended = true;
    this.keeper.pause();
    this.testTone.pause();
    this.report("disabled", "phone audio disabled");
  }

  prepareForRecording(options: RecordingPlaybackOptions = {}): void {
    const keepPlayback = options.keepPlayback === true;
    if (this.restoreTimer !== undefined) window.clearTimeout(this.restoreTimer);
    this.restoreTimer = undefined;
    this.duplexRecording = keepPlayback;
    if (keepPlayback) {
      this.backgroundSuspended = false;
      this.setOutputLevel(1, 0);
      // G2 supplies PCM through the SDK; this WebView never records the iPhone
      // microphone. Keep its speaker/media session instead of changing routes.
      this.selectPlaybackSession();
      this.resumeAvailablePlayback();
      this.report("duplex-recording", "G2 microphone active; iPhone output remains at 100%");
      return;
    }

    this.backgroundSuspended = true;
    this.stopping = true;
    this.speech.pause();
    this.keeper.pause();
    if (this.audioContext?.state === "running") void this.audioContext.suspend();
    this.stopping = false;
    if (this.audioSession && this.audioSession.type !== "play-and-record") {
      this.audioSession.type = "play-and-record";
    }
    this.report("recording-session", "G2 microphone active");
  }

  /** The native SDK can interrupt Web Audio after prepareForRecording returns. */
  resumeDuringRecording(): void {
    if (!this.duplexRecording || !this.enabled) return;
    this.selectPlaybackSession();
    this.resumeAvailablePlayback();
  }

  restoreBackgroundPlayback(): void {
    this.duplexRecording = false;
    this.setOutputLevel(1, 0);
    if (!this.enabled) return;
    this.backgroundSuspended = false;
    this.selectPlaybackSession();
    if (this.restoreTimer !== undefined) window.clearTimeout(this.restoreTimer);
    this.restoreTimer = window.setTimeout(() => {
      this.restoreTimer = undefined;
      if (this.playbackMode === "low-latency") {
        void this.resumeScheduledPlayback();
      } else if (this.currentPcmBytes > 0 && this.speech.paused) {
        this.resumeCurrent();
      } else if (this.currentPcmBytes === 0) {
        void this.playNext();
      }
    }, routeSettleMs);
    this.report("playback-session", `settling ${routeSettleMs}ms`);
  }

  /** Mix Voice with MusicKit; only the silent HTML carrier yields to music. */
  setExternalMediaPlaying(playing: boolean): void {
    if (playing === this.externalMediaPlaying) return;
    this.externalMediaPlaying = playing;
    this.updateMusicVoiceBoost();
    if (playing) {
      if (this.restoreTimer !== undefined) window.clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
      this.keeper.pause();
      this.selectPlaybackSession();
      this.resumeAvailablePlayback();
      this.report("external-media-started", "Call audio mixes with external media; silent carrier paused");
      return;
    }
    this.report("external-media-stopped", "phone call playback available");
    if (this.enabled && !this.backgroundSuspended) this.restoreBackgroundPlayback();
  }

  setMusicVoiceBoost(mode: MusicVoiceBoostMode): void {
    this.musicVoiceBoostMode = mode;
    this.updateMusicVoiceBoost();
  }

  private updateMusicVoiceBoost(): void {
    const active = this.externalMediaPlaying && this.musicVoiceBoostMode === "strong";
    this.musicVoiceBoost.setActive(active);
    this.report("music-voice-boost", active ? "strong // up to +6 dB, peak limited" : "normal");
  }

  enqueue(chunk: PcmChunk): void {
    if (!this.enabled) return;
    if (chunk.streamId && chunk.streamId !== this.streamId) return;
    const channels = Math.max(1, Math.min(2, Math.floor(chunk.numChannels)));
    const sampleRate = Math.max(8_000, Math.min(96_000, Math.floor(chunk.sampleRate)));
    const bytes = decodeBase64(chunk.data);
    if (bytes.byteLength === 0) return;
    this.receivedBytes += bytes.byteLength;
    if (this.playbackMode === "low-latency" && this.audioContext) {
      this.enqueueScheduled(bytes, sampleRate, channels);
      // New backchannels must start even when PTT keeps the usual post-recording
      // playback preparation path closed, or native mic setup suspended audio.
      if (this.duplexRecording) this.resumeDuringRecording();
      this.report("received", `${bytes.byteLength} PCM bytes`);
      return;
    }
    if (
      this.pendingBytes > 0
      && (sampleRate !== this.pendingSampleRate || channels !== this.pendingChannels)
    ) this.flushPending();
    this.pendingSampleRate = sampleRate;
    this.pendingChannels = channels;
    this.pending.push(bytes.slice());
    this.pendingBytes += bytes.byteLength;
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPending();
    }, flushDelayMs);
    this.report("received", `${bytes.byteLength} PCM bytes`);
  }

  clearBufferedAudio(reason = "route reset"): void {
    this.musicVoiceBoost.reset();
    this.resetMouthTracking();
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = [];
    this.pendingBytes = 0;
    this.queue = [];
    this.currentPcmBytes = 0;
    this.playing = false;
    this.stopScheduledSources();
    this.stopping = true;
    this.speech.pause();
    this.stopping = false;
    this.releaseUrl();
    this.onSpeakingChange(false);
    this.ensureKeeper();
    this.report("cleared", reason);
  }

  stop(): void {
    this.musicVoiceBoost.reset();
    this.resetMouthTracking();
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
    if (this.restoreTimer !== undefined) window.clearTimeout(this.restoreTimer);
    this.flushTimer = undefined;
    this.restoreTimer = undefined;
    this.pending = [];
    this.pendingBytes = 0;
    this.queue = [];
    this.currentPcmBytes = 0;
    this.playing = false;
    this.duplexRecording = false;
    this.setOutputLevel(1, 0);
    this.stopScheduledSources();
    if (this.audioContext?.state === "running") void this.audioContext.suspend();
    this.stopping = true;
    this.speech.pause();
    this.stopping = false;
    this.releaseUrl();
    this.onSpeakingChange(false);
    this.report("stopped", "queue cleared");
  }

  dispose(): void {
    this.stop();
    this.enabled = false;
    this.backgroundSuspended = true;
    this.keeper.pause();
    this.testTone.pause();
    void this.audioContext?.close();
    this.audioContext?.removeEventListener("statechange", this.onContextStateChange);
    this.audioContext = undefined;
    this.outputGain = undefined;
    this.lowLatencyReady = false;
    this.audioSession?.removeEventListener("statechange", this.onAudioSessionStateChange);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.speech.remove();
    this.keeper.remove();
    this.testTone.remove();
  }

  private flushPending(): void {
    if (this.pendingBytes === 0) return;
    const pcm = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const bytes of this.pending) {
      pcm.set(bytes, offset);
      offset += bytes.byteLength;
    }
    const pcmBytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.queue.push({
      pcm,
      sampleRate: this.pendingSampleRate,
      channels: this.pendingChannels,
    });
    this.report("queued", `${pcmBytes} PCM bytes`);
    if (!this.backgroundSuspended) void this.playNext();
  }

  private async playNext(): Promise<void> {
    if (
      !this.enabled
      || this.backgroundSuspended
      || this.playInFlight
      || this.currentPcmBytes > 0
      || !this.speech.paused
    ) return;
    const first = this.queue.shift();
    if (!first) {
      this.ensureKeeper();
      if (this.playing) {
        this.playing = false;
        this.onSpeakingChange(false);
      }
      return;
    }
    const buffered = [first];
    while (
      this.queue[0]?.sampleRate === first.sampleRate
      && this.queue[0]?.channels === first.channels
    ) {
      buffered.push(this.queue.shift()!);
    }
    const pcmBytes = buffered.reduce((total, item) => total + item.pcm.byteLength, 0);
    const pcm = new Uint8Array(pcmBytes);
    let offset = 0;
    for (const item of buffered) {
      pcm.set(item.pcm, offset);
      offset += item.pcm.byteLength;
    }
    const item: QueuedAudio = {
      pcm,
      sampleRate: first.sampleRate,
      channels: first.channels,
    };
    this.keeper.pause();
    this.releaseUrl();
    this.currentPcmBytes = item.pcm.byteLength;
    // Retain raw item.pcm for a rejected play() retry; never amplify a WAV twice.
    const voicePcm = this.musicVoiceBoost.process(item.pcm, item.sampleRate, item.channels);
    if (this.onMouthChange) {
      this.mouthTimeline.clear();
      this.mouthTimeline.append(voicePcm, item.sampleRate, item.channels, 0);
    }
    const wav = pcm16WavBytes(voicePcm, item.sampleRate, item.channels);
    this.objectUrl = URL.createObjectURL(new Blob([wav.slice().buffer], { type: "audio/wav" }));
    this.speech.src = this.objectUrl;
    this.speech.load();
    this.playInFlight = true;
    this.report(
      "play-request",
      `${item.pcm.byteLength} PCM bytes (${buffered.length} buffered segment${buffered.length === 1 ? "" : "s"})`,
    );
    try {
      await this.speech.play();
    } catch (error) {
      this.currentPcmBytes = 0;
      this.resetMouthTracking();
      this.queue.unshift(item);
      const message = error instanceof Error ? error.message : "iPhone audio playback was blocked";
      this.report("play-rejected", message);
      this.onError?.(message);
    } finally {
      this.playInFlight = false;
    }
  }

  private resumeCurrent(): void {
    if (
      !this.enabled
      || this.backgroundSuspended
      || this.playInFlight
      || this.currentPcmBytes === 0
    ) return;
    this.playInFlight = true;
    void this.speech.play()
      .catch((error) => {
        const message = error instanceof Error ? error.message : "iPhone audio resume was blocked";
        this.report("resume-rejected", message);
        this.onError?.(message);
      })
      .finally(() => { this.playInFlight = false; });
  }

  private scheduleEnableTone(context: AudioContext): void {
    if (!this.preferLowLatency) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startsAt = context.currentTime + 0.22;
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0, startsAt);
    gain.gain.linearRampToValueAtTime(0.14, startsAt + 0.012);
    gain.gain.setValueAtTime(0.14, startsAt + 0.11);
    gain.gain.linearRampToValueAtTime(0, startsAt + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + 0.17);
  }

  private enqueueScheduled(bytes: Uint8Array, sampleRate: number, channels: number): void {
    const context = this.audioContext;
    if (!context) return;
    const frames = Math.floor(bytes.byteLength / (channels * 2));
    if (frames === 0) return;

    const audioBuffer = context.createBuffer(channels, frames, sampleRate);
    const voicePcm = this.musicVoiceBoost.process(bytes, sampleRate, channels);
    const view = new DataView(voicePcm.buffer, voicePcm.byteOffset, voicePcm.byteLength);
    let firstAudibleFrame = -1;
    for (let channel = 0; channel < channels; channel += 1) {
      const output = audioBuffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame += 1) {
        output[frame] = view.getInt16((frame * channels + channel) * 2, true) / 32_768;
        if (Math.abs(output[frame]!) >= 24 / 32_768 && (firstAudibleFrame < 0 || frame < firstAudibleFrame)) firstAudibleFrame = frame;
      }
    }

    const now = context.currentTime;
    const plan = this.packetLeadMs ? this.packetClock.schedule(now, frames, sampleRate, this.packetLeadMs) : undefined;
    if (plan) this.scheduledNextTime = plan.startsAt;
    else if (this.scheduledSources.size === 0 || this.scheduledNextTime < now) {
      this.scheduledNextTime = now + scheduledStartLeadSeconds;
    }
    const startsAt = this.scheduledNextTime;
    this.scheduledNextTime += audioBuffer.duration;
    const source = context.createBufferSource();
    const generation = this.scheduledGeneration;
    source.buffer = audioBuffer;
    source.connect(this.ensureOutputGain(context));
    this.scheduledSources.set(source, bytes.byteLength);
    const audible = !this.packetLeadMs || firstAudibleFrame >= 0;
    if (audible) {
      this.audibleSources.add(source);
      if (this.scheduledTailTimer !== undefined) window.clearTimeout(this.scheduledTailTimer);
      this.scheduledTailTimer = undefined;
    }
    this.scheduledPcmBytes += bytes.byteLength;
    source.addEventListener("ended", () => {
      const pcmBytes = this.scheduledSources.get(source);
      if (pcmBytes === undefined) return;
      this.scheduledSources.delete(source);
      this.audibleSources.delete(source);
      this.scheduledPcmBytes = Math.max(0, this.scheduledPcmBytes - pcmBytes);
      if (generation !== this.scheduledGeneration) return;
      this.playedBytes += pcmBytes;
      if (this.audibleSources.size === 0) this.scheduleScheduledEnd();
    }, { once: true });
    source.start(startsAt);
    if (plan) {
      if (plan.first) this.outputOnsets.push({ kind: "pcm", time: startsAt });
      if (!this.audibleOnsetQueued && firstAudibleFrame >= 0) {
        this.audibleOnsetQueued = true;
        this.outputOnsets.push({ kind: "audible", time: startsAt + firstAudibleFrame / sampleRate });
      }
      this.report("pcm-scheduled", "continuous PCM", { phoneReceivedEpochMs: Date.now(),
        phoneReceivedPerformanceMs: performance.now(), contextTime: now, startsAt,
        frames, sampleRate, durationMs: frames / sampleRate * 1000, leadMs: this.packetLeadMs!,
        bufferBeforeMs: plan.bufferBeforeMs, bufferAfterMs: plan.bufferAfterMs, underruns: plan.underruns });
      if (plan.gapMs > 0) this.report("underrun", "PCM timeline exhausted; all samples retained", {
        gapMs: plan.gapMs, recoveryLeadMs: this.packetLeadMs!, underruns: plan.underruns });
      this.startOutputMonitor();
    }
    if (this.onMouthChange) {
      this.mouthTimeline.append(voicePcm, sampleRate, channels, startsAt);
      this.startMouthTracking();
    }
  }

  private async resumeScheduledPlayback(): Promise<void> {
    const context = this.audioContext;
    if (!this.enabled || this.backgroundSuspended || !context || this.scheduledResumeInFlight) return;
    this.scheduledResumeInFlight = true;
    try {
      // Avoid repeated resume/route activation for every 40 ms frame.
      if (context.state !== "running") await context.resume();
      if (!this.enabled || this.backgroundSuspended || this.audioContext !== context || context.state !== "running") return;
      this.ensureKeeper();
      if (this.audibleSources.size > 0 && !this.playing) {
        this.playing = true;
        this.onSpeakingChange(true);
        this.report("playing", `${this.scheduledPcmBytes} scheduled PCM bytes`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Low-latency audio resume was blocked";
      this.report("scheduler-rejected", message);
      this.onError?.(message);
    } finally { this.scheduledResumeInFlight = false; }
  }

  private scheduleScheduledEnd(): void {
    if (this.scheduledTailTimer !== undefined) window.clearTimeout(this.scheduledTailTimer);
    this.scheduledTailTimer = window.setTimeout(() => {
      this.scheduledTailTimer = undefined;
      if (this.audibleSources.size > 0) return;
      if (this.scheduledSources.size === 0) {
        this.resetMouthTracking();
        this.stopOutputMonitor();
      }
      if (!this.packetLeadMs) this.scheduledNextTime = this.audioContext?.currentTime ?? 0;
      if (this.playing) {
        this.playing = false;
        this.onSpeakingChange(false);
        this.report("ended", "scheduled PCM drained");
      }
    }, scheduledTailHoldMs);
  }

  private stopScheduledSources(): void {
    this.scheduledGeneration += 1;
    this.stopOutputMonitor();
    this.audibleOnsetQueued = false;
    this.packetClock.reset();
    this.audibleSources.clear();
    if (this.scheduledTailTimer !== undefined) window.clearTimeout(this.scheduledTailTimer);
    this.scheduledTailTimer = undefined;
    const sources = [...this.scheduledSources.keys()];
    this.scheduledSources.clear();
    this.scheduledPcmBytes = 0;
    this.scheduledNextTime = this.audioContext?.currentTime ?? 0;
    for (const source of sources) {
      try { source.stop(); } catch { /* The source may already have ended. */ }
    }
  }

  private startOutputMonitor(): void {
    if (this.outputMonitor !== undefined) return;
    this.lastBufferReportAt = performance.now();
    // One interval also works in Even Hub's native timer shim. No PCM is delayed here.
    this.outputMonitor = window.setInterval(() => {
      const context = this.audioContext;
      if (!context) return;
      const now = performance.now();
      if (now - this.lastBufferReportAt >= 1000) {
        this.lastBufferReportAt = now;
        this.report("buffer", "continuous PCM remaining", {
          bufferMs: Math.max(0, (this.packetClock.nextTime - context.currentTime) * 1000),
          contextTime: context.currentTime, contextState: context.state, underruns: this.packetClock.underruns,
          phoneEpochMs: Date.now() });
      }
      if (context.state !== "running" || !this.outputOnsets.length) return;
      const stamp = context.getOutputTimestamp?.();
      for (const onset of [...this.outputOnsets]) {
        if (stamp && stamp.performanceTime && stamp.contextTime !== undefined) {
          if (stamp.contextTime < onset.time) continue;
          const outputPerformanceMs = stamp.performanceTime + (onset.time - stamp.contextTime) * 1000;
          this.report("output-start", "device output clock estimate (not acoustic measurement)", {
            kind: onset.kind, clock: "getOutputTimestamp", scheduledContextTime: onset.time,
            outputPerformanceMs, outputEpochMs: performance.timeOrigin + outputPerformanceMs });
        } else {
          if (context.currentTime < onset.time) continue;
          this.report("output-start-unavailable", "device output timestamp unavailable", {
            kind: onset.kind, clock: "context-only", scheduledContextTime: onset.time, phoneEpochMs: Date.now() });
        }
        this.outputOnsets = this.outputOnsets.filter(value => value !== onset);
      }
    }, 50);
  }

  private stopOutputMonitor(): void {
    if (this.outputMonitor !== undefined) window.clearInterval(this.outputMonitor);
    this.outputMonitor = undefined;
    this.outputOnsets = [];
  }

  private selectPlaybackSession(): void {
    // This is the WINDOW's session, not a session private to Voice PCM.
    // Forcing ambient also downgrades MusicKit (silent-switch/lock behaviour).
    // Let WebKit arbitrate MusicKit + our already-running Web Audio together;
    // never switch to an explicit exclusive session at each Voice frame/PTT.
    const type = this.externalMediaPlaying ? "auto" : "playback";
    if (this.audioSession && this.audioSession.type !== type) {
      this.audioSession.type = type;
    }
  }

  private ensureOutputGain(context: AudioContext): GainNode {
    if (!this.outputGain) {
      this.outputGain = context.createGain();
      this.outputGain.gain.value = this.outputLevel;
      this.outputGain.connect(context.destination);
    }
    return this.outputGain;
  }

  private setOutputLevel(level: number, fadeMs: number): void {
    const next = clampLevel(level);
    const changed = Math.abs(next - this.outputLevel) > 0.0001;
    this.outputLevel = next;
    this.speech.volume = next;
    const context = this.audioContext;
    const gain = this.outputGain;
    if (context && gain) {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      if (fadeMs > 0 && context.state !== "closed") {
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(next, now + fadeMs / 1_000);
      } else {
        gain.gain.setValueAtTime(next, now);
      }
    }
    if (changed) this.report(next < 1 ? "ducked" : "unducked", `${Math.round(next * 100)}%`);
  }

  private resumeAvailablePlayback(): void {
    if (!this.enabled || this.backgroundSuspended) return;
    if (this.playbackMode === "low-latency") {
      void this.resumeScheduledPlayback();
    } else if (this.currentPcmBytes > 0 && this.speech.paused) {
      this.resumeCurrent();
    } else if (this.currentPcmBytes === 0) {
      void this.playNext();
    }
  }

  private ensureKeeper(): void {
    if (!this.enabled || this.backgroundSuspended || this.externalMediaPlaying || !this.keeper.paused) return;
    void this.keeper.play().catch((error) => {
      const message = error instanceof Error ? error.message : "iPhone audio session resume was blocked";
      this.report("keeper-rejected", message);
      this.onError?.(message);
    });
  }

  private prepareElement(audio: HTMLAudioElement): void {
    audio.preload = "auto";
    audio.setAttribute("playsinline", "");
    audio.hidden = true;
    document.body.append(audio);
  }

  private readonly onAudioSessionStateChange = () => {
    this.report("session-statechange", this.audioSession?.state ?? "unknown");
    if (!this.backgroundSuspended && this.audioSession?.state === "active") {
      if (this.duplexRecording) this.resumeAvailablePlayback();
      else this.restoreBackgroundPlayback();
    }
  };

  private readonly onContextStateChange = () => {
    const state = this.audioContext?.state;
    if (this.duplexRecording && (state === "running" || state === "suspended")) {
      this.resumeDuringRecording();
    }
  };

  private readonly onVisibilityChange = () => {
    this.report("visibility", document.visibilityState);
    if (document.visibilityState === "visible" && !this.backgroundSuspended) {
      if (this.duplexRecording) this.resumeAvailablePlayback();
      else this.restoreBackgroundPlayback();
    }
  };

  private report(event: string, detail: string, timing?: PcmPlayerDiagnostic["timing"]): void {
    this.onDiagnostic?.({
      event,
      detail,
      receivedBytes: this.receivedBytes,
      playedBytes: this.playedBytes,
      queueLength: this.playbackMode === "low-latency"
        ? this.scheduledSources.size
        : this.queue.length + (this.pendingBytes > 0 ? 1 : 0),
      sessionType: this.audioSession?.type ?? "unsupported",
      sessionState: this.audioSession?.state ?? "unsupported",
      ...(this.streamId ? { streamId: this.streamId } : {}),
      ...(timing ? { timing } : {}),
    });
  }

  private releaseUrl(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = "";
  }

  private startMouthTracking(): void {
    if (!this.onMouthChange || this.mouthTimer !== undefined) return;
    const tick = () => {
      const scheduled = this.playbackMode === "low-latency";
      const audible = this.enabled && !this.backgroundSuspended && (scheduled
        ? this.audioContext?.state === "running"
        : !this.warmingSpeech && !this.speech.paused && !this.speech.ended && this.speech.readyState >= 3);
      const time = scheduled ? this.audioContext?.currentTime ?? 0 : this.speech.currentTime;
      const candidate = audible ? this.mouthTimeline.levelAt(time) : 0;
      // Count visual sampling frames even when an unchanged image needs no
      // callback/transfer. Two equal open frames get a one-step dip on the next
      // repeat (3,3,2,3,3,2). New audio levels and silence take effect immediately.
      const next = candidate > 0 && candidate === this.mouthLevel && this.mouthHeldFrames >= 2
        ? candidate - 1 : candidate;
      this.mouthHeldFrames = next > 0 ? (next === this.mouthLevel ? this.mouthHeldFrames + 1 : 1) : 0;
      this.publishMouth(next);
    };
    // Even Hub's shadow tick iterates a live Map of timers. Re-arming a
    // setTimeout here adds another due entry during the same native tick and
    // never yields. Keep one interval for the whole reply.
    this.mouthTimer = window.setInterval(tick, this.mouthFrameMs);
    tick();
  }

  private publishMouth(level: number): void {
    if (level === this.mouthLevel) return;
    this.mouthLevel = level;
    this.onMouthChange?.(level);
  }

  private resetMouthTracking(): void {
    if (this.mouthTimer !== undefined) window.clearInterval(this.mouthTimer);
    this.mouthTimer = undefined;
    this.mouthTimeline.clear();
    this.mouthHeldFrames = 0;
    this.publishMouth(0);
  }
}

function clampLevel(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function pcm16WavBytes(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, 44);
  return bytes;
}

function silentWavBytes(durationMs: number): Uint8Array {
  const sampleRate = 8_000;
  const samples = Math.max(1, Math.round(sampleRate * durationMs / 1_000));
  return pcm16WavBytes(new Uint8Array(samples * 2), sampleRate, 1);
}

function testToneWavBytes(): Uint8Array {
  const sampleRate = 16_000;
  const samples = Math.round(sampleRate * 0.16);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let sample = 0; sample < samples; sample += 1) {
    const time = sample / sampleRate;
    const envelope = Math.min(1, time / 0.012) * Math.min(1, (0.16 - time) / 0.035);
    view.setInt16(sample * 2, Math.round(Math.sin(2 * Math.PI * 660 * time) * envelope * 5_000), true);
  }
  return pcm16WavBytes(pcm, sampleRate, 1);
}

function wavDataUri(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}
