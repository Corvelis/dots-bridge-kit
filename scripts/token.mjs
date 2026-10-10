import { readPairing } from "./configuration.mjs";
if (!process.stdout.isTTY) throw new Error("Run npm run token in an interactive terminal");
console.log("スマホの接続設定に貼り付けるトークン（公開・共有しないでください）:");
console.log(readPairing().token);
