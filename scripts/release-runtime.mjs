import { cpSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { root } from "./configuration.mjs";
import { checkRelease, sourceFiles } from "./release-check.mjs";
import { artifactFiles, checkArtifactDirectory, digest } from "./release-artifacts.mjs";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("Build Mac releases on the matching Mac architecture");
checkRelease();
// Release builds use only neutral defaults, never the maintainer's Vite settings.
const env = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith("VITE_")) delete env[name];
Object.assign(env, { VITE_DOTS_PHONE_URL: "ws://127.0.0.1:8799/voice/ws", VITE_DOTS_NOTIFICATION_URL: "ws://127.0.0.1:8799/dots/ws", VITE_DOTS_TEXT_VOICE_URL: "ws://127.0.0.1:8799/ws" });
for (const command of ["build", "build:native"]) execFileSync("npm", ["run", command], { cwd: root, env, stdio: "inherit" });
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const name = "dots-bridge-kit-macos-" + process.arch + "-v" + pkg.version;
const output = resolve(root, "build/releases"); mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(resolve(output, ".runtime-")), stage = resolve(temporary, name);
const runtimeScripts = ["configuration", "setup", "chrome-extension", "chrome-host", "dots-native-host", "dots-native-protocol", "dots-voice-events", "dots-voice-native", "doctor", "token", "start", "run", "services", "supervisor", "gateway", "pack-g2", "g2-package"];
try {
  const sources = sourceFiles().filter(file => file === "README.md" || file === "LICENSE" || file === "THIRD_PARTY_NOTICES.md" || file === ".env.example"
    || file === "app.dots-phone-g2.json" || file === "dots-voice-bridge/README.md" || file.startsWith("docs/") || file.startsWith("browser/dots-bridge/") || file.startsWith("dots-voice-bridge/public/")
    || runtimeScripts.some(script => file === "scripts/" + script + ".mjs"));
  for (const file of sources) {
    mkdirSync(dirname(resolve(stage, file)), { recursive: true }); cpSync(resolve(root, file), resolve(stage, file));
  }
  const apps = ["bridge/bin/Dots Speech.app", "dots-voice-bridge/dist/DotsVoiceAudioCapture.app"];
  const executables = [apps[0] + "/Contents/MacOS/dots-speech-transcribe", apps[1] + "/Contents/MacOS/DotsVoiceAudioCapture", "dots-voice-bridge/dist/dots-audio-device"];
  for (const binary of executables) {
    const arch = execFileSync("/usr/bin/lipo", ["-archs", resolve(root, binary)], { encoding: "utf8" }).trim();
    if (arch !== (process.arch === "arm64" ? "arm64" : "x86_64")) throw new Error("Native helper architecture mismatch");
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", resolve(root, binary)], { stdio: "ignore" });
  }
  const nativeFiles = [...executables, ...apps.flatMap(app => [app + "/Contents/Info.plist", app + "/Contents/_CodeSignature/CodeResources"])];
  for (const file of [...nativeFiles, ...["dots-server", "text-voice-server", "server"].map(name => "build/servers/" + name + ".js")]) {
    mkdirSync(dirname(resolve(stage, file)), { recursive: true }); cpSync(resolve(root, file), resolve(stage, file));
  }
  const html = readFileSync(resolve(root, "dist-dots-phone-g2/index.html"), "utf8");
  const assets = [...html.matchAll(/(?:src|href)="\.\/(assets\/index-[A-Za-z0-9_-]+\.(?:js|css))"/g)].map(match => match[1]);
  const webFiles = ["index.html", ...assets];
  if (assets.length !== 2 || !assets.some(file => file.endsWith(".js")) || !assets.some(file => file.endsWith(".css"))
    || JSON.stringify(artifactFiles(resolve(root, "dist-dots-phone-g2"))) !== JSON.stringify([...webFiles].sort())) throw new Error("Unexpected G2 build inventory");
  for (const file of webFiles) {
    mkdirSync(dirname(resolve(stage, "g2-web", file)), { recursive: true }); cpSync(resolve(root, "dist-dots-phone-g2", file), resolve(stage, "g2-web", file));
  }
  pkg.scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([key]) => !/^(?:build|dev|test|typecheck|release)(?::|$)/.test(key)));
  writeFileSync(resolve(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  cpSync(resolve(root, "package-lock.json"), resolve(stage, "package-lock.json"));
  const files = artifactFiles(stage);
  const manifest = { format: 1, version: pkg.version, platform: "darwin", arch: process.arch, macos: "26.0",
    files: Object.fromEntries(files.map(file => [file, digest(readFileSync(resolve(stage, file)))])) };
  writeFileSync(resolve(stage, "release-runtime.json"), JSON.stringify(manifest, null, 2) + "\n");
  const checked = checkArtifactDirectory(stage, [...files, "release-runtime.json"]);
  execFileSync("zip", ["-q", resolve(temporary, "runtime.zip"), "-@"], { cwd: temporary,
    input: [...files, "release-runtime.json"].sort().map(file => name + "/" + file).join("\n") + "\n" });
  renameSync(resolve(temporary, "runtime.zip"), resolve(output, name + ".zip"));
  console.log(JSON.stringify({ artifact: "build/releases/" + name + ".zip", ...checked }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
