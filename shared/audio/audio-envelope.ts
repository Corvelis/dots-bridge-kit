// Use one shared cadence for both the phone preview and G2 image transfer.
// Faster updates looked overly busy on the phone and could not be rendered in
// time over the G2 BLE image channel.
export const MOUTH_FRAME_MS = 300;

/** Maps one raw little-endian PCM16 microphone chunk to a 0–3 mouth level. */
export function pcm16ChunkMouthLevel(bytes: Uint8Array): number {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (!sampleCount) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32768;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  if (rms < 0.012) return 0;
  if (rms < 0.035) return 1;
  if (rms < 0.09) return 2;
  return 3;
}

