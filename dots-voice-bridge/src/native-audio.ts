import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { AudioRoute } from "./protocol";
const execFile = promisify(execFileCallback);
export class NativeAudioError extends Error {
  constructor(message: string, readonly code: string, readonly stage: string,
    readonly exitCode: number | null = null, readonly signal: string | null = null) { super(message); }
}
export function nativeFailureDetails(error: Error) {
  return error instanceof NativeAudioError
    ? { errorCode: error.code, stage: error.stage, exitCode: error.exitCode, signal: error.signal }
    : { errorCode: "capture-unknown", stage: "capture" };
}

export class NativeAudioRoute implements AudioRoute {
  private capture?: ChildProcessWithoutNullStreams;
  private previousInput?: string;
  private lockOwned = false;
  private buffer = Buffer.alloc(0);
  private droppedInputBytes = 0;
  onFailure?: (error: Error) => void;
  onDiagnostic?: (event: string, detail: Record<string, number | string>) => void;
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly deviceTool: string;
  private readonly captureTool: string;
  constructor(private root: string) {
    this.journalPath = resolve(root, ".state/audio-route.json");
    this.lockPath = resolve(root, "../.dots-bridge/dots-voice-audio.lock");
    this.deviceTool = resolve(root, "dist/dots-audio-device");
    this.captureTool = resolve(root, "dist/DotsVoiceAudioCapture.app/Contents/MacOS/DotsVoiceAudioCapture");
    if (existsSync(this.journalPath)) {
      const value = JSON.parse(readFileSync(this.journalPath, "utf8"));
      if (typeof value.previousInput !== "string" || !value.previousInput) throw new Error("Invalid saved audio route");
      this.previousInput = value.previousInput;
    }
  }
  get heldInput() { return Boolean(this.previousInput); }
  private async device(...args: string[]) {
    return (await execFile(this.deviceTool, args, { timeout: 5000 })).stdout.trim();
  }
  private acquireLock() {
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.lockPath)) {
      const pid = Number(readFileSync(this.lockPath, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid audio route lock");
      try { process.kill(pid, 0); throw new Error("Another Dots audio route is running"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      unlinkSync(this.lockPath);
    }
    writeFileSync(this.lockPath, String(process.pid), { mode: 0o600, flag: "wx" }); this.lockOwned = true;
  }
  async prepare(onAudio: (pcm: Buffer) => void, signal: AbortSignal) {
    if (process.platform !== "darwin") throw new Error("Dots audio routing currently requires macOS");
    if (this.previousInput) throw new Error("Confirm the previous call ended before reopening its audio route");
    if (!existsSync(this.deviceTool) || !existsSync(this.captureTool)) throw new Error("Build Dots native audio helpers first: npm run build:dots-voice:native");
    signal.throwIfAborted(); this.acquireLock();
    this.previousInput = await this.device("current-input");
    if (!this.previousInput) throw new Error("Could not identify the current microphone");
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.journalPath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ previousInput: this.previousInput }), { mode: 0o600 }); renameSync(temporary, this.journalPath);
    if (this.previousInput !== "BlackHole2ch_UID") await this.device("set-input", "BlackHole 2ch");
    signal.throwIfAborted();
    await this.startCapture(onAudio, signal);
  }
  /** Restore only the audio helper, retaining the call, input route and lock. */
  async restart(onAudio: (pcm: Buffer) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.previousInput || !this.lockOwned) throw new NativeAudioError("The saved audio route is unavailable", "capture-route-unavailable", "restart");
    await this.stopCapture(); signal.throwIfAborted();
    if (await this.device("current-input") !== "BlackHole2ch_UID") throw new NativeAudioError("The input device changed during the call", "capture-route-changed", "restart");
    signal.throwIfAborted(); await this.startCapture(onAudio, signal);
  }
  private async startCapture(onAudio: (pcm: Buffer) => void, signal: AbortSignal): Promise<void> {
    this.buffer = Buffer.alloc(0);
    this.droppedInputBytes = 0;
    // The process-tap path is opt-in until real Chrome audio has been verified.
    const captureArgs = process.env.DOTS_AUDIO_CAPTURE_MODE === "process-tap" ? ["--process-tap"] : [];
    const child = spawn(this.captureTool, captureArgs, { stdio: ["pipe", "pipe", "pipe"] }); this.capture = child;
    let failed = false;
    const failure = (error: Error) => {
      if (!failed && this.capture === child) { failed = true; this.onFailure?.(error); }
    };
    child.stdin.on("error", error => failure(new NativeAudioError(error.message, "capture-stdin-failed", "stdin")));
    await new Promise<void>((resolveReady, reject) => {
      let ready = false, diagnostic = "", diagnosticLine = "";
      const done = (error?: Error) => {
        clearTimeout(timer); signal.removeEventListener("abort", cancel);
        if (ready) return; ready = true; error ? reject(error) : resolveReady();
      };
      const cancel = () => done(new NativeAudioError("Audio preparation cancelled", "capture-aborted", "startup"));
      const timer = setTimeout(() => done(new NativeAudioError("Allow Screen & System Audio Recording for Dots Voice Audio Capture, then retry", "capture-ready-timeout", "startup")), 20_000);
      signal.addEventListener("abort", cancel, { once: true });
      child.stderr.on("data", chunk => {
        diagnostic = (diagnostic + chunk.toString()).slice(-2000);
        diagnosticLine += chunk.toString();
        const lines = diagnosticLine.split("\n"); diagnosticLine = lines.pop()!.slice(-2000);
        for (const line of lines) {
          const match = /input-overflow-recovered droppedBytes=(\d+) bufferedBytes=(\d+)/.exec(line);
          if (match && this.capture === child) this.onDiagnostic?.("native-input-overflow-recovered", { droppedBytes: Number(match[1]), bufferedBytes: Number(match[2]) });
        }
        if (diagnostic.includes("[dots-voice-capture] ready:")) done();
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.capture !== child) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const bytes = 48_000 * 2 * 2 * 0.04;
        while (this.buffer.length >= bytes) {
          const frame = Buffer.from(this.buffer.subarray(0, bytes)); this.buffer = this.buffer.subarray(bytes); onAudio(frame);
        }
      });
      child.once("error", error => done(new NativeAudioError(error.message, "capture-spawn-failed", "startup")));
      child.once("exit", (code, exitSignal) => {
        const isCurrent = this.capture === child;
        const errorCode = diagnostic.includes("input overflow") ? "capture-input-overflow" : diagnostic.includes("capture stopped:") ? "capture-stream-stopped" : "capture-process-exited";
        const error = new NativeAudioError(diagnostic.trim() || "Dots audio capture stopped", errorCode, "exit", code, exitSignal);
        if (!ready) done(error); else if (isCurrent) failure(error);
        if (isCurrent) this.capture = undefined;
      });
    });
    if (signal.aborted || this.capture !== child || child.exitCode !== null) throw new NativeAudioError("Audio capture did not remain ready", "capture-not-running", "startup");
  }
  append(pcm: Buffer) {
    const input = this.capture?.stdin;
    if (!input?.writable) throw new Error("Native audio input is unavailable");
    if (input.writableLength + pcm.length > 16_000) {
      if (!this.droppedInputBytes) this.onDiagnostic?.("native-input-congested", { bufferedBytes: input.writableLength, droppedBytes: pcm.length });
      this.droppedInputBytes += pcm.length;
      return false;
    }
    if (this.droppedInputBytes) {
      this.onDiagnostic?.("native-input-recovered", { bufferedBytes: input.writableLength, droppedBytes: this.droppedInputBytes });
      this.droppedInputBytes = 0;
    }
    input.write(pcm); return true;
  }
  private async stopCapture(): Promise<void> {
    const child = this.capture; this.capture = undefined; this.buffer = Buffer.alloc(0);
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolveExit => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolveExit(); }, 1000);
      child.once("exit", () => { clearTimeout(timer); resolveExit(); }); child.kill("SIGTERM");
    });
  }
  async stop(restoreInput: boolean) {
    await this.stopCapture();
    if (restoreInput && this.previousInput) {
     
      const current = await this.device("current-input");
      // Respect a microphone change made by the user during the call.
      if (current === "BlackHole2ch_UID" && current !== this.previousInput) await this.device("set-input", this.previousInput);
      this.previousInput = undefined;
      if (existsSync(this.journalPath)) unlinkSync(this.journalPath);
    }
    this.releaseLock();
  }
  private releaseLock() {
    if (this.lockOwned && existsSync(this.lockPath) && readFileSync(this.lockPath, "utf8") === String(process.pid)) unlinkSync(this.lockPath);
    this.lockOwned = false;
  }
}
