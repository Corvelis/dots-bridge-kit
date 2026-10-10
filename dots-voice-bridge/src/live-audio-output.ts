export interface AudioRecipient {
  readyState: number;
  bufferedAmount: number;
  send(data: string | Buffer): void;
}
export interface OutputPacket { streamId: string; route: "original"; sampleRate: number; channels: number }
type RecordEvent = (event: string, detail: Record<string, string | number>) => void;
export const OUTPUT_QUEUE_MS = 200;
const RESUME_QUEUE_MS = 40;
const METADATA_ALLOWANCE = 512;

/** 48 kHz is retained; clients already downmix stereo Dot speech to mono. */
export function monoPcm16(pcm: Buffer, channels: number): Buffer {
  if (channels === 1) return pcm;
  if (channels !== 2 || pcm.length % 4) throw new Error("Invalid stereo PCM");
  const mono = Buffer.allocUnsafe(pcm.length / 2);
  for (let i = 0; i < mono.length; i += 2) mono.writeInt16LE(Math.round((pcm.readInt16LE(i * 2) + pcm.readInt16LE(i * 2 + 2)) / 2), i);
  return mono;
}

/** No extra queue/timer: drop whole stale packets under pressure, then resume live. */
export class LiveAudioOutput {
  private gaps = new WeakMap<AudioRecipient, { droppedBytes: number; droppedFrames: number }>();
  constructor(private reset: () => string, private record: RecordEvent) {}
  send(socket: AudioRecipient, pcm: Buffer, packet: OutputPacket): boolean {
    if (socket.readyState !== 1) return false;
    const bytes = monoPcm16(pcm, packet.channels);
    const bytesPerSecond = packet.sampleRate * 2;
    const limit = Math.max(bytes.length, Math.ceil(bytesPerSecond * OUTPUT_QUEUE_MS / 1000)) + METADATA_ALLOWANCE;
    let gap = this.gaps.get(socket);
    if (socket.bufferedAmount + bytes.length > limit || gap && socket.bufferedAmount > bytesPerSecond * RESUME_QUEUE_MS / 1000) {
      if (!gap) {
        gap = { droppedBytes: 0, droppedFrames: 0 }; this.gaps.set(socket, gap);
        this.record("client-output-congested", { bufferedBytes: socket.bufferedAmount, queueLimitMs: OUTPUT_QUEUE_MS });
      }
      gap.droppedBytes += bytes.length; gap.droppedFrames++;
      return false;
    }
    try {
      let streamId = packet.streamId;
      if (gap) {
        // The reset follows previously queued complete packets. Metadata and
        // binary are always paired, including during congestion recovery.
        streamId = this.reset();
        this.record("client-output-recovered", { bufferedBytes: socket.bufferedAmount, ...gap }); this.gaps.delete(socket);
      }
      socket.send(JSON.stringify({ type: "audio.chunk", streamId, route: packet.route,
        format: "pcm_s16le", sampleRate: packet.sampleRate, channels: 1, byteLength: bytes.length }));
      socket.send(bytes);
      return true;
    } catch {
      this.record("client-output-send-failed", { bufferedBytes: socket.bufferedAmount });
      return false;
    }
  }
}
