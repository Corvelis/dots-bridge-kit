class DotsMic extends AudioWorkletProcessor {
  constructor() {
    super(); this.enabled = false; this.samples = []; this.position = 0; this.frame = [];
    this.port.onmessage = event => { this.enabled = event.data === true; this.samples = []; this.position = 0; this.frame = []; };
  }
  process(inputs) {
    if (!this.enabled) return true;
    const input = inputs[0]?.[0]; if (!input) return true;
    this.samples.push(...input);
    const ratio = sampleRate / 16000;
    while (this.position + 1 < this.samples.length) {
      const index = Math.floor(this.position), blend = this.position - index;
      const value = this.samples[index] * (1 - blend) + this.samples[index + 1] * blend;
      this.frame.push(Math.max(-32768, Math.min(32767, Math.round(value * 32768)))); this.position += ratio;
      if (this.frame.length === 320) {
        const bytes = new ArrayBuffer(640), view = new DataView(bytes);
        this.frame.forEach((value, i) => view.setInt16(i * 2, value, true));
        this.port.postMessage(bytes, [bytes]); this.frame = [];
      }
    }
    const consumed = Math.min(Math.floor(this.position), this.samples.length);
    this.samples.splice(0, consumed); this.position -= consumed;
    return true;
  }
}
registerProcessor("dots-mic", DotsMic);
