import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { root, readPairing, connectionUrls } from "./configuration.mjs";
import { personalManifest, assertNoToken, preparePrebuiltG2 } from "./g2-package.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--package-id")) throw new Error("Use --package-id <your unique ID>");
const pairing = readPairing(), urls = connectionUrls(pairing);
const manifest = personalManifest(JSON.parse(readFileSync(resolve(root, "app.dots-phone-g2.json"), "utf8")), urls, args[1]);
const env = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith("VITE_DOTS_")) delete env[name];
Object.assign(env, { VITE_DOTS_PHONE_URL: urls.voice, VITE_DOTS_NOTIFICATION_URL: urls.relay, VITE_DOTS_TEXT_VOICE_URL: urls.text });
mkdirSync(resolve(root, "build"), { recursive: true });
const temporary = mkdtempSync(resolve(root, "build/.g2-packing-"));
try {
  const manifestPath = resolve(temporary, "app.json"), output = resolve(temporary, "app.ehpk");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  let project = resolve(root, "dist-dots-phone-g2");
  if (existsSync(resolve(root, "release-runtime.json"))) {
    project = resolve(temporary, "web");
    preparePrebuiltG2(resolve(root, "g2-web"), project, new URL(urls.voice).origin, pairing.token);
  } else {
    for (const [command, commandArgs] of [["tsc", ["--noEmit"]], ["vite", ["build", "--config", "vite.dots-phone-g2.config.ts"]]]) {
      const result = spawnSync(resolve(root, "node_modules/.bin", command), commandArgs, { cwd: root, env, stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error("G2 build failed");
    }
  }
  assertNoToken(project, pairing.token);
  if (readFileSync(manifestPath).includes(pairing.token)) throw new Error("Credential in G2 manifest");
  const result = spawnSync(resolve(root, "node_modules/.bin/evenhub"),
    ["pack", manifestPath, project, "-o", output], { cwd: root, env, stdio: "inherit" });
  if (result.error || result.status !== 0 || !existsSync(output) || readFileSync(output).subarray(0, 4).toString() !== "EHPK")
    throw new Error("G2 packaging failed");
  renameSync(output, resolve(root, "build/dots-phone-g2-" + manifest.version + ".ehpk"));
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log("G2パッケージをbuild/へ作成しました。トークンは含みません。スマホで接続トークンを入力してください。");
