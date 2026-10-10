import { randomBytes, randomInt, generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const hostName = "org.dotsbridgekit.chrome";
export function validateDotUrl(value) {
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com" || !/^\/dots\/(?:home|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(url.pathname)
    || url.search || url.hash || url.username || url.password) throw new Error("Paste the full https://chatgpt.com/dots/... URL of your Dot");
  return url.href;
}
export function validateHost(value) {
  const url = new URL("ws://" + value);
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || !url.hostname
    || /[\s/@?#]/.test(value)) throw new Error("Enter a Mac hostname or IP without a scheme, port or path");
  return url.hostname;
}
export function ports(values = {}) {
  const result = { text: Number(values.text ?? 18787), relay: Number(values.relay ?? 18798), voice: Number(values.voice ?? 18799) };
  if (Object.values(result).some(port => !Number.isSafeInteger(port) || port < 1024 || port > 65535)
    || new Set(Object.values(result)).size !== 3) throw new Error("Choose three distinct ports between 1024 and 65535");
  return result;
}
export function publicPort(value = 8799) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a bridge port between 1024 and 65535");
  return port;
}
export function connectionUrls(config) {
  const base = "ws://" + config.phoneHost + ":" + config.port;
  return { voice: base + "/voice/ws", relay: base + "/dots/ws", text: base + "/ws" };
}
export function readPairing(base = root) {
  const file = resolve(base, ".dots-bridge/pairing.json");
  if (!existsSync(file)) throw new Error("Run npm run setup first");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (typeof config.token !== "string" || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error("Invalid pairing configuration");
  const unified = config.port !== undefined;
  config.port = publicPort(config.port);
  // Worker ports stay stable across restarts for the Chrome native host.
  config.ports = ports(unified ? config.ports : undefined);
  if (Object.values(config.ports).includes(config.port)) {
    const used = new Set([config.port]);
    for (const kind of ["relay", "voice", "text"]) {
      let candidate = 18787; while (used.has(candidate)) candidate++;
      used.add(candidate); config.ports[kind] = candidate;
    }
  }
  return config;
}
export function prepare({ dotUrl, phoneHost, requestedPort }, base = root) {
  dotUrl = validateDotUrl(dotUrl); phoneHost = validateHost(phoneHost);
  const state = resolve(base, ".dots-bridge");
  mkdirSync(state, { recursive: true, mode: 0o700 }); chmodSync(state, 0o700);
  const pairingPath = resolve(state, "pairing.json");
  const prior = existsSync(pairingPath) ? readPairing(base) : undefined;
  const port = publicPort(requestedPort ?? prior?.port);
  let selectedPorts = prior?.ports;
  if (!selectedPorts || Object.values(selectedPorts).includes(port)) {
    const used = new Set([port]); selectedPorts = {};
    for (const kind of ["relay", "voice", "text"]) {
      let candidate; do { candidate = randomInt(20000, 60000); } while (used.has(candidate));
      used.add(candidate); selectedPorts[kind] = candidate;
    }
  }
  const pairing = { token: prior?.token ?? randomBytes(32).toString("hex"), phoneHost, port, ports: selectedPorts,
    bridgeUrl: "ws://" + phoneHost + ":" + port + "/ws", networkMode: "custom" };
  writeFileSync(pairingPath, JSON.stringify(pairing, null, 2), { mode: 0o600 });
  const keyPath = resolve(state, "extension-public-key");
  const key = existsSync(keyPath) ? readFileSync(keyPath, "utf8")
    : generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  writeFileSync(keyPath, key, { mode: 0o600 });
  const extensionId = [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15]).map(n => String.fromCharCode(97 + n)).join("");
  const extension = resolve(base, "build/extension");
  cpSync(resolve(base, "browser/dots-bridge"), extension, { recursive: true });
  const manifest = { manifest_version: 3, name: "Dots Bridge Kit", version: "0.2.6", key,
    description: "Connect your existing Dot to your local text and voice bridges.",
    permissions: ["nativeMessaging"], host_permissions: [dotUrl],
    background: { service_worker: "background.js", type: "module" },
    content_scripts: [{ matches: [dotUrl], js: ["watch.js", "call-control.js", "content.js"], run_at: "document_idle" }],
    action: { default_title: "Dots Bridge Kit — open your Dot" } };
  writeFileSync(resolve(extension, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve(extension, "settings.js"), "export const DOT_URL = " + JSON.stringify(dotUrl) + ";\n");
  const launcher = resolve(state, "dots-native-host");
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(launcher, "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(resolve(base, "scripts/dots-native-host.mjs")) + ' "$@"\n', { mode: 0o700 });
  chmodSync(launcher, 0o700);
  const nativeManifest = { name: hostName, description: "Dots Bridge Kit native messaging host",
    path: launcher, type: "stdio", allowed_origins: ["chrome-extension://" + extensionId + "/"] };
  writeFileSync(resolve(state, "dots-native-manifest.json"), JSON.stringify(nativeManifest, null, 2), { mode: 0o600 });
  writeFileSync(resolve(state, "dots-browser-install.json"), JSON.stringify({ extensionId, dotUrl, extension, hostName }), { mode: 0o600 });
  return { extension, extensionId, phoneHost, port };
}
