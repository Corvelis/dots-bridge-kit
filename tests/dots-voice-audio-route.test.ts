import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), device: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: mocks.spawn,
  execFile: Object.assign(mocks.device, { [Symbol.for("nodejs.util.promisify.custom")]: mocks.device }),
}));
import { NativeAudioRoute, nativeFailureDetails } from "../dots-voice-bridge/src/native-audio";
class Capture extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null; signalCode: string | null = null;
  kill(signal: string) { this.signalCode = signal; this.emit("exit", null, signal); return true; }
  fail() { this.exitCode = 1; this.emit("exit", 1, null); }
}
let directory: string, root: string, input: string, captures: Capture[], ready: boolean;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dots-audio-route-")); root = join(directory, "dots-voice-bridge");
  mkdirSync(join(root, "dist/DotsVoiceAudioCapture.app/Contents/MacOS"), { recursive: true });
  writeFileSync(join(root, "dist/dots-audio-device"), ""); writeFileSync(join(root, "dist/DotsVoiceAudioCapture.app/Contents/MacOS/DotsVoiceAudioCapture"), "");
  input = "physical-mic"; captures = []; ready = true;
  mocks.device.mockReset().mockImplementation(async (tool: string, args: string[]) => {
    if (tool === "/bin/ps") return { stdout: "" };
    if (args[0] === "set-input") input = args[1] === "BlackHole 2ch" ? "BlackHole2ch_UID" : args[1]!;
    return { stdout: args[0] === "current-input" ? input : "" };
  });
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new Capture(); captures.push(child);
    if (ready) queueMicrotask(() => child.stderr.write("[dots-voice-capture] ready: fixture\n"));
    return child;
  });
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
describe.skipIf(process.platform !== "darwin")("Native audio helper lifecycle", () => {
  it("retains route and lock during helper restart, ignores old output, and restores only on stop", async () => {
    const route = new NativeAudioRoute(root), output = vi.fn(), failure = vi.fn(); route.onFailure = failure;
    await route.prepare(output, new AbortController().signal); const lock = join(directory, ".dots-bridge/dots-voice-audio.lock");
    expect(input).toBe("BlackHole2ch_UID"); expect(existsSync(lock)).toBe(true);
    captures[0]!.stdout.write(Buffer.alloc(7680)); expect(output).toHaveBeenCalledOnce();
    captures[0]!.fail(); expect(failure).toHaveBeenCalledOnce();
    expect(nativeFailureDetails(failure.mock.calls[0]![0])).toMatchObject({ errorCode: "capture-process-exited", exitCode: 1 });
    await route.restart(output, new AbortController().signal);
    expect(route.heldInput).toBe(true); expect(existsSync(lock)).toBe(true); expect(input).toBe("BlackHole2ch_UID");
    captures[0]!.stdout.write(Buffer.alloc(7680)); expect(output).toHaveBeenCalledOnce();
    captures[1]!.stdout.write(Buffer.alloc(7680)); expect(output).toHaveBeenCalledTimes(2);
    await route.stop(true); expect(input).toBe("physical-mic"); expect(route.heldInput).toBe(false); expect(existsSync(lock)).toBe(false);
    expect(failure).toHaveBeenCalledOnce();
  });
  it("bounds stdin without throwing, deduplicates congestion, and counts recovery", async () => {
    const route = new NativeAudioRoute(root), diagnostic = vi.fn(); route.onDiagnostic = diagnostic;
    await route.prepare(() => {}, new AbortController().signal);
    Object.defineProperty(captures[0]!.stdin, "writableLength", { configurable: true, get: () => 15900 });
    expect(route.append(Buffer.alloc(640))).toBe(false); expect(route.append(Buffer.alloc(640))).toBe(false); expect(diagnostic).toHaveBeenCalledTimes(1);
    Object.defineProperty(captures[0]!.stdin, "writableLength", { configurable: true, get: () => 0 });
    expect(route.append(Buffer.alloc(640))).toBe(true);
    expect(diagnostic).toHaveBeenLastCalledWith("native-input-recovered", { bufferedBytes: 0, droppedBytes: 1280 }); await route.stop(true);
  });
  it("reassembles fragmented safe diagnostics and deduplicates stdin error plus exit", async () => {
    const route = new NativeAudioRoute(root), diagnostic = vi.fn(), failure = vi.fn(); route.onDiagnostic = diagnostic; route.onFailure = failure;
    await route.prepare(() => {}, new AbortController().signal);
    captures[0]!.stderr.write("[dots-voice-capture] input-overflow-recovered droppedBytes=6");
    captures[0]!.stderr.write("40 bufferedBytes=16000\n");
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith("native-input-overflow-recovered", { droppedBytes: 640, bufferedBytes: 16000 });
    captures[0]!.stdin.emit("error", new Error("EPIPE private diagnostics")); captures[0]!.fail();
    expect(failure).toHaveBeenCalledOnce(); expect(JSON.stringify(nativeFailureDetails(failure.mock.calls[0]![0]))).not.toContain("private"); await route.stop(true);
  });
  it("cancels preparation of a replacement and stops it before releasing its audio route", async () => {
    const route = new NativeAudioRoute(root); await route.prepare(() => {}, new AbortController().signal);
    ready = false; const abort = new AbortController(); const restarted = route.restart(() => {}, abort.signal);
    const rejection = expect(restarted).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(captures).toHaveLength(2)); abort.abort(); await rejection;
    await route.stop(true); expect(captures[1]!.signalCode).toBe("SIGTERM"); expect(input).toBe("physical-mic");
  });
  it("refuses to take back a microphone changed by the user during recovery", async () => {
    const route = new NativeAudioRoute(root); await route.prepare(() => {}, new AbortController().signal); input = "user-mic";
    await expect(route.restart(() => {}, new AbortController().signal)).rejects.toThrow("input device changed");
    expect(captures).toHaveLength(1); await route.stop(true); expect(input).toBe("user-mic");
  });
});
