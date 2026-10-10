import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DotsRelay } from "./dots-relay";
import { DotsInbox, validDotSource } from "./dots-inbox";
import { DotsConversation, CONVERSATION_BYTES } from "./dots-conversation";

export const DOTS_WS_PATH = "/dots/ws";
const WORKER_PATH = "/dots/worker/";
const loopback = (address: string | undefined) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

export function dotsWorkerConfig(path: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dots port");
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  const token = existing?.token ?? randomBytes(32).toString("hex");
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid dots worker credential");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token }), { mode: 0o600 });
  renameSync(tmp, path);
  return token;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported parameter");
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : "Dots relay failed"; }

export class DotsGateway {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private readonly workerToken: string;
  readonly relay: DotsRelay;
  readonly inbox: DotsInbox;
  readonly conversation: DotsConversation;

  constructor(private readonly options: {
    tokenMatches(token: string | undefined): boolean;
    workerToken: string | (() => string);
    historyPath: string;
    timeoutMs?: number;
  }) {
    this.relay = new DotsRelay(options.historyPath, options.timeoutMs);
    try {
      this.conversation = new DotsConversation(`${options.historyPath}.conversation.json`);
      this.inbox = new DotsInbox(`${options.historyPath}.notifications.json`);
      for (const input of this.relay.inputHistory()) this.inbox.publish(`relay-input:${input.id}`, input.text,
        { role: "user", inputId: input.id, receivedAt: input.createdAt });
      this.workerToken = typeof options.workerToken === "function" ? options.workerToken() : options.workerToken;
      if (!this.workerToken) throw new Error("Dots worker credential is required");
    } catch (error) { this.relay.close(); throw error; }
    this.server.on("connection", socket => this.accept(socket));
  }

