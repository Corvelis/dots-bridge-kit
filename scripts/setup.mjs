import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prepare, root } from "./configuration.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1];
let dotUrl = args.includes("--dot-url") ? get("--dot-url") : undefined;
let phoneHost = args.includes("--host") ? get("--host") : undefined;
if (!dotUrl || !phoneHost) {
  if (!stdin.isTTY) throw new Error("Use --dot-url <your Dot URL> --host <your Mac hostname or IP>");
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    dotUrl ||= await prompt.question("あなたのDotのURL: ");
    phoneHost ||= await prompt.question("スマホから接続するMacのホスト名/IP: ");
  } finally { prompt.close(); }
}
if (args.some(arg => /^--(text|relay|voice)-port$/.test(arg))) throw new Error("Use --port for the single bridge endpoint");
const result = prepare({ dotUrl, phoneHost, requestedPort: args.includes("--port") ? get("--port") : undefined });
console.log("設定を保存しました。トークンは出力していません。");
console.log("Chrome拡張フォルダ: " + result.extension);
console.log("ブリッジ接続先: ws://" + result.phoneHost + ":" + result.port);
console.log(existsSync(resolve(root, "release-runtime.json"))
  ? "次: npm run chrome:install → Chrome拡張を読み込む → npm run services:start"
  : "次: npm run chrome:install → npm run build → npm run build:native → npm run services:start");
