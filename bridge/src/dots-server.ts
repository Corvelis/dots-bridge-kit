import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { DOTS_WS_PATH, DotsGateway, dotsWorkerConfig } from "./dots-gateway";

// Local worker managed by the unified bridge.
const pairingPath = resolve(".dots-bridge/pairing.json");
const pairing = existsSync(pairingPath) ? JSON.parse(readFileSync(pairingPath, "utf8")) : {};
const token = process.env.DOTS_BRIDGE_TOKEN || pairing.token;
if (typeof token !== "string" || !token) throw new Error("Pairing token required; run pairing setup first");
const port = Number(process.env.DOTS_RELAY_PORT || 18798);
const host = process.env.DOTS_RELAY_HOST || "127.0.0.1";
const gateway = new DotsGateway({
  tokenMatches(candidate) {
    const actual = Buffer.from(candidate ?? "");
    const expected = Buffer.from(token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  },
  workerToken: () => dotsWorkerConfig(resolve(".dots-bridge/dots-worker.json"), port),
  historyPath: resolve(".dots-bridge/dots-messages.json"),
});
const server = createServer((request, response) => {
  if (gateway.handleHttp(request, response)) return;
  response.setHeader("Cache-Control", "no-store");
  if ((request.url === "/" || request.url === "/dots") && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff" });
    response.end(readFileSync(resolve("browser/dots-bridge/phone.html")));
  } else if (request.url === "/health" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, dots: gateway.status }));
  } else response.writeHead(404).end();
});
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url ?? "/", "http://localhost").pathname === DOTS_WS_PATH) {
    gateway.handleUpgrade(request, socket, head);
  } else { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); }
});
server.on("error", error => { console.error(error.message); gateway.close(); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log("Dots text/notification worker ready");
  process.send?.({ type: "ready", kind: "relay", port });
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  gateway.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
});
