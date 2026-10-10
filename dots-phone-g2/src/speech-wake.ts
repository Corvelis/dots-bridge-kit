/** Audio is continuous, including silence. Wake only at a new audible utterance. */
export class SpeechWake {
  speaking = false;
  energy = 0;
  private loudMs = 0;
  private quietMs = 0;
  reset(keepSpeaking = false): void {
    if (!keepSpeaking) this.speaking = false;
    this.energy = 0; this.loudMs = 0; this.quietMs = 0;
  }
  feed(bytes: Uint8Array, sampleRate: number, channels: number): boolean {
    const frames = bytes.byteLength / (2 * channels);
    if (!frames || !Number.isInteger(frames) || sampleRate <= 0) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let square = 0, peak = 0;
    for (let frame = 0; frame < frames; frame++) {
      let value = 0;
      for (let ch = 0; ch < channels; ch++) value = Math.max(value, Math.abs(view.getInt16((frame * channels + ch) * 2, true) / 32768));
      square += value * value; peak = Math.max(peak, value);
    }
    const rms = Math.sqrt(square / frames), duration = frames * 1000 / sampleRate;
    this.energy = Math.min(1, rms * 8);
    const audible = rms >= .012 && peak >= .035;
    if (audible) {
      this.quietMs = 0; this.loudMs += duration;
      if (!this.speaking && this.loudMs >= 60) { this.speaking = true; return true; }
    } else {
      this.loudMs = 0; this.quietMs += duration;
      if (this.quietMs >= 450) this.speaking = false;
    }
    return false;
  }
}
