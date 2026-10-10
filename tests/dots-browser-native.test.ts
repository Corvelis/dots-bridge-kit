import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DotsGateway } from "../bridge/src/dots-gateway";
// @ts-expect-error JavaScript native protocol is also used outside TypeScript.
import { encodeNativeMessage, NativeMessageDecoder } from "../scripts/dots-native-protocol.mjs";

describe("Chrome native message transport", () => {
  it("decodes split headers, multibyte Japanese text and concatenated messages", () => {
    const bytes = Buffer.concat([encodeNativeMessage({ text: "こんにちは🌸" }), encodeNativeMessage({ id: 2 })]);
    const decoder = new NativeMessageDecoder();
    const actual = [];
    for (const byte of bytes) actual.push(...decoder.push(Buffer.from([byte])));
    expect(actual).toEqual([{ text: "こんにちは🌸" }, { id: 2 }]);
    expect(() => new NativeMessageDecoder().push(Buffer.from([255, 255, 255, 255]))).toThrow("length");
  });

  it("relays consecutive inputs without a model and never replays a disconnected delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dots-native-test-"));
    mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, ".dots-bridge"));
    for (const file of ["dots-native-host.mjs", "dots-native-protocol.mjs", "dots-voice-events.mjs"]) copyFileSync(resolve("scripts", file), join(dir, "scripts", file));
    const token = "a".repeat(64), extensionId = "a".repeat(32), dotUrl = "https://chatgpt.com/dots/test";
    const gateway = new DotsGateway({ tokenMatches: t => t === "phone", workerToken: token, historyPath: join(dir, "history.json") });
    let holdHistory = false;
    const server = createServer((req, res) => {
      if (holdHistory && req.url === "/dots/worker/history") { setTimeout(() => gateway.handleHttp(req, res), 500); return; }
      if (!gateway.handleHttp(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((r, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", r); });
    const address = server.address() as { port: number };
    writeFileSync(join(dir, ".dots-bridge/dots-worker.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, token }));
    writeFileSync(join(dir, ".dots-bridge/dots-browser-install.json"), JSON.stringify({ extensionId, dotUrl }));
    const child = spawn(process.execPath, [join(dir, "scripts/dots-native-host.mjs"), `chrome-extension://${extensionId}/`]);
    const decoder = new NativeMessageDecoder(), messages: any[] = [];
    child.stdout.on("data", data => messages.push(...decoder.push(data)));
    let stderr = ""; child.stderr.on("data", data => { stderr += data; });
    const send = (value: unknown) => child.stdin.write(encodeNativeMessage(value));
    const wait = async (predicate: () => boolean) => {
      for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
      throw new Error(`Native timeout: ${stderr}`);
    };
    try {
      send({ type: "ready", url: dotUrl });
      await wait(() => gateway.status.workerOnline);
      send({ type: "notification", sourceId: "idle-source", text: "入力なしの新着です" });
      await wait(() => messages.some(m => m.type === "notification-accepted" && m.sourceId === "idle-source"));
      expect(gateway.inbox.sync().items).toMatchObject([{ text: "入力なしの新着です" }]);
      send({ type: "history", revision: 1, latest: true, items: [{ sourceId: "own-before", role: "user", text: "入力" }, { sourceId: "reply-before", role: "assistant", text: "普通の返答" }] });
      await wait(() => messages.some(m => m.type === "history-accepted" && m.revision === 1));
      expect(gateway.conversation.sync().items.map(row => row.sourceId)).toEqual(["own-before", "reply-before"]);
      // A history-specific error must leave request/call forwarding usable.
      send({ type: "history", revision: 2, latest: true, items: [{ sourceId: "invalid", role: "bad", text: "bad" }] });
      await wait(() => messages.some(m => m.type === "history-error" && m.revision === 2));
      for (const [i, text] of ["こんにちは", "次の会話です"].entries()) {
        const record = gateway.relay.send("phone", `request-${i}`, text);
        await wait(() => messages.some(m => m.type === "job" && m.id === record.id));
        const job = messages.find(m => m.type === "job" && m.id === record.id);
        expect(job).toEqual({ type: "job", id: record.id, text });
        if (i === 0) { holdHistory = true; send({ type: "history", revision: 3, latest: true, items: [{ sourceId: "reply-before", role: "assistant", text: "普通の返答" }, { sourceId: "delayed-history", role: "assistant", text: "履歴の遅延" }] }); }
        send({ type: "reply", id: job.id, sourceId: `reply-${i}`, text: `返答${i}`, browserReplyMs: 10 });
        await wait(() => messages.some(m => m.type === "accepted" && m.id === job.id));
        expect(gateway.relay.read("phone", `request-${i}`).reply).toBe(`返答${i}`);
        if (i === 0) {
          expect(messages.some(m => m.type === "history-accepted" && m.revision === 3)).toBe(false);
          await wait(() => messages.some(m => m.type === "history-accepted" && m.revision === 3)); holdHistory = false;
        }
        send({ type: "notification", sourceId: `reply-${i}`, text: `返答${i}` });
        await wait(() => messages.some(m => m.type === "notification-accepted" && m.sourceId === `reply-${i}`));
        expect(gateway.inbox.sync().items).toHaveLength(1);
      }
      const uncertain = gateway.relay.send("phone", "disconnect", "do not repeat");
      await wait(() => messages.some(m => m.type === "job" && m.id === uncertain.id));
      const exit = once(child, "exit"); child.stdin.end(); await exit;
      expect(gateway.relay.read("phone", "disconnect").status).toBe("uncertain");
      expect(gateway.relay.send("phone", "disconnect", "do not repeat").id).toBe(uncertain.id);
      expect(gateway.status.processing).toBe(false);
      expect(gateway.status.workerOnline).toBe(false);
      expect(JSON.stringify(messages)).not.toContain(token);
    } finally {
      child.kill(); gateway.close(); server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
