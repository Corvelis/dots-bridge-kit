import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PcmStreamPlayer } from "../shared/audio/pcm-player";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import ts from "typescript";
import { OwnedMicrophone, restorePhonePlayback } from "../dots-phone-g2/src/microphone";

// Exercise the installed SDK's timer virtualization, not a hand-written model.
const sdkScript = new Script(ts.transpileModule(
  readFileSync(new URL("../node_modules/@evenrealities/even_hub_sdk/dist/index.js", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText);

function evenHubTimerRuntime() {
  const runtime = createContext({
    exports: {},
    console: { log() {}, debug() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, dispatchEvent() {},
    document: { readyState: "loading", addEventListener() {} },
    AudioContext: FakeContext,
  });
  runtime.window = runtime;
  sdkScript.runInContext(runtime, { timeout: 1_000 });
  return runtime;
}

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  paused = true;
  ended = false;
  error: MediaError | null = null;
  loop = false;
  preload = "";
  hidden = false;
  src = "";
  volume = 1;
  pauseCalls = 0;
  playCalls = 0;
  currentTime = 0;
  readyState = 4;

  constructor() { super(); FakeAudio.instances.push(this); }
  async play(): Promise<void> { this.playCalls += 1; this.paused = false; }
  pause(): void { this.pauseCalls += 1; this.paused = true; }
  load(): void { this.currentTime = 0; this.ended = false; }
  remove(): void {}
  setAttribute(): void {}
}

class FakeContext extends EventTarget {
  static instances: FakeContext[] = [];
  state = "suspended";
  currentTime = 0;
  destination = {};
  sources: Array<EventTarget & { buffer: any; connect: () => void; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  resumeWait?: Promise<void>;
  resume = vi.fn(async () => {
    await this.resumeWait;
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
  });
  suspend = vi.fn(async () => { this.state = "suspended"; });
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { super(); FakeContext.instances.push(this); }
  createGain() {
    return { connect() {}, gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } };
  }
  createBuffer(channels: number, frames: number, rate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return { duration: frames / rate, getChannelData: (channel: number) => data[channel]! };
  }
  createBufferSource() {
    const source = Object.assign(new EventTarget(), { buffer: null as any, connect() {}, start: vi.fn(), stop: vi.fn() });
    this.sources.push(source); return source;
  }
}

describe("call audio duplex phone playback", () => {
  let audioSession: EventTarget & { type: string; state: string };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.instances = [];
    FakeContext.instances = [];
    audioSession = Object.assign(new EventTarget(), { type: "playback", state: "active" });
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("navigator", { audioSession });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      body: { append: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(([80, 250] as const).flatMap(lead => [17856, 23184].map(firstFrames => ({ lead, firstFrames }))))(
    "starts a $firstFrames-frame first packet with $lead ms lead and keeps every sample across variable packets and silence", async ({ lead, firstFrames }) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const diagnostics: any[] = [];
    const player = new PcmStreamPlayer(() => {}, event => diagnostics.push(event));
    try {
      await player.enable({ confirmationTone: false });
      player.setStreamProfile("new", lead);
      const context = FakeContext.instances[0]!;
      const lengths = [firstFrames, firstFrames > 20000 ? 24001 : 19201, 19199, 1083];
      let expectedTime = lead / 1000;
      for (let i = 0; i < lengths.length; i++) {
        const frames = lengths[i]!;
        const pcm = Buffer.alloc(frames * 2);
        if (i !== 1) for (let frame = 0; frame < frames; frame++) pcm.writeInt16LE((frame % 2000) - 1000, frame * 2);
        player.enqueue({ data: pcm.toString("base64"), streamId: "new", sampleRate: 48000, numChannels: 1,
          samplesPerChannel: 19200 }); // Metadata intentionally differs; actual bytes define the duration.
        const node = context.sources[i]!;
        expect(node.start).toHaveBeenCalledExactlyOnceWith(expectedTime);
        const samples = node.buffer.getChannelData(0);
        expect(samples.length).toBe(frames);
        for (let frame = 0; frame < frames; frame++) expect(samples[frame]).toBe(pcm.readInt16LE(frame * 2) / 32768);
        expectedTime += frames / 48000;
        context.currentTime += .1;
        if (i === 0) player.prepareForRecording({ keepPlayback: true });
      }
      expect(diagnostics.filter(event => event.event === "underrun")).toHaveLength(0);
      expect(context.sources.every(source => source.stop.mock.calls.length === 0)).toBe(true);
    } finally { player.dispose(); }
  });

  it("records real buffer exhaustion, output-clock onset and rejects old packets after switching", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const diagnostics: any[] = [];
    const player = new PcmStreamPlayer(() => {}, event => diagnostics.push(event));
    try {
      await player.enable({ confirmationTone: false }); player.setStreamProfile("tsukuyomi", 80);
      const context = FakeContext.instances[0]!;
      Object.assign(context, { getOutputTimestamp: () => ({ contextTime: context.currentTime - .04, performanceTime: 1000 }) });
      const chunk = { data: Buffer.alloc(35712, 7).toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 17856, streamId: "tsukuyomi" };
      player.enqueue(chunk);
      expect(diagnostics.filter(e => e.event === "output-start")).toHaveLength(0);
      context.currentTime = .09; await vi.advanceTimersByTimeAsync(50);
      expect(diagnostics.filter(e => e.event === "output-start")).toHaveLength(0);
      context.currentTime = .14; await vi.advanceTimersByTimeAsync(50);
      expect(diagnostics.filter(e => e.event === "output-start")).toHaveLength(2);
      expect(diagnostics.find(e => e.event === "output-start").timing.outputPerformanceMs).toBeCloseTo(980);
      context.currentTime = .5; player.enqueue(chunk);
      expect(diagnostics.find(e => e.event === "underrun").timing.gapMs).toBeCloseTo(48);
      expect(context.sources[1]!.start).toHaveBeenCalledExactlyOnceWith(.58);
      player.setStreamProfile("stream-b", 250);
      expect(context.sources.every(source => source.stop.mock.calls.length === 1)).toBe(true);
      player.enqueue(chunk); expect(context.sources).toHaveLength(2);
      player.enqueue({ ...chunk, streamId: "stream-b" });
      expect(context.sources[2]!.start).toHaveBeenCalledExactlyOnceWith(.75);
      player.clearBufferedAudio("cancel");
      const count = diagnostics.length; context.currentTime = 5; await vi.advanceTimersByTimeAsync(2000);
      expect(diagnostics).toHaveLength(count);
    } finally { player.dispose(); }
  });

  it("stops idle output monitoring after a reply drains and resumes for the next reply", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const diagnostics: Array<{ event: string }> = [];
    const player = new PcmStreamPlayer(() => {}, event => diagnostics.push(event));
    try {
      await player.enable({ confirmationTone: false });
      player.setStreamProfile("long-music-session", 250);
      const chunk = { data: Buffer.alloc(9600, 7).toString("base64"), sampleRate: 48_000,
        numChannels: 1, samplesPerChannel: 4800, streamId: "long-music-session" };
      player.enqueue(chunk);
      const context = FakeContext.instances[0]!;
      context.currentTime = 0.5;
      context.sources[0]!.dispatchEvent(new Event("ended"));
      await vi.advanceTimersByTimeAsync(200);
      const idleReports = diagnostics.filter(event => event.event === "buffer").length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(diagnostics.filter(event => event.event === "buffer")).toHaveLength(idleReports);
      player.enqueue(chunk);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(diagnostics.filter(event => event.event === "buffer").length).toBeGreaterThan(idleReports);
    } finally { player.dispose(); }
  });

  it("keeps silent PCM on the timeline without keeping the speaking indicator on", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const speaking = vi.fn(); const player = new PcmStreamPlayer(speaking);
    try {
      await player.enable({ confirmationTone: false }); player.setStreamProfile("silent", 80);
      player.prepareForRecording({ keepPlayback: true });
      const chunk = { data: Buffer.alloc(38400, 5).toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 19200, streamId: "silent" };
      player.enqueue(chunk); expect(speaking).toHaveBeenCalledWith(true);
      player.enqueue({ ...chunk, data: Buffer.alloc(38400).toString("base64") });
      const context = FakeContext.instances[0]!;
      context.currentTime = .48; context.sources[0]!.dispatchEvent(new Event("ended"));
      await vi.advanceTimersByTimeAsync(160);
      expect(speaking).toHaveBeenLastCalledWith(false);
      player.enqueue(chunk);
      expect(context.sources[2]!.start.mock.calls[0]![0]).toBeCloseTo(.88);
    } finally { player.dispose(); }
  });

  it.each([true, false])("boosts only Voice PCM during music in the actual player (low latency: %s)", async lowLatency => {
    if (lowLatency) vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const blobs: Blob[] = [];
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => { blobs.push(blob as Blob); return "blob:voice-test"; });
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, lowLatency);
    try {
      await player.enable({ confirmationTone: false });
      const speech = FakeAudio.instances[0]!;
      speech.paused = true; speech.dispatchEvent(new Event("ended"));
      player.setExternalMediaPlaying(true);
      const pauseCalls = speech.pauseCalls;
      const bytes = Buffer.alloc(4800 * 2);
      for (let index = 0; index < 4800; index++) bytes.writeInt16LE(4000, index * 2);
      player.enqueue({ data: bytes.toString("base64"), sampleRate: 48_000, numChannels: 1, samplesPerChannel: 4800 });
      player.restoreBackgroundPlayback();
      await vi.advanceTimersByTimeAsync(400);
      if (lowLatency) {
        expect(FakeContext.instances[0]!.sources[0]!.buffer.getChannelData(0)[4799]).toBe(8000 / 32768);
      } else {
        const wav = new DataView(await blobs[0]!.arrayBuffer());
        expect(wav.getInt16(44 + 4799 * 2, true)).toBe(8000);
        expect(speech.volume).toBe(1); // HTML element volume cannot exceed one.
      }
      player.prepareForRecording({ keepPlayback: true });
      player.setMusicVoiceBoost("normal");
      player.setMusicVoiceBoost("strong");
      expect(speech.pauseCalls).toBe(pauseCalls);
      expect(audioSession.type).toBe("auto");
      expect(FakeAudio.instances[2]!.playCalls).toBe(0); // Boost never affects the test tone.
    } finally { player.dispose(); createUrl.mockRestore(); revokeUrl.mockRestore(); }
  });

  it("leaves ordinary audio unchanged and restores it when music ends", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const player = new PcmStreamPlayer(() => {});
    try {
      await player.enable({ confirmationTone: false });
      const context = FakeContext.instances[0]!;
      const bytes = Buffer.alloc(9600); for (let i = 0; i < 4800; i++) bytes.writeInt16LE(4000, i * 2);
      const chunk = { data: bytes.toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 4800 };
      player.enqueue(chunk);
      expect(context.sources.at(-1)!.buffer.getChannelData(0)[4799]).toBe(4000 / 32768);
      player.setExternalMediaPlaying(true);
      player.enqueue(chunk);
      expect(context.sources.at(-1)!.buffer.getChannelData(0)[4799]).toBe(8000 / 32768);
      player.restoreBackgroundPlayback(); player.prepareForRecording({ keepPlayback: true });
      player.enqueue(chunk);
      expect(context.sources.at(-1)!.buffer.getChannelData(0)[4799]).toBe(8000 / 32768);
      player.setExternalMediaPlaying(false);
      player.enqueue(chunk);
      expect(context.sources.at(-1)!.buffer.getChannelData(0)[4799]).toBe(4000 / 32768);
      player.setMusicVoiceBoost("normal"); player.setExternalMediaPlaying(true);
      player.enqueue(chunk);
      expect(context.sources.at(-1)!.buffer.getChannelData(0)[4799]).toBe(4000 / 32768);
    } finally { player.dispose(); }
  });

  it("never applies the compatibility boost twice after play() is rejected", async () => {
    const blobs: Blob[] = [];
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => { blobs.push(blob as Blob); return "blob:voice-retry"; });
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, false);
    try {
      await player.enable({ confirmationTone: false });
      const speech = FakeAudio.instances[0]!; speech.paused = true; speech.dispatchEvent(new Event("ended"));
      const play = vi.spyOn(speech, "play").mockRejectedValueOnce(new Error("simulated block"));
      player.setExternalMediaPlaying(true);
      const bytes = Buffer.alloc(9600); for (let i = 0; i < 4800; i++) bytes.writeInt16LE(4000, i * 2);
      player.enqueue({ data: bytes.toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 4800 });
      await vi.advanceTimersByTimeAsync(400);
      player.restoreBackgroundPlayback();
      await vi.advanceTimersByTimeAsync(200);
      expect(play).toHaveBeenCalledTimes(2);
      expect(blobs).toHaveLength(2);
      for (const blob of blobs) expect(new DataView(await blob.arrayBuffer()).getInt16(44 + 4799 * 2, true)).toBe(8000);
      play.mockRestore();
    } finally { player.dispose(); createUrl.mockRestore(); revokeUrl.mockRestore(); }
  });

  it.each([[true, 125], [false, 125], [true, 300], [false, 300]] as const)("does not loop inside an Even Hub shadow tick (low latency: %s, mouth ms: %s)", async (lowLatency, mouthMs) => {
    const runtime = evenHubTimerRuntime();
    vi.stubGlobal("window", runtime);
    const mouth = vi.fn();
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, lowLatency, mouth);
    player.setMouthFrameInterval(mouthMs);
    const hostTick = new Script("window.__tickShadowTimers(1000)");
    try {
      await player.enable({ confirmationTone: false });
      const speech = FakeAudio.instances[0]!;
      speech.paused = true;
      speech.dispatchEvent(new Event("ended"));
      player.enqueue({ data: Buffer.alloc(64_000, 20).toString("base64"), sampleRate: 16_000, numChannels: 1, samplesPerChannel: 32_000 });
      if (!lowLatency) {
        new Script("window.__tickShadowTimers(360)").runInContext(runtime, { timeout: 100 });
        await Promise.resolve();
        speech.dispatchEvent(new Event("playing"));
      }
      const context = FakeContext.instances[0]!;
      context.currentTime = .1;
      speech.currentTime = .1;
      mouth.mockClear();
      // A recursive setTimeout visits newly-added timers in the SDK's live Map
      // forever. The VM deadline keeps that regression from hanging Vitest.
      expect(() => hostTick.runInContext(runtime, { timeout: 100 })).not.toThrow();
      // HTML playback already published frame one on its playing event;
      // the first native timer tick therefore holds that image unchanged.
      expect(mouth).toHaveBeenCalledTimes(lowLatency ? 1 : 0);
      for (let tick = 0; tick < 10; tick += 1) {
        context.currentTime += .05;
        speech.currentTime += .05;
        hostTick.runInContext(runtime, { timeout: 100 });
      }
      // Unchanged second frames are held without another image callback.
      expect(mouth.mock.calls.map(([level]) => level)).toEqual(lowLatency
        ? [3, 2, 3, 2, 3, 2, 3] : [2, 3, 2, 3, 2, 3, 2]);
      player.clearBufferedAudio();
      expect(mouth).toHaveBeenLastCalledWith(0);
      const calls = mouth.mock.calls.length;
      hostTick.runInContext(runtime, { timeout: 100 });
      expect(mouth).toHaveBeenCalledTimes(calls);
    } finally { player.dispose(); }
  });

  it.each(([125, 300] as const).flatMap(mouthMs => [1, 2, 3].map(level => ({ mouthMs, level }))))(
    "holds level $level for two frames, then dips one step at $mouthMs ms in scheduled playback", async ({ mouthMs, level }) => {
      vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
      const mouth = vi.fn();
      const player = new PcmStreamPlayer(() => {}, undefined, undefined, true, mouth);
      player.setMouthFrameInterval(mouthMs);
      try {
        await player.enable({ confirmationTone: false });
        const context = FakeContext.instances[0]!;
        const pcm = Buffer.alloc(16_000 * 4 * 2);
        const amplitude = [0, 650, 1600, 5000][level]!;
        for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(amplitude, offset);
        player.enqueue({ data: pcm.toString("base64"), sampleRate: 16_000, numChannels: 1, samplesPerChannel: pcm.length / 2 });
        const displayed: number[] = [];
        const callbacks: number[] = [];
        for (let frame = 0; frame < 6; frame++) {
          context.currentTime = .1 + frame * mouthMs / 1000;
          await vi.advanceTimersByTimeAsync(mouthMs);
          displayed.push(mouth.mock.lastCall![0]);
          callbacks.push(mouth.mock.calls.length);
        }
        expect(displayed).toEqual([level, level, level - 1, level, level, level - 1]);
        expect(callbacks).toEqual([1, 1, 2, 3, 3, 4]);
      } finally { player.dispose(); }
    });

  it("honors changing audio and silence immediately, starting a fresh hold after silence or reset", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const mouth = vi.fn();
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, true, mouth);
    player.setMouthFrameInterval(125);
    try {
      await player.enable({ confirmationTone: false });
      const context = FakeContext.instances[0]!;
      // Long constant sections let the test clock sample each intended level
      // without tying this assertion to PCM analysis-window boundaries.
      const levels = [3, 3, 1, 1, 3, 3, 0, 0, 3, 3, 3];
      const pcm = Buffer.alloc(levels.length * 8000 * 2);
      for (let frame = 0; frame < levels.length; frame++) {
        const amplitude = [0, 650, 1600, 5000][levels[frame]!]!;
        for (let sample = frame * 8000; sample < (frame + 1) * 8000; sample++) pcm.writeInt16LE(amplitude, sample * 2);
      }
      const chunk = { data: pcm.toString("base64"), sampleRate: 16_000, numChannels: 1, samplesPerChannel: pcm.length / 2 };
      player.enqueue(chunk);
      const displayed: number[] = [];
      for (let frame = 0; frame < levels.length; frame++) {
        context.currentTime = .2 + frame * .5;
        await vi.advanceTimersByTimeAsync(125);
        displayed.push(mouth.mock.lastCall![0]);
      }
      expect(displayed).toEqual([3, 3, 1, 1, 3, 3, 0, 0, 3, 3, 2]);
      player.clearBufferedAudio();
      expect(mouth).toHaveBeenLastCalledWith(0);
      player.enqueue(chunk);
      const startsAt = context.sources.at(-1)!.start.mock.calls[0]![0];
      mouth.mockClear();
      for (const offset of [.1, .2, .3]) {
        context.currentTime = startsAt + offset;
        await vi.advanceTimersByTimeAsync(125);
      }
      expect(mouth.mock.calls.map(([level]) => level)).toEqual([3, 2]);
    } finally { player.dispose(); }
  });

  it("uses the same two-frame hold and one-step dip in HTML compatibility playback", async () => {
    const mouth = vi.fn();
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, false, mouth);
    player.setMouthFrameInterval(125);
    try {
      await player.enable({ confirmationTone: false });
      const speech = FakeAudio.instances[0]!;
      speech.paused = true;
      speech.dispatchEvent(new Event("ended"));
      player.enqueue({ data: Buffer.alloc(64_000, 20).toString("base64"), sampleRate: 16_000, numChannels: 1, samplesPerChannel: 32_000 });
      await vi.advanceTimersByTimeAsync(360);
      speech.dispatchEvent(new Event("playing"));
      const displayed = [mouth.mock.lastCall![0]];
      for (let frame = 1; frame < 6; frame++) {
        speech.currentTime = frame * .125;
        await vi.advanceTimersByTimeAsync(125);
        displayed.push(mouth.mock.lastCall![0]);
      }
      expect(displayed).toEqual([3, 3, 2, 3, 3, 2]);
      speech.dispatchEvent(new Event("ended"));
      expect(mouth).toHaveBeenLastCalledWith(0);
    } finally { player.dispose(); }
  });

  it.each([125, 300] as const)("tracks the scheduled playback clock and silence, not early PCM arrival (%sms)", async mouthMs => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const mouth = vi.fn();
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, true, mouth);
    player.setMouthFrameInterval(mouthMs);
    await player.enable({ confirmationTone: false });
    const context = FakeContext.instances[0]!;
    const pcm = Buffer.alloc(16_000 * 2);
    for (let offset = 0; offset < 16_000; offset += 2) pcm.writeInt16LE(5_000, offset);
    player.enqueue({ data: pcm.toString("base64"), sampleRate: 16_000, numChannels: 1, samplesPerChannel: 16_000 });
    expect(mouth).not.toHaveBeenCalled();
    context.currentTime = .1;
    await vi.advanceTimersByTimeAsync(mouthMs);
    expect(mouth).toHaveBeenLastCalledWith(3);
    context.state = "suspended";
    await vi.advanceTimersByTimeAsync(mouthMs);
    expect(mouth).toHaveBeenLastCalledWith(0);
    context.state = "running";
    context.currentTime = .2;
    await vi.advanceTimersByTimeAsync(mouthMs);
    expect(mouth).toHaveBeenLastCalledWith(3);
    context.currentTime = .8;
    await vi.advanceTimersByTimeAsync(mouthMs);
    expect(mouth).toHaveBeenLastCalledWith(0);
    player.dispose();
  });

  it("switches back to the legacy cadence without changing scheduled audio or losing its mouth timeline", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const mouth = vi.fn();
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, true, mouth);
    try {
      player.setMouthFrameInterval(125);
      await player.enable({ confirmationTone: false });
      const context = FakeContext.instances[0]!;
      player.enqueue({ data: Buffer.alloc(64_000, 20).toString("base64"), sampleRate: 16_000, numChannels: 1, samplesPerChannel: 32_000 });
      context.currentTime = .1;
      mouth.mockClear();
      await vi.advanceTimersByTimeAsync(124);
      expect(mouth).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mouth).toHaveBeenCalledOnce();
      const sources = [...context.sources];
      player.setMouthFrameInterval(300);
      mouth.mockClear();
      await vi.advanceTimersByTimeAsync(299);
      expect(mouth).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mouth).toHaveBeenCalledOnce();
      expect(mouth.mock.calls[0]![0]).toBeGreaterThan(0);
      expect(context.sources).toEqual(sources);
      expect(sources.every(source => source.stop.mock.calls.length === 0)).toBe(true);
    } finally { player.dispose(); }
  });

  it("closes immediately on route reset, disable and stop without replaying stale mouth frames", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const mouth = vi.fn();
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, true, mouth);
    await player.enable({ confirmationTone: false });
    const context = FakeContext.instances[0]!;
    const chunk = { data: Buffer.alloc(32_000, 20).toString("base64"), sampleRate: 16_000, numChannels: 1, samplesPerChannel: 16_000 };
    for (const action of [() => player.clearBufferedAudio(), () => player.stop(), () => player.disable()]) {
      context.state = "running";
      player.enqueue(chunk);
      context.currentTime += .1;
      await vi.advanceTimersByTimeAsync(300);
      expect(mouth).toHaveBeenLastCalledWith(3);
      action();
      expect(mouth).toHaveBeenLastCalledWith(0);
      const calls = mouth.mock.calls.length;
      context.currentTime += 3;
      await vi.advanceTimersByTimeAsync(900);
      expect(mouth).toHaveBeenCalledTimes(calls);
    }
    player.dispose();
  });

  it("uses HTML media time in compatibility mode, closing during stalls and at the end", async () => {
    const mouth = vi.fn();
    const player = new PcmStreamPlayer(() => {}, undefined, undefined, false, mouth);
    await player.enable({ confirmationTone: false });
    const speech = FakeAudio.instances[0]!;
    speech.paused = true;
    speech.dispatchEvent(new Event("ended"));
    player.enqueue({ data: Buffer.alloc(32_000, 20).toString("base64"), sampleRate: 16_000, numChannels: 1, samplesPerChannel: 16_000 });
    await vi.advanceTimersByTimeAsync(360);
    expect(mouth).not.toHaveBeenCalled();
    speech.dispatchEvent(new Event("playing"));
    expect(mouth).toHaveBeenLastCalledWith(3);
    speech.readyState = 2;
    await vi.advanceTimersByTimeAsync(300);
    expect(mouth).toHaveBeenLastCalledWith(0);
    speech.readyState = 4;
    speech.currentTime = .5;
    await vi.advanceTimersByTimeAsync(300);
    expect(mouth).toHaveBeenLastCalledWith(3);
    speech.paused = true;
    speech.ended = true;
    speech.dispatchEvent(new Event("ended"));
    expect(mouth).toHaveBeenLastCalledWith(0);
    player.dispose();
  });

  it("keeps an active iPhone reply at full volume without pausing it while G2 PTT opens", () => {
    const diagnostics: Array<{ event: string; detail: string }> = [];
    const player = new PcmStreamPlayer(
      () => undefined,
      ({ event, detail }) => diagnostics.push({ event, detail }),
    );
    const speech = FakeAudio.instances[0]!;
    speech.paused = false;

    player.prepareForRecording({ keepPlayback: true });

    expect(speech.pauseCalls).toBe(0);
    expect(speech.volume).toBe(1);
    expect(audioSession.type).toBe("playback");
    expect(diagnostics).toContainEqual({
      event: "duplex-recording",
      detail: "G2 microphone active; iPhone output remains at 100%",
    });
    player.dispose();
  });

  it("restores full iPhone volume when R1 PTT closes", () => {
    const player = new PcmStreamPlayer(() => undefined);
    (player as unknown as { enabled: boolean }).enabled = true;
    const speech = FakeAudio.instances[0]!;

    player.prepareForRecording({ keepPlayback: true });
    player.restoreBackgroundPlayback();

    expect(speech.volume).toBe(1);
    expect(audioSession.type).toBe("playback");
    player.dispose();
  });

  it("can silently auto-enable without playing the confirmation tone", async () => {
    const player = new PcmStreamPlayer(() => undefined);

    await player.enable({ confirmationTone: false });

    expect(FakeAudio.instances[0]?.playCalls).toBe(1);
    expect(FakeAudio.instances[1]?.playCalls).toBe(1);
    expect(FakeAudio.instances[2]?.playCalls).toBe(0);
    expect(player.ready).toBe(true);
    player.dispose();
  });

  it("fully disables persistent phone playback until it is enabled again", async () => {
    const player = new PcmStreamPlayer(() => undefined);

    await player.enable({ confirmationTone: false });
    player.disable();

    expect(player.ready).toBe(false);
    expect(FakeAudio.instances[0]?.pauseCalls).toBeGreaterThan(0);
    expect(FakeAudio.instances[1]?.pauseCalls).toBeGreaterThan(0);
    expect(FakeAudio.instances[2]?.pauseCalls).toBeGreaterThan(0);

    await player.enable({ confirmationTone: false });
    expect(player.ready).toBe(true);
    player.dispose();
  });

  it("hands the persistent phone media carrier to external media while music plays", async () => {
    const diagnostics: Array<{ event: string; detail: string }> = [];
    const player = new PcmStreamPlayer(
      () => undefined,
      ({ event, detail }) => diagnostics.push({ event, detail }),
    );
    await player.enable({ confirmationTone: false });
    FakeAudio.instances[0]!.paused = true;
    const keeper = FakeAudio.instances[1]!;
    const playCallsBeforeMusic = keeper.playCalls;

    player.setExternalMediaPlaying(true);
    player.restoreBackgroundPlayback();
    vi.advanceTimersByTime(500);

    expect(keeper.paused).toBe(true);
    expect(keeper.playCalls).toBe(playCallsBeforeMusic);
    expect(diagnostics).toContainEqual({
      event: "external-media-started",
      detail: "Call audio mixes with external media; silent carrier paused",
    });

    player.setExternalMediaPlaying(false);
    vi.advanceTimersByTime(500);
    expect(keeper.playCalls).toBeGreaterThan(playCallsBeforeMusic);
    player.dispose();
  });

  it("plays Voice PCM while external media is active without reclaiming an exclusive audio session", async () => {
    const player = new PcmStreamPlayer(() => undefined, undefined, undefined, false);
    await player.enable({ confirmationTone: false });
    const speech = FakeAudio.instances[0]!;
    speech.paused = true;
    const baseline = speech.playCalls;
    player.setExternalMediaPlaying(true);
    expect(audioSession.type).toBe("auto");
    player.enqueue({ data: Buffer.alloc(128).toString("base64"), sampleRate: 16000, numChannels: 1, samplesPerChannel: 64 });
    player.restoreBackgroundPlayback();
    await vi.advanceTimersByTimeAsync(550);
    expect(speech.playCalls).toBeGreaterThan(baseline);
    expect(audioSession.type).toBe("auto");
    expect(FakeAudio.instances[1]!.paused).toBe(true);
    player.prepareForRecording({ keepPlayback: true });
    expect(audioSession.type).toBe("auto");
    expect(speech.pauseCalls).toBe(0);
    player.dispose();
  });

  it("does not suspend Web Audio when music starts and can resume it during music", async () => {
    const player = new PcmStreamPlayer(() => undefined);
    await player.enable({ confirmationTone: false });
    const context = { state: "running", currentTime: 0, resume: vi.fn(async () => {}), suspend: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    Object.assign(player, { audioContext: context, lowLatencyReady: true });
    player.setExternalMediaPlaying(true);
    player.restoreBackgroundPlayback();
    await vi.advanceTimersByTimeAsync(200);
    expect(context.suspend).not.toHaveBeenCalled();
    expect(context.resume).not.toHaveBeenCalled();
    expect(audioSession.type).toBe("auto");
    context.state = "suspended";
    player.restoreBackgroundPlayback();
    await vi.advanceTimersByTimeAsync(200);
    expect(context.resume).toHaveBeenCalledOnce();
    // Avoid unrelated output-gain disposal in this focused scheduler test.
    Object.assign(player, { audioContext: undefined });
    player.dispose();
  });

  it("plays a new backchannel during G2 recording even if native mic setup suspended Web Audio", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const speaking = vi.fn(); const player = new PcmStreamPlayer(speaking);
    await player.enable({ confirmationTone: false });
    const context = FakeContext.instances[0]!;
    player.prepareForRecording({ keepPlayback: true });
    // No phone playback was active when the microphone opened. Suspension
    // happens afterwards, like a native SDK route transition without a state event.
    context.state = "suspended";
    const baseline = context.resume.mock.calls.length;
    player.enqueue({ data: Buffer.alloc(3840, 7).toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 1920 });
    await vi.advanceTimersByTimeAsync(0);
    expect(context.resume).toHaveBeenCalledTimes(baseline + 1);
    expect(context.state).toBe("running");
    expect(context.sources[0]?.start).toHaveBeenCalledExactlyOnceWith(.025);
    expect(context.sources[0]?.stop).not.toHaveBeenCalled();
    expect(speaking).toHaveBeenCalledWith(true);
    expect(audioSession.type).toBe("playback");
    expect(FakeAudio.instances[0]?.volume).toBe(1);
    player.dispose();
  });

  it("keeps the scheduled PCM timeline continuous across G2 mic opening", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const player = new PcmStreamPlayer(() => {});
    await player.enable({ confirmationTone: false });
    const context = FakeContext.instances[0]!;
    const chunk = { data: Buffer.alloc(3840, 7).toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 1920 };
    player.enqueue(chunk);
    const first = context.sources[0]!;
    player.prepareForRecording({ keepPlayback: true });
    player.resumeDuringRecording();
    player.enqueue(chunk);
    expect(first.stop).not.toHaveBeenCalled();
    expect(context.suspend).not.toHaveBeenCalled();
    expect(context.sources[1]!.start).toHaveBeenCalledExactlyOnceWith(first.start.mock.calls[0]![0] + first.buffer.duration);
    expect(audioSession.type).toBe("playback");
    player.dispose();
  });

  it("resumes queued audio after mic opening and on a native audio-context state change", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const player = new PcmStreamPlayer(() => {});
    await player.enable({ confirmationTone: false });
    const context = FakeContext.instances[0]!;
    player.prepareForRecording({ keepPlayback: true });
    context.state = "suspended";
    player.resumeDuringRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.state).toBe("running");
    context.state = "suspended";
    context.dispatchEvent(new Event("statechange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(context.state).toBe("running");
    expect(context.suspend).not.toHaveBeenCalled();
    player.dispose();
  });

  it("keeps Dots duplex audio across a hidden page, recovery during native open, and the native acknowledgement", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const player = new PcmStreamPlayer(() => {});
    await player.enable({ confirmationTone: false });
    const context = FakeContext.instances[0]!;
    const chunk = { data: Buffer.alloc(3840, 7).toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 1920 };
    player.enqueue(chunk);
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const mic = new OwnedMicrophone(async enabled => {
      if (enabled) { player.prepareForRecording({ keepPlayback: true }); await ack; }
      restorePhonePlayback(player, enabled ? "phone" : undefined);
    });
    try {
      const opening = mic.set(true, "phone");
      await Promise.resolve(); await Promise.resolve();
      expect(mic.activeRoute).toBe("phone");
      Object.assign(document, { visibilityState: "hidden" });
      context.state = "suspended";
      audioSession.type = "play-and-record";
      restorePhonePlayback(player, mic.activeRoute);
      await vi.advanceTimersByTimeAsync(0);
      expect(context.state).toBe("running");
      expect(audioSession.type).toBe("playback");

      // The SDK interrupts the route again just before acknowledging mic open.
      context.state = "suspended"; audioSession.type = "play-and-record";
      acknowledge(); await opening; await vi.advanceTimersByTimeAsync(0);
      expect(context.state).toBe("running");
      expect(audioSession.type).toBe("playback");
      player.enqueue(chunk);
      expect(context.sources[1]!.start).toHaveBeenCalledExactlyOnceWith(context.sources[0]!.buffer.duration + .025);
      expect(context.sources[0]!.stop).not.toHaveBeenCalled();
      expect(FakeAudio.instances[1]!.paused).toBe(false);

      // Returning while held must not clear duplex's native interruption repair.
      Object.assign(document, { visibilityState: "visible" });
      restorePhonePlayback(player, mic.activeRoute);
      context.state = "suspended"; context.dispatchEvent(new Event("statechange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(context.state).toBe("running");
      expect(context.suspend).not.toHaveBeenCalled();
      await mic.set(false, "phone");
      expect(mic.activeRoute).toBeUndefined();
    } finally { player.dispose(); }
  });

  it("plays fresh GPT speech while the mic stays open after an explicit interruption clears old audio", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const speaking = vi.fn(); const player = new PcmStreamPlayer(speaking);
    await player.enable({ confirmationTone: false });
    player.prepareForRecording({ keepPlayback: true });
    const chunk = { data: Buffer.alloc(3840, 7).toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 1920 };
    player.enqueue(chunk);
    const context = FakeContext.instances[0]!;
    player.clearBufferedAudio("api-barge-in");
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    speaking.mockClear();
    player.enqueue(chunk);
    expect(context.sources[1]?.start).toHaveBeenCalledOnce();
    expect(context.sources[1]?.stop).not.toHaveBeenCalled();
    expect(speaking).toHaveBeenCalledWith(true);
    expect(audioSession.type).toBe("playback");
    player.dispose();
  });

  it("coalesces resume attempts during burst delivery and does not restart playback after stop", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, AudioContext: FakeContext });
    const speaking = vi.fn(); const player = new PcmStreamPlayer(speaking);
    await player.enable({ confirmationTone: false });
    const context = FakeContext.instances[0]!;
    player.prepareForRecording({ keepPlayback: true });
    let finish!: () => void;
    context.resumeWait = new Promise(resolve => { finish = resolve; });
    context.state = "suspended";
    const baseline = context.resume.mock.calls.length;
    for (let i = 0; i < 10; i++) player.enqueue({ data: Buffer.alloc(3840, 7).toString("base64"), sampleRate: 48000, numChannels: 1, samplesPerChannel: 1920 });
    expect(context.resume).toHaveBeenCalledTimes(baseline + 1);
    player.stop(); finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(speaking).not.toHaveBeenCalledWith(true);
    expect(context.sources.every(source => source.stop.mock.calls.length === 1)).toBe(true);
    player.dispose();
  });
});
