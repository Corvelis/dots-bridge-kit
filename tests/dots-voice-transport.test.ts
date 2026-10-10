import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { LiveAudioOutput } from "../dots-voice-bridge/src/live-audio-output";
import { VoiceSession } from "../dots-voice-bridge/src/session";
import type { CallSnapshot } from "../dots-voice-bridge/src/protocol";

describe("Live call over real localhost WebSocket", () => {
  it("preserves a held call through congestion, paired output reset and native recovery", async () => {
    // Isolated transport and synthetic PCM only; no real Dot or Mac audio.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
    const connected = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as {port: number}).port}`);
    const [socket] = await connected as [WebSocket]; await once(client, "open");
    const received: { binary: boolean; bytes: Buffer }[] = [];
    client.on("message", (bytes, binary) => received.push({ binary, bytes: Buffer.from(bytes as Buffer) }));
    let pressure = 0, id: string | null = null, source: (pcm: Buffer) => void = () => {};
    Object.defineProperty(socket, "bufferedAmount", { get: () => pressure });
    const commands: string[] = [], diagnostic = vi.fn();
    const output = new LiveAudioOutput(() => session.resetForOutputGap(), diagnostic);
    const session = new VoiceSession({
      browser: { online: true, async command(action, sessionId) {
        commands.push(action); if (action === "start") id = sessionId!; if (action === "stop") id = null;
        return { state: id ? "active" : "idle", ownedSession: id, muted: id ? false : null, url: "fixture" } as CallSnapshot;
      } },
      audio: { heldInput: false, async prepare(cb) { source = cb; }, append() {}, async restart(cb) { source = cb; }, async stop() {} },
      saveRecovery() {}, emit(value) { socket.send(JSON.stringify(value)); },
      output(pcm, rate, channels, streamId) { output.send(socket, pcm, { streamId, route: session.route, sampleRate: rate, channels }); },
    });
    try {
      await session.start("phone");
      const originalId = session.sessionId; session.setInput("phone", true);
      source(Buffer.alloc(7680, 1)); pressure = 384694;
      for (let i = 0; i < 100; i++) source(Buffer.alloc(7680, 2));
      expect(session.inputEnabled).toBe(true); expect(session.phase).toBe("active"); expect(commands).not.toContain("stop");
      pressure = 0; source(Buffer.alloc(7680, 3));
      session.audioFailed(new Error("fixture stopped")); await vi.waitFor(() => expect(session.status.recovery.audio).toBe(false));
      source(Buffer.alloc(7680, 4));
      await vi.waitFor(() => expect(received.filter(frame => frame.binary)).toHaveLength(3));
      let stateStream = "";
      for (let index = 0; index < received.length; index++) {
        if (!received[index]!.binary) {
          const message = JSON.parse(received[index]!.bytes.toString());
          if (message.type === "voice.state") stateStream = message.streamId;
        }
        if (!received[index]!.binary) continue;
        const metadata = JSON.parse(received[index - 1]!.bytes.toString());
        expect(metadata).toMatchObject({ type: "audio.chunk", sampleRate: 48000, channels: 1, byteLength: 3840 });
        // Existing G2 receivers match chunks against the last state stream.
        expect(metadata.streamId).toBe(stateStream);
        expect(received[index]!.bytes.length).toBe(3840);
      }
      const resets = received.filter(frame => !frame.binary).map(frame => JSON.parse(frame.bytes.toString())).filter(message => message.type === "audio.reset");
      expect(resets.map(value => value.reason)).toContain("output-backpressure"); expect(resets.map(value => value.reason)).toContain("audio-recovered");
      expect(new Set(resets.map(value => value.streamId)).size).toBe(resets.length);
      expect(session.phase).toBe("active"); expect(session.sessionId).toBe(originalId); expect(session.inputEnabled).toBe(false);
      expect(commands.filter(v => v === "start")).toHaveLength(1); expect(commands).not.toContain("stop");
      expect(diagnostic).toHaveBeenCalledWith("client-output-recovered", expect.objectContaining({ droppedFrames: 100 }));
      await session.stop("phone");
    } finally {
      await session.stop().catch(() => {}); client.terminate(); socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
