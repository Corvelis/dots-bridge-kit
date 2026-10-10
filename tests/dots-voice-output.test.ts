import { describe, expect, it, vi } from "vitest";
import { LiveAudioOutput, monoPcm16 } from "../dots-voice-bridge/src/live-audio-output";
const packet = { streamId: "old", route: "original" as const, sampleRate: 48000, channels: 2 };
function setup() {
  const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  const reset = vi.fn(() => { socket.send("reset"); return "new"; }), record = vi.fn();
  return { socket, reset, record, output: new LiveAudioOutput(reset, record) };
}
describe("Live Dot speech under network pressure", () => {
  it("sends each original 40ms frame immediately, at 48kHz with half the bytes", () => {
    const t = setup(), stereo = Buffer.alloc(7680);
    for (let i = 0; i < stereo.length; i += 4) { stereo.writeInt16LE(-12345, i); stereo.writeInt16LE(-12345, i + 2); }
    expect(t.output.send(t.socket, stereo, packet)).toBe(true);
    expect(t.socket.send).toHaveBeenCalledTimes(2); expect(t.reset).not.toHaveBeenCalled();
    expect(JSON.parse(t.socket.send.mock.calls[0]![0] as string)).toMatchObject({ streamId: "old", sampleRate: 48000, channels: 1, byteLength: 3840 });
    const mono = t.socket.send.mock.calls[1]![0] as Buffer;
    expect(mono.length).toBe(3840); for (let i = 0; i < mono.length; i += 2) expect(mono.readInt16LE(i)).toBe(-12345);
  });
  it("averages opposite channels without overflow and preserves already-mono packets", () => {
    const stereo = Buffer.from([255, 127, 0, 128, 255, 127, 255, 127]);
    expect([...monoPcm16(stereo, 2)]).toEqual([0, 0, 255, 127]);
    const mono = Buffer.alloc(100); expect(monoPcm16(mono, 1)).toBe(mono);
  });
  it("drops complete packet pairs, keeps the socket open, and resets once at low water", () => {
    const t = setup(), pcm = Buffer.alloc(7680);
    t.socket.bufferedAmount = 384694;
    for (let i = 0; i < 100; i++) expect(t.output.send(t.socket, pcm, packet)).toBe(false);
    expect(t.socket.send).not.toHaveBeenCalled(); expect(t.socket.close).not.toHaveBeenCalled(); expect(t.record).toHaveBeenCalledTimes(1);
    t.socket.bufferedAmount = 6000; expect(t.output.send(t.socket, pcm, packet)).toBe(false);
    t.socket.bufferedAmount = 0; expect(t.output.send(t.socket, pcm, packet)).toBe(true);
    expect(t.socket.send.mock.calls.map(([v]) => Buffer.isBuffer(v) ? "pcm" : v === "reset" ? v : JSON.parse(v as string).streamId)).toEqual(["reset", "new", "pcm"]);
    expect(t.record).toHaveBeenLastCalledWith("client-output-recovered", { bufferedBytes: 0, droppedFrames: 101, droppedBytes: 3840 * 101 });
    t.output.send(t.socket, pcm, { ...packet, streamId: "new" }); expect(t.reset).toHaveBeenCalledOnce();
  });
  it("allows a complete large PCM packet and guards a socket closing during send", () => {
    const t = setup(); expect(t.output.send(t.socket, Buffer.alloc(48000), { ...packet, route: "original", channels: 1 })).toBe(true);
    t.socket.readyState = 3; expect(t.output.send(t.socket, Buffer.alloc(7680), packet)).toBe(false);
    t.socket.readyState = 1; t.socket.send.mockImplementation(() => { throw new Error("closed"); });
    expect(() => t.output.send(t.socket, Buffer.alloc(7680), packet)).not.toThrow(); expect(t.socket.close).not.toHaveBeenCalled();
  });
});
