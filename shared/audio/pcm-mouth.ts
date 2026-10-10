import { pcm16ChunkMouthLevel } from "./audio-envelope";

interface MouthWindow {
  start: number;
  end: number;
  level: number;
}

/** Small amplitude windows on the playback clock, never on WebSocket arrival time. */
export class PcmMouthTimeline {
  private windows: MouthWindow[] = [];

  append(pcm: Uint8Array, sampleRate: number, channels: number, start: number): void {
    const frameBytes = channels * 2;
    const frames = Math.floor(pcm.byteLength / frameBytes);
    const windowFrames = Math.max(1, Math.round(sampleRate * 0.06));
    for (let offset = 0; offset < frames; offset += windowFrames) {
      const end = Math.min(frames, offset + windowFrames);
      this.windows.push({
        start: start + offset / sampleRate,
        end: start + end / sampleRate,
        level: pcm16ChunkMouthLevel(pcm.subarray(offset * frameBytes, end * frameBytes)),
      });
    }
  }

  levelAt(time: number): number {
    const next = this.windows.findIndex((frame) => frame.end > time);
    if (next < 0) { this.clear(); return 0; }
    if (next > 0) this.windows.splice(0, next);
    const frame = this.windows[0];
    return frame && time >= frame.start ? frame.level : 0;
  }

  clear(): void { this.windows = []; }
}
