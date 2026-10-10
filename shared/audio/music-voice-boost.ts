export type MusicVoiceBoostMode = "normal" | "strong";
export const MUSIC_VOICE_BOOST_KEY = "dots-phone-g2.music-voice-boost";
export const musicVoiceBoostMode = (value: unknown): MusicVoiceBoostMode => value === "normal" ? "normal" : "strong";

// +6 dB for quiet speech; linked peak limiting keeps boosted PCM below full scale.
// No lookahead, extra queue or timer on the live audio path.
const boostGain = 2;
const peakCeiling = 0.95;
const transitionSeconds = 0.05;
const releaseSeconds = 0.08;

export class MusicVoiceBoost {
  private active = false;
  private mix = 0;
  private limiter = 1;

  setActive(active: boolean): void { this.active = active; }

  reset(): void {
    this.mix = 0;
    this.limiter = 1;
  }

  process(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
    // Exact bypass, including the original buffer, outside music/boost transitions.
    if (!this.active && this.mix === 0) { this.limiter = 1; return pcm; }
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000 || (channels !== 1 && channels !== 2)) return pcm;
    const frames = Math.floor(pcm.byteLength / (channels * 2));
    const result = pcm.slice();
    const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const output = new DataView(result.buffer, result.byteOffset, result.byteLength);
    const step = 1 / (sampleRate * transitionSeconds);
    const release = Math.exp(-1 / (sampleRate * releaseSeconds));
    for (let frame = 0; frame < frames; frame++) {
      this.mix = this.active ? Math.min(1, this.mix + step) : Math.max(0, this.mix - step);
      let peak = 0;
      for (let channel = 0; channel < channels; channel++) {
        peak = Math.max(peak, Math.abs(input.getInt16((frame * channels + channel) * 2, true) / 32_768));
      }
      const limit = peak * boostGain > peakCeiling ? peakCeiling / (peak * boostGain) : 1;
      // Instant attack before this sample is written; shared gain preserves stereo balance.
      this.limiter = limit < this.limiter ? limit : limit + release * (this.limiter - limit);
      const gain = 1 + this.mix * (boostGain * this.limiter - 1);
      for (let channel = 0; channel < channels; channel++) {
        const offset = (frame * channels + channel) * 2;
        const sample = Math.round(input.getInt16(offset, true) * gain);
        output.setInt16(offset, Math.max(-32_768, Math.min(32_767, sample)), true);
      }
    }
    return result;
  }
}
