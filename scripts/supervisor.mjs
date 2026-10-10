import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "./gateway.mjs";

export async function startBridge({ root, config, host = "0.0.0.0", spawnWorker } ) {
  const entries = { relay: "dots-server.js", voice: "server.js", text: "text-voice-server.js" };
  if (!spawnWorker) for (const entry of Object.values(entries)) {
    if (!existsSync(resolve(root, "build/servers", entry))) throw new Error("Run npm run build first");
  }
  const gateway = createGateway(config.ports), workers = new Map();
  let stopping, failure;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  function stop() {
    if (stopping) return stopping;
    gateway.close();
    stopping = (async () => {
      // Keep native control and text relay alive until call teardown has finished.
      for (const kinds of [["voice"], ["text", "relay"]]) {
        await Promise.all(kinds.map(async kind => {
          const worker = workers.get(kind);
          if (!worker?.pid || worker.exitCode !== null || worker.signalCode !== null) return;
          await new Promise(resolve => {
            const timer = setTimeout(() => worker.kill("SIGKILL"), kind === "voice" ? 35000 : 5000);
            worker.once("exit", () => { clearTimeout(timer); resolve(); }); worker.kill("SIGTERM");
          });
        }));
      }
      gateway.destroyConnections(); resolveDone({ error: failure });
    })();
    return stopping;
  }
  const signals = ["SIGINT", "SIGTERM"];
  const onSignal = () => { void stop(); };
  for (const signal of signals) process.on(signal, onSignal);
  done.finally(() => { for (const signal of signals) process.off(signal, onSignal); });
  function start(kind) {
    if (stopping) throw new Error("Bridge startup cancelled");
    const env = { ...process.env };
    if (typeof config.token === "string") env.DOTS_BRIDGE_TOKEN = config.token;
    for (const name of ["relay", "voice", "text"]) {
      env[`DOTS_${name.toUpperCase()}_PORT`] = String(config.ports[name]);
      env[`DOTS_${name.toUpperCase()}_HOST`] = "127.0.0.1";
    }
    const worker = spawnWorker ? spawnWorker(kind, env) : spawn(process.execPath,
      [resolve(root, "scripts/run.mjs"), kind], { cwd: root, env, detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    workers.set(kind, worker);
    return new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(kind + " worker startup timed out")), 20000);
      worker.on("error", error => { clearTimeout(timer); reject(error); failure ??= new Error(kind + " worker failed"); void stop(); });
      worker.once("exit", () => {
        clearTimeout(timer); reject(new Error(kind + " worker exited before ready"));
        if (!stopping) { failure ??= new Error(kind + " worker stopped; restart the bridge and check call status"); void stop(); }
      });
      worker.on("message", message => {
        if (message?.type === "ready" && message.kind === kind && message.port === config.ports[kind]) {
          clearTimeout(timer); resolveReady();
        }
      });
    });
  }
  try {
    await new Promise((resolveListen, reject) => {
      gateway.server.once("error", reject); gateway.server.listen(config.port, host, resolveListen);
    });
    gateway.server.on("error", error => { failure ??= error; void stop(); });
    await start("relay");
    await Promise.all([start("voice"), start("text")]);
    if (stopping) throw new Error("Bridge startup cancelled");
    gateway.setReady(true);
    return { gateway, stop, done };
  } catch (error) { failure ??= error; await stop(); throw error; }
}