  get status() { return { enabled: true, path: DOTS_WS_PATH, protocol: 1, inputHistory: true, conversationHistory: true, ...this.relay.status }; }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(request, socket, head, client => this.server.emit("connection", client));
  }

  accept(socket: WebSocket): void {
    this.clients.add(socket);
    let appId = "";
    let notifications = false, includeInputs = false, conversation = false;
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, "client is too slow"); return; }
      socket.send(JSON.stringify(message));
    };
    const timer = setTimeout(() => socket.close(4401, "dots.hello required"), 5000);
    const unsubscribe = this.relay.subscribe(message => {
      if (appId && message.appId === appId) send({ type: "dots.message", message });
    });
    const unsubscribeInbox = this.inbox.subscribe(notification => {
      if (appId && notifications && (includeInputs || notification.role !== "user")) send({ type: "dots.notification", notification });
    });
    const unsubscribeConversation = this.conversation.subscribe(history => {
      if (appId && conversation) send({ type: "dots.history", history });
    });
    socket.on("close", () => { clearTimeout(timer); unsubscribe(); unsubscribeInbox(); unsubscribeConversation(); this.clients.delete(socket); });
    socket.on("error", () => socket.close(1011, "socket error"));
    socket.on("message", (data, binary) => {
      let id: string | number | undefined;
      try {
        if (binary) throw new Error("JSON text frames required");
        const message = object(JSON.parse(data.toString()));
        if (!appId) {
          if (message.type !== "dots.hello" || message.version !== 1
            || typeof message.appId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.appId)
            || !this.options.tokenMatches(typeof message.token === "string" ? message.token : undefined)) {
            socket.close(4401, "unauthorized or incompatible"); return;
          }
          appId = message.appId;
          clearTimeout(timer);
          send({ type: "dots.ready", version: 1, appId, ...this.status });
          return;
        }
        if ((typeof message.id !== "string" && typeof message.id !== "number")
          || String(message.id).length > 128) throw new Error("Request id required");
        id = message.id;
        const params = object(message.params ?? {});
        let result: unknown;
        switch (message.method) {
          case "status": fields(params, []); result = this.status; break;
          case "message/send":
            fields(params, ["requestId", "text"]);
            if (typeof params.requestId !== "string" || typeof params.text !== "string") throw new Error("requestId and text required");
            const input = this.relay.send(appId, params.requestId, params.text);
            this.inbox.publish(`relay-input:${input.id}`, input.text, { role: "user", inputId: input.id, receivedAt: input.createdAt });
            result = input;
            break;
          case "message/read":
            fields(params, ["requestId"]);
            if (typeof params.requestId !== "string") throw new Error("requestId required");
            result = this.relay.read(appId, params.requestId);
            break;
          case "history/sync":
            fields(params, []); result = this.conversation.sync(); conversation = true; break;
          case "notification/sync": {
            fields(params, ["after", "limit", "includeInputs"]);
            if (params.after !== undefined && typeof params.after !== "number"
              || params.limit !== undefined && typeof params.limit !== "number") throw new Error("Numeric notification cursor and limit required");
            if (params.includeInputs !== undefined && typeof params.includeInputs !== "boolean") throw new Error("Boolean includeInputs required");
            includeInputs = params.includeInputs === true;
            const page = this.inbox.sync(params.after as number | undefined, params.limit as number | undefined, includeInputs);
            // Enable live delivery only once pagination catches up. No await
            // between this snapshot and its response: there is no replay/live gap.
            notifications = !page.hasMore;
            result = page;
            break;
          }
          default: throw new Error("Unsupported dots method");
        }
        send({ id, result });
      } catch (error) {
        send(id === undefined ? { type: "dots.error", message: errorText(error) }
          : { id, error: { code: -32000, message: errorText(error) } });
      }
    });
  }

  /** Must run before the bridge's general CORS handler. The worker is local-only. */
  handleHttp(request: IncomingMessage, response: ServerResponse): boolean {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith(WORKER_PATH)) return false;
    response.setHeader("Cache-Control", "no-store");
    const respond = (status: number, body?: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const header = request.headers.authorization;
    const candidate = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
    const expected = Buffer.from(this.workerToken);
    if (!loopback(request.socket.remoteAddress) || request.headers.origin
      || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      respond(403, { error: "Local worker authorization required" }); return true;
    }
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    void (async () => {
      if (path === `${WORKER_PATH}status` && request.method === "GET") { respond(200, this.status); return; }
      if (request.method !== "POST") { respond(405, { error: "POST required" }); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      const bodyTimeout = setTimeout(() => request.destroy(), 5000);
      try {
        for await (const chunk of request) {
          length += Buffer.byteLength(chunk);
          if (length > (path === `${WORKER_PATH}history` ? CONVERSATION_BYTES + 8192 : 128 * 1024)) { respond(413, { error: "Body too large" }); return; }
          chunks.push(Buffer.from(chunk));
        }
      } finally { clearTimeout(bodyTimeout); }
      const params = object(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      if (path === `${WORKER_PATH}next`) {
        fields(params, []);
        const job = await this.relay.next(abort.signal);
        respond(job ? 200 : 204, job ?? undefined);
      } else if (path === `${WORKER_PATH}delivery`) {
        fields(params, ["id"]);
        if (typeof params.id !== "string") throw new Error("id required");
        respond(200, this.relay.deliveryStatus(params.id));
      } else if (path === `${WORKER_PATH}reply`) {
        fields(params, ["id", "lease", "text", "sourceId"]);
        if (typeof params.id !== "string" || typeof params.lease !== "string" || typeof params.text !== "string") {
          throw new Error("id, lease and text required");
        }
        if (params.sourceId !== undefined) {
          if (!validDotSource(params.sourceId)) throw new Error("Invalid sourceId");
          // Validate the lease before remembering the reply as already routed.
          const job = this.relay.deliveryStatus(params.id);
          if (job.status !== "processing" && job.status !== "completed") throw new Error("Inactive delivery");
        }
        this.relay.reply(params.id, params.lease, params.text);
        if (typeof params.sourceId === "string") this.inbox.seen(params.sourceId);
        respond(200, { ok: true });
      } else if (path === `${WORKER_PATH}history`) {
        fields(params, ["items", "latest"]);
        if (typeof params.latest !== "boolean") throw new Error("Boolean latest required");
        respond(200, this.conversation.capture(params.items, params.latest));
      } else if (path === `${WORKER_PATH}notification`) {
        fields(params, ["sourceId", "text", "role", "inputId"]);
        if (typeof params.sourceId !== "string" || typeof params.text !== "string") throw new Error("sourceId and text required");
        if (params.role !== undefined && params.role !== "user" && params.role !== "assistant") throw new Error("Invalid message role");
        if (params.inputId !== undefined && (params.role !== "user" || !validDotSource(params.inputId))) throw new Error("Invalid inputId");
        const sourceId = params.role === "user" && typeof params.inputId === "string" ? `relay-input:${params.inputId}` : params.sourceId;
        const notification = this.inbox.publish(sourceId, params.text, { role: params.role, inputId: params.inputId as string | undefined });
        if (sourceId !== params.sourceId) this.inbox.seen(params.sourceId);
        respond(200, { notification });
      } else if (path === `${WORKER_PATH}abandon`) {
        fields(params, ["id", "lease", "sent", "reason"]);
        if (typeof params.id !== "string" || typeof params.lease !== "string"
          || typeof params.sent !== "boolean" || typeof params.reason !== "string") throw new Error("Invalid abandonment");
        this.relay.abandon(params.id, params.lease, params.sent, params.reason);
        respond(200, { ok: true });
      } else respond(404, { error: "Not found" });
    })().catch(error => respond(409, { error: errorText(error) }));
    return true;
  }

  close(): void {
    this.relay.close();
    for (const socket of this.clients) socket.close(1001, "bridge shutdown");
    this.server.close();
  }
}
