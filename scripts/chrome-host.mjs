import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { root, hostName } from "./configuration.mjs";
if (process.platform !== "darwin") throw new Error("This native host installer supports macOS Chrome");
const source = resolve(root, ".dots-bridge/dots-native-manifest.json");
if (!existsSync(source)) throw new Error("Run npm run setup first");
const manifest = JSON.parse(readFileSync(source, "utf8"));
const directory = resolve(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
const target = resolve(directory, hostName + ".json");
if (existsSync(target) && JSON.parse(readFileSync(target, "utf8")).path !== manifest.path) {
  throw new Error("Another installation owns this native host. Uninstall it from its own folder first.");
}
if (process.argv[2] === "install") {
  mkdirSync(directory, { recursive: true }); writeFileSync(target, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log("Chromeのネイティブホストを登録しました。build/extension をChromeに読み込んでください。");
} else if (process.argv[2] === "uninstall") {
  if (existsSync(target)) unlinkSync(target);
  console.log("このフォルダのネイティブホスト登録を解除しました。Chrome側の拡張も削除してください。");
} else throw new Error("Use install or uninstall");
