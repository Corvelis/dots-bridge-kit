import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { WebSocket } from "ws";
import { root, readPairing } from "./configuration.mjs";
let failures = 0;
const report = (ok, label, detail = "") => { console.log((ok ? "OK " : "要確認 ") + label + (detail ? ": " + detail : "")); if (!ok) failures++; };
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
report(nodeMajor === 22 && nodeMinor >= 12 || nodeMajor >= 24, "Node.js");
report(process.platform === "darwin", "macOS（通話・ネイティブホスト）");
let pairing;
try { pairing = readPairing(); report(true, "セットアップ"); } catch { report(false, "セットアップ", "npm run setup を実行"); }
for (const file of ["build/servers/dots-server.js", "build/servers/server.js", "build/servers/text-voice-server.js", "build/extension/manifest.json"]) {
  report(existsSync(resolve(root, file)), file);
}
const speech = resolve(root, "bridge/bin/Dots Speech.app/Contents/MacOS/dots-speech-transcribe");
if (existsSync(speech)) {
  const result = spawnSync(speech, ["status"], { encoding: "utf8", timeout: 15000 });
  try { const status = JSON.parse(result.stdout.trim().split("\n").at(-1)); report(status.ok === true, "音声認識", status.authorization); } catch { report(false, "音声認識", "ヘルパーの実行を確認"); }
} else report(false, "音声認識", "npm run build:native を実行");
if (pairing) {
  try {
    const response = await fetch("http://127.0.0.1:" + pairing.port + "/health", { signal: AbortSignal.timeout(4000) });
    const summary = await response.json();
    report(response.ok && summary.ok === true, "統合ブリッジ");
    for (const kind of ["relay", "voice", "text"]) {
      const health = summary.components?.[kind] || {};
      report(health.ok === true, kind + "機能");
      if (kind === "relay") report(health.dots?.workerOnline === true, "Chrome拡張", "ON表示とDotの通常タブを確認");
      if (kind === "voice") report(health.browserOnline === true, "通話制御の接続");
      if (kind === "text") {
        report(health.asrReady === true, "ASR接続");
      }
    }
  } catch { report(false, "統合ブリッジ", "npm start または npm run services:start とログを確認"); }
  await new Promise(resolveProbe => {
    const socket = new WebSocket("ws://127.0.0.1:" + pairing.port + "/dots/ws");
    let finished = false;
    const finish = ok => { if (finished) return; finished = true; clearTimeout(timer); report(ok, "テキスト認証（発言は送信しません）"); socket.terminate(); resolveProbe(); };
    const timer = setTimeout(() => finish(false), 5000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "dots.hello", version: 1, appId: "setup-doctor", token: pairing.token })));
    socket.on("message", raw => { try { if (JSON.parse(raw.toString()).type === "dots.ready") finish(true); } catch { finish(false); } });
    socket.on("error", () => finish(false)); socket.on("close", () => finish(false));
  });
}
process.exitCode = failures ? 1 : 0;
