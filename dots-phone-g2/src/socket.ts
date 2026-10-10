export type WireMessage = Record<string, any>;
export interface AudioFrame { streamId: string; route: "original"; sampleRate: number; channels: number; byteLength: number }
export function audioFrame(value: WireMessage): AudioFrame {
  if (value.format !== "pcm_s16le" || typeof value.streamId !== "string"
    || value.route !== "original" || ![16000, 48000].includes(value.sampleRate)
    || ![1, 2].includes(value.channels) || !Number.isInteger(value.byteLength)
    || value.byteLength <= 0 || value.byteLength > 192000 || value.byteLength % (value.channels * 2)) throw new Error("音声フレームの形式が不正です");
  return value as AudioFrame;
}
export class PhoneSocket {
  ready = false;
  private socket?: WebSocket;
  private stopped = false;
  private retryAt = 0;
  private helloDeadline = 0;
  private sequence = 0;
  private metadata?: AudioFrame;
  private droppedInputBytes = 0;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; deadline: number }>();
  constructor(readonly url: string, private hello: WireMessage, private callbacks: {
    message(value: WireMessage): void;
    audio?(metadata: AudioFrame, bytes: Uint8Array): void;
    closed(reason: string): void;
    inputCongested?(): void;
    inputRecovered?(droppedBytes: number): void;
  }, private createSocket: (url: string) => WebSocket = url => new WebSocket(url)) {}
  get needsFastMaintenance(): boolean { return this.pending.size > 0 || !!this.helloDeadline || !this.ready && !this.stopped; }
  connect(): void {
    if (this.stopped || this.socket) return;
    const socket = this.createSocket(this.url); this.socket = socket;
    this.helloDeadline = Date.now() + 10_000;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => { if (this.socket === socket) socket.send(JSON.stringify(this.hello)); };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        if (typeof event.data !== "string") {
          const meta = this.metadata; this.metadata = undefined;
          if (!meta || !(event.data instanceof ArrayBuffer) || event.data.byteLength !== meta.byteLength) throw new Error("音声データの長さが一致しません");
          this.callbacks.audio?.(meta, new Uint8Array(event.data)); return;
        }
        const message = JSON.parse(event.data) as WireMessage;
        if (message.type === "audio.chunk") { if (this.metadata) throw new Error("音声データが欠落しました"); this.metadata = audioFrame(message); return; }
        if (typeof message.id === "string" && ("result" in message || "error" in message)) {
          const request = this.pending.get(message.id);
          if (request) { this.pending.delete(message.id); message.error ? request.reject(new Error(message.error.message || "ブリッジ操作に失敗しました")) : request.resolve(message.result); }
          return;
        }
        if (message.type === "voice.ready" || message.type === "dots.ready") {
          if (message.version !== 1) throw new Error("ブリッジのバージョンが一致しません");
          this.ready = true; this.helloDeadline = 0;
        }
        if (this.hello.type === "hello" && message.type === "echo.snapshot") { this.ready = true; this.helloDeadline = 0; }
        this.callbacks.message(message);
      } catch (error) { this.callbacks.closed(String(error)); socket.close(1002, "invalid frame"); }
    };
    socket.onerror = () => socket.close();
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.ready = false; this.metadata = undefined;
      this.droppedInputBytes = 0;
      for (const request of this.pending.values()) request.reject(new Error("ブリッジとの接続が切れました。通話状態を確認してください"));
      this.pending.clear(); this.helloDeadline = 0;
      if (event.code === 4401) this.stopped = true;
      this.retryAt = Date.now() + 2000;
      this.callbacks.closed(event.code === 4401 ? "ペアリング情報を確認してください" : "Macへの接続を待っています");
    };
  }
  /** Probe live connections after suspension without restarting an owned call. */
  probe(): void {
    if (!this.ready) { this.tick(Date.now()); return; }
    const socket = this.socket;
    this.helloDeadline = Date.now() + 10_000;
    if (this.hello.type === "hello") this.send({ type: "echo.snapshot.request" });
    else void this.request("status", {}, 10_000).then(result => {
      if (this.socket !== socket) return;
      this.helloDeadline = 0;
      if (this.hello.type === "voice.hello") this.callbacks.message({ ...result, type: "voice.state" });
    }).catch(() => { if (this.socket === socket) socket?.close(1000, "resume probe failed"); });
  }
  request(method: string, params: WireMessage = {}, timeoutMs = 120_000): Promise<any> {
    if (!this.ready || this.socket?.readyState !== 1) return Promise.reject(new Error("Macに接続されていません"));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, deadline: Date.now() + timeoutMs });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  send(message: WireMessage): boolean {
    if (!this.ready || this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  sendPcm(bytes: Uint8Array): boolean {
    if (!this.ready || this.socket?.readyState !== 1 || !bytes.length || bytes.length % 2) return false;
    if (this.socket.bufferedAmount + bytes.length > 16000) {
      // Live calls favor fresh microphone audio over replaying a stalled queue.
      // ASR uploads must still report failure: dropping their PCM loses text.
      if (this.hello.type !== "voice.hello") return false;
      if (!this.droppedInputBytes) this.callbacks.inputCongested?.();
      this.droppedInputBytes += bytes.length; return true;
    }
    if (this.droppedInputBytes) {
      const dropped = this.droppedInputBytes; this.droppedInputBytes = 0;
      this.callbacks.inputRecovered?.(dropped);
    }
    for (let offset = 0; offset < bytes.length; offset += 6400) this.socket.send(bytes.slice(offset, offset + 6400));
    return true;
  }
  tick(now: number): void {
    if (!this.socket && !this.stopped && now >= this.retryAt) this.connect();
    if (this.helloDeadline && now >= this.helloDeadline) this.socket?.close(1000, "handshake timeout");
    for (const [id, request] of this.pending) if (now >= request.deadline) {
      this.pending.delete(id); request.reject(new Error("ブリッジの操作が時間内に完了しませんでした。状態を確認してください"));
    }
  }
  dispose(): void {
    this.stopped = true;
    this.socket?.close(1000, "app exit");
  }
}
