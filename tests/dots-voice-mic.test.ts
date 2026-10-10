import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function microphone(sampleRate: number) {
  const frames: ArrayBuffer[] = [];
  let Processor: any;
  class AudioWorkletProcessor { port = { onmessage: (_event: any) => {}, postMessage: (frame: ArrayBuffer) => frames.push(frame) }; }
  runInNewContext(readFileSync("dots-voice-bridge/public/mic-worklet.js", "utf8"), {
    AudioWorkletProcessor, sampleRate, registerProcessor: (_name: string, processor: any) => { Processor = processor; },
  });
  const mic = new Processor();
  return { mic, frames, feed(samples: Float32Array) {
    for (let i = 0; i < samples.length; i += 128) mic.process([[samples.subarray(i, i + 128)]]);
  } };
}

describe("Dots external microphone PCM", () => {
  it.each([48_000, 44_100])("preserves duration at %iHz across worklet block boundaries", rate => {
    const t = microphone(rate); t.mic.port.onmessage({ data: true });
    // A ramp exposes missing or repeated samples at the 128-sample boundaries.
    t.feed(Float32Array.from({ length: rate }, (_, i) => i / rate));
    expect(t.frames).toHaveLength(50);
    const samples = t.frames.flatMap(frame => {
      expect(frame.byteLength).toBe(640);
      const view = new DataView(frame); return Array.from({ length: 320 }, (_, i) => view.getInt16(i * 2, true));
    });
    for (let i = 0; i < samples.length; i++) expect(samples[i]).toBeCloseTo(Math.round(i / 16_000 * 32768), 0);
  });
  it("discards partial audio when PTT ends and emits only new PCM after the next press", () => {
    const t = microphone(48_000);
    t.feed(new Float32Array(960).fill(0.5)); expect(t.frames).toHaveLength(0);
    t.mic.port.onmessage({ data: true }); t.feed(new Float32Array(480).fill(0.5));
    t.mic.port.onmessage({ data: false }); t.feed(new Float32Array(960).fill(0.5)); expect(t.frames).toHaveLength(0);
    t.mic.port.onmessage({ data: true }); t.feed(new Float32Array(960).fill(-0.5));
    expect(t.frames).toHaveLength(1);
    expect(new DataView(t.frames[0]).getInt16(0, true)).toBe(-16384);
  });
});
