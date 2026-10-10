import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Native Dots audio helpers require macOS");
const dist = resolve(root, "dist"), app = resolve(dist, "DotsVoiceAudioCapture.app");
const cache = resolve(root, ".swift-cache");
mkdirSync(resolve(app, "Contents/MacOS"), { recursive: true }); mkdirSync(cache, { recursive: true });
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`;
const compile = (...args) => execFileSync("/usr/bin/swiftc", ["-O", "-target", target, "-module-cache-path", cache,
  "-file-prefix-map", root + "=dots-voice-bridge", "-debug-prefix-map", root + "=dots-voice-bridge", ...args], { stdio: "inherit" });
compile(resolve(root, "native/audio-device.swift"), "-o", resolve(dist, "dots-audio-device"));
copyFileSync(resolve(root, "native/Info.plist"), resolve(app, "Contents/Info.plist"));
compile("-parse-as-library", resolve(root, "native/bounded-pcm.swift"), resolve(root, "native/audio-capture.swift"), "-o", resolve(app, "Contents/MacOS/DotsVoiceAudioCapture"));
for (const [id, executable] of [["org.dotsbridgekit.dots-audio-device", resolve(dist, "dots-audio-device")], ["org.dotsbridgekit.dots-voice-audio", app]]) {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", id, "--requirements", `=designated => identifier "${id}"`, executable], { stdio: "inherit" });
}
console.log("Built Dots call audio helpers.");
