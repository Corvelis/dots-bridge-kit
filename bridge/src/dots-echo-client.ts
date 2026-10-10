import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { DotMessage } from "./dots-relay";
import type { DotNotification } from "./dots-inbox";

export interface DotsNotificationPage {
  items: DotNotification[];
  nextCursor: number;
  hasMore: boolean;
  gap: boolean;
}

interface RpcPending {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Text transport to the existing browser bridge. Never re-sends a turn after a disconnect. */
export class DotsEchoClient extends EventEmitter {
  private socket?: WebSocket;
  private running = false;
  private authenticated = false;
  private online = false;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private rpcSequence = 0;
  private readonly requests = new Map<string, RpcPending>();
  private readonly turns = new Map<string, (message?: DotMessage, error?: Error) => void>();

  constructor(private readonly options: {
    url: string;
    token: string;
    appId?: string;
    reconnectMs?: number;
    rpcTimeoutMs?: number;
    turnTimeoutMs?: number;
  }) {
    super();
    const url = new URL(options.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
      throw new Error("Dots Echo URL must be a WebSocket URL without credentials");
    }
  }

  get ready(): boolean { return this.authenticated && this.online; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.socket?.terminate();
    this.disconnected();
  }

  private updateOnline(online: boolean): void {
    const previous = this.ready;
    this.online = online;
    if (previous !== this.ready) this.emit("status", this.ready);
  }

  private connect(): void {
    if (!this.running) return;
    const socket = new WebSocket(this.options.url, { maxPayload: 128 * 1024 });
    this.socket = socket;
    const helloTimeout = setTimeout(() => socket.terminate(), 5_000);
    helloTimeout.unref();
    socket.on("open", () => socket.send(JSON.stringify({
      type: "dots.hello", version: 1,
      appId: this.options.appId ?? "dots-asr", token: this.options.token,
    })));
    socket.on("message", (raw) => {
      if (socket !== this.socket) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "dots.ready") {
          clearTimeout(helloTimeout);
          this.authenticated = true;
          this.updateOnline(message.workerOnline === true);
          this.emit("connected");
          this.heartbeat = setInterval(() => {
            void this.rpc("status", {}).then(status => this.updateOnline(status.workerOnline === true))
              .catch(() => socket.terminate());
          }, 2_000);
          this.heartbeat.unref();
        } else if (message.type === "dots.message") {
          this.turns.get(message.message.requestId)?.(message.message);
        } else if (message.type === "dots.notification") {
          this.emit("notification");
        } else if (typeof message.id === "string") {
          const pending = this.requests.get(message.id);
          if (!pending) return;
          this.requests.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message || "Dots request failed"));
          else pending.resolve(message.result);
        }
      } catch {
        socket.terminate();
      }
    });
    socket.on("error", () => undefined); // No credentials or conversation text in diagnostics.
    socket.on("close", () => {
      clearTimeout(helloTimeout);
      if (socket !== this.socket) return;
      this.socket = undefined;
      this.disconnected();
      if (this.running) {
        this.retry = setTimeout(() => this.connect(), this.options.reconnectMs ?? 1_000);
        this.retry.unref();
      }
    });
  }

  private disconnected(): void {
    const wasReady = this.ready;
    this.authenticated = false;
    this.online = false;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const error = new Error("DOTS CONNECTION LOST // The dot may have received the message; it will not be sent again automatically");
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.requests.clear();
    for (const finish of [...this.turns.values()]) finish(undefined, error);
    if (wasReady) this.emit("status", false);
  }

  private rpc<T = any>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!this.authenticated || socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("DOTS BRIDGE IS OFFLINE"));
    }
    const id = `echo-${++this.rpcSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error("DOTS REQUEST TIMED OUT // It will not be sent again automatically"));
      }, this.options.rpcTimeoutMs ?? 5_000);
      timer.unref();
      this.requests.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.requests.get(id);
        if (!pending) return;
        this.requests.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  ask(text: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (!this.ready) return Promise.reject(new Error("DOTS IS OFFLINE // Open the dot window and Dots Bridge Kit in Chrome"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (message?: DotMessage, error?: Error) => {
        if (!this.turns.has(requestId)) return;
        if (!error && message?.status !== "completed" && message?.status !== "failed" && message?.status !== "uncertain") return;
        this.turns.delete(requestId);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else if (message?.status === "completed" && message.reply?.trim()) resolve(message.reply);
        else reject(new Error(message?.error || "DOTS returned no reply"));
      };
      const onAbort = () => finish(undefined, new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => finish(undefined,
        new Error("DOTS REPLY TIMED OUT // The dot may still be answering; it will not be sent again automatically")),
      this.options.turnTimeoutMs ?? 180_000);
      timer.unref();
      this.turns.set(requestId, finish);
      signal.addEventListener("abort", onAbort, { once: true });
      // Register before sending: the completion event may precede the RPC response.
      void this.rpc<DotMessage>("message/send", { requestId, text })
        .then(message => finish(message)).catch(error => finish(undefined, error));
    });
  }

  notifications(after: number): Promise<DotsNotificationPage> {
    return this.rpc("notification/sync", { after, limit: 100 });
  }
}
