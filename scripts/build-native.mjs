import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./configuration.mjs";
if (process.platform !== "darwin") throw new Error("Native call audio and Apple ASR require macOS");
process.chdir(root);
execFileSync(process.execPath, ["dots-voice-bridge/scripts/build-native.mjs"], { stdio: "inherit" });
const app = resolve(root, "bridge/bin/Dots Speech.app"), cache = resolve(root, "bridge/.build");
mkdirSync(resolve(app, "Contents/MacOS"), { recursive: true }); mkdirSync(cache, { recursive: true });
copyFileSync(resolve(root, "bridge/native/dots-speech.plist"), resolve(app, "Contents/Info.plist"));
execFileSync("/usr/bin/xcrun", ["swiftc", "bridge/native/dots-speech.swift", "-O",
  "-file-prefix-map", root + "=.", "-debug-prefix-map", root + "=.",
  "-target", (process.arch === "arm64" ? "arm64" : "x86_64") + "-apple-macosx14.0", "-module-cache-path", cache,
  "-framework", "Speech", "-framework", "AVFoundation", "-o", resolve(app, "Contents/MacOS/dots-speech-transcribe")], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "org.dotsbridgekit.speech", app], { stdio: "inherit" });
console.log("通話音声と音声認識のヘルパーをビルドしました。OSの音声アクセス許可は導入手順で設定してください。");
