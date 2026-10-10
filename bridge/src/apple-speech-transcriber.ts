import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface SpeechEvent {
  ready?: boolean;
  text?: string;
  final?: boolean;
  error?: string;
}

interface SpeechStatus {
  authorization?: string;
  ok?: boolean;
}

interface SpeechSession {
  threadId: string;
  chunks: Buffer[];
  byteLength: number;
  onTranscript?: (text: string) => void;
}

const MAX_AUDIO_BYTES = 16_000 * 2 * 10 * 60;

export function parseSpeechEvent(line: string): SpeechEvent | undefined {
  try {
    const value = JSON.parse(line) as SpeechEvent;
    if (value.ready === true) return { ready: true };
    if (typeof value.text === "string") {
      return { text: value.text, final: value.final === true };
    }
    if (typeof value.error === "string") return { error: value.error };
  } catch {
    // Ignore unrelated native diagnostics.
  }
  return undefined;
}

/** Buffers 16 kHz mono signed-16-bit G2 PCM for on-device macOS transcription. */
export class AppleSpeechTranscriber {
  private readonly appPath =
    process.env.DOTS_SPEECH_APP ||
    resolve(process.cwd(), "bridge", "bin", "Dots Speech.app");
  private readonly binaryPath = resolve(
    this.appPath,
    "Contents",
    "MacOS",
    "dots-speech-transcribe",
  );
  private session?: SpeechSession;
  private ready = false;
  private probeInFlight?: Promise<{ ok: boolean; authorization: string }>;

  async probe(): Promise<{ ok: boolean; authorization: string }> {
    if (this.ready) return { ok: true, authorization: "authorized" };
    if (this.probeInFlight) return this.probeInFlight;
    if (!existsSync(this.binaryPath)) return { ok: false, authorization: "missing" };
    const probe = new Promise<{ ok: boolean; authorization: string }>((resolveStatus) => {
      const child = spawn(this.binaryPath, ["status"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.once("error", () => resolveStatus({ ok: false, authorization: "unavailable" }));
      child.once("close", () => {
        try {
          const status = JSON.parse(stdout.trim().split("\n").at(-1) || "{}") as SpeechStatus;
          const normalized = {
            ok: status.ok === true,
            authorization: status.authorization || "unknown",
          };
          if (normalized.ok) this.ready = true;
          resolveStatus(normalized);
        } catch {
          resolveStatus({ ok: false, authorization: "unknown" });
        }
      });
    });
    this.probeInFlight = probe;
    try {
      return await probe;
    } finally {
      if (this.probeInFlight === probe) this.probeInFlight = undefined;
    }
  }

  async start(threadId: string, onTranscript?: (text: string) => void): Promise<void> {
    if (this.session) throw new Error("Another G2 microphone session is already active");
    const status = await this.probe();
    if (!status.ok) {
      throw new Error(`G2 speech recognition is ${status.authorization}`);
    }
    this.session = { threadId, chunks: [], byteLength: 0, onTranscript };
  }

  appendPcm(threadId: string, pcm: Buffer): boolean {
    const session = this.session;
    if (!session || session.threadId !== threadId || pcm.byteLength < 2) return false;
    const evenLength = pcm.byteLength - (pcm.byteLength % 2);
    if (session.byteLength + evenLength > MAX_AUDIO_BYTES) return false;
    session.chunks.push(Buffer.from(pcm.subarray(0, evenLength)));
    session.byteLength += evenLength;
    return true;
  }

  async stop(threadId: string): Promise<string> {
    const session = this.requireSession(threadId);
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "dots-g2-speech-"));
    const inputPath = join(temporaryDirectory, "input.pcm");
    const outputPath = join(temporaryDirectory, "output.jsonl");
    writeFileSync(inputPath, Buffer.concat(session.chunks, session.byteLength), { mode: 0o600 });
    try {
      await this.runSpeechHelper(inputPath, outputPath);
      const events = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map(parseSpeechEvent)
        .filter((event): event is SpeechEvent => Boolean(event));
      const failure = [...events].reverse().find((event) => event.error)?.error;
      if (failure) throw new Error(failure);
      const transcript = [...events].reverse().find((event) => event.text !== undefined)?.text?.trim() ?? "";
      session.onTranscript?.(transcript);
      return transcript;
    } finally {
      if (this.session === session) this.session = undefined;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async cancel(threadId: string): Promise<void> {
    if (this.session?.threadId === threadId) this.session = undefined;
  }

  private requireSession(threadId: string): SpeechSession {
    const session = this.session;
    if (!session || session.threadId !== threadId) {
      throw new Error("No matching G2 microphone session");
    }
    return session;
  }

  private runSpeechHelper(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(
        this.binaryPath,
        ["transcribe-file", inputPath, outputPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("G2 speech recognition timed out"));
      }, 120_000);
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && existsSync(outputPath)) resolveRun();
        else reject(new Error(stderr.trim() || "G2 speech recognition failed"));
      });
    });
  }

}
