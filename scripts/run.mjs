import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { root, readPairing } from "./configuration.mjs";
process.chdir(root);
// An unexpected supervisor exit must not leave a call/audio worker running.
if (process.send) process.on("disconnect", () => process.kill(process.pid, "SIGTERM"));
if (existsSync(".env")) loadEnvFile(".env");
const config = readPairing();
process.env.DOTS_RELAY_PORT ??= String(config.ports.relay);
process.env.DOTS_VOICE_PORT ??= String(config.ports.voice);
process.env.DOTS_TEXT_PORT ??= String(config.ports.text);
const entry = { relay: "dots-server.js", voice: "server.js", text: "text-voice-server.js" }[process.argv[2]];
if (!entry) throw new Error("Choose relay, voice or text");
const file = resolve(root, "build/servers", entry);
if (!existsSync(file)) throw new Error("Run npm run build:bridge first");
await import(pathToFileURL(file).href);
