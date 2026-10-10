import { createServer, request as httpRequest } from "node:http";

const page = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dots Bridge Kit</title><style>body{font:18px system-ui;max-width:36em;margin:10vh auto;padding:1em;line-height:1.7}a{display:block;margin:1em 0}</style><h1>Dots Bridge Kit</h1><p>自分のDotに接続する確認画面です。Macで生成したペアリングトークンを各画面に入力してください。</p><a href="/voice">通話：開始・終了・音声の送受信</a><a href="/dots">テキスト：送信・返答・通知</a><p>Even G2ではEven AppからDots Phone G2を開いてください。</p></html>`;
const routes = { "/dots": "relay", "/voice": "voice", "/client.js": "voice", "/mic-worklet.js": "voice" };
const upgrades = { "/dots/ws": "relay", "/voice/ws": "voice", "/ws": "text" };

/** One public endpoint; private worker and native-host routes are never forwarded. */
export function createGateway(ports) {
  const sockets = new Set();
  let ready = false;
  const track = socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }).end(); return; }
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (path === "/health") {
      const components = {};
      await Promise.all(Object.entries(ports).map(async ([kind, port]) => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
          components[kind] = response.ok ? await response.json() : { ok: false };
        } catch { components[kind] = { ok: false }; }
      }));
      const ok = ready && Object.values(components).every(component => component.ok === true);
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ ok, version: "0.1.0", components }));
      return;
    }
    if (path === "/") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page); return;
    }
    const kind = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (!kind) { res.writeHead(404).end(); return; }
    if (!ready) { res.writeHead(503).end("Bridge is starting"); return; }
    const upstream = httpRequest({ hostname: "127.0.0.1", port: ports[kind], path: req.url, method: "GET" }, response => {
      res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
      response.on("error", () => res.destroy());
    });
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end("Bridge unavailable"); else res.destroy(); });
    res.once("close", () => upstream.destroy()); upstream.end();
  });
  server.on("connection", track);
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    const kind = Object.hasOwn(upgrades, path) ? upgrades[path] : undefined;
    if (!kind || !ready) { socket.end(`HTTP/1.1 ${kind ? "503 Service Unavailable" : "404 Not Found"}\r\nConnection: close\r\n\r\n`); return; }
    const upstream = httpRequest({ hostname: "127.0.0.1", port: ports[kind], path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${ports[kind]}` } });
    const timeout = setTimeout(() => upstream.destroy(), 5000);
    const failed = () => { clearTimeout(timeout); if (!socket.destroyed) socket.destroy(); };
    upstream.on("error", failed); socket.once("close", () => { clearTimeout(timeout); upstream.destroy(); });
    socket.on("error", () => upstream.destroy());
    upstream.on("response", response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode || 502} Rejected\r\nConnection: close\r\n\r\n`); });
    upstream.once("upgrade", (response, peer, peerHead) => {
      clearTimeout(timeout);
      if (socket.destroyed) { peer.destroy(); return; }
      track(peer);
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`
        + response.rawHeaders.reduce((text, value, i, all) => i % 2 ? text : text + value + ": " + all[i + 1] + "\r\n", "") + "\r\n");
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      // Pipe TCP bytes directly: frame boundaries and backpressure are preserved,
      // with no decode/re-encode, batching timer, or extra audio queue.
      socket.pipe(peer); peer.pipe(socket);
      peer.on("error", () => socket.destroy()); socket.on("error", () => peer.destroy());
      peer.once("close", () => socket.destroy()); socket.once("close", () => peer.destroy());
    });
    upstream.end();
  });
  return { server, setReady(value) { ready = value; },
    close() { ready = false; server.close(); },
    destroyConnections() { for (const socket of sockets) socket.destroy(); } };
}
