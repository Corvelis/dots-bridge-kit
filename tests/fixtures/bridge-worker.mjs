import { createServer } from "node:http";
const kind = process.argv[2], port = Number(process.env[`DOTS_${kind.toUpperCase()}_PORT`]);
if (process.env.TEST_FAIL_WORKER === kind) process.exit(2);
const server = createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, kind })));
server.listen(port, process.env[`DOTS_${kind.toUpperCase()}_HOST`], () => process.send({ type: "ready", kind, port }));
process.on("SIGTERM", () => {
  process.send({ type: "stopping", kind });
  setTimeout(() => server.close(() => process.exit(0)), kind === "voice" ? 100 : 0);
});
