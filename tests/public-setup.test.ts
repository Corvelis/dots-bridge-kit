import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepare, validateDotUrl, validateHost, ports, publicPort, connectionUrls, readPairing, root } from "../scripts/configuration.mjs";
import { checkRelease, sourceFiles } from "../scripts/release-check.mjs";
import { chromeIdentity, copyChromeExtension, chromeFiles } from "../scripts/chrome-extension.mjs";
import { connectionFromBaseUrl, loadConnection, saveConnection, validateConnection } from "../dots-phone-g2/src/connection-settings";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "dots-public-setup-")); directories.push(dir); return dir; };
describe("public setup and distribution", () => {
  it("saves private settings separately from a shared extension and preserves pairing when reconfigured", () => {
    const dir = temporary(); cpSync(resolve(root, "browser/dots-bridge"), join(dir, "browser/dots-bridge"), { recursive: true });
    const dotUrl = "https://chatgpt.com/dots/" + randomUUID();
    const first = prepare({ dotUrl, phoneHost: "mac.example.invalid", requestedPort: 9799 }, dir);
    const pairing = JSON.parse(readFileSync(join(dir, ".dots-bridge/pairing.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(first.extension, "manifest.json"), "utf8"));
    expect(pairing.token).toMatch(/^[a-f0-9]{64}$/); expect(statSync(join(dir, ".dots-bridge/pairing.json")).mode & 0o777).toBe(0o600);
    expect(pairing.port).toBe(9799); expect(new Set([pairing.port, ...Object.values(pairing.ports)]).size).toBe(4);
    expect(Object.values(connectionUrls(pairing)).map(url => new URL(url).origin)).toEqual(Array(3).fill("ws://mac.example.invalid:9799"));
    expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*"]);
    expect(manifest.content_scripts[0].matches).toEqual(["https://chatgpt.com/dots/*"]);
    expect(manifest.permissions).toEqual(["nativeMessaging"]);
    expect(first.extensionId).toBe(chromeIdentity(root).extensionId);
    expect(readFileSync(join(first.extension, "settings.js"), "utf8")).not.toContain(pairing.token);
    expect(readFileSync(join(first.extension, "settings.js"), "utf8")).not.toContain(dotUrl);
    const host = JSON.parse(readFileSync(join(dir, ".dots-bridge/dots-native-manifest.json"), "utf8"));
    expect(host.allowed_origins).toEqual(["chrome-extension://" + first.extensionId + "/"]);
    const second = prepare({ dotUrl, phoneHost: "new-mac.example.invalid" }, dir);
    expect(second.extensionId).toBe(first.extensionId); expect(JSON.parse(readFileSync(join(dir, ".dots-bridge/pairing.json"), "utf8")).token).toBe(pairing.token);
    expect(readPairing(dir).ports).toEqual(pairing.ports);
    const other = temporary(); cpSync(resolve(root, "browser/dots-bridge"), join(other, "browser/dots-bridge"), { recursive: true });
    expect(prepare({ dotUrl: "https://chatgpt.com/dots/home", phoneHost: "other.example.invalid" }, other).extensionId).toBe(first.extensionId);
  });
  it("keeps only the valid prior extension authorized during an upgrade", () => {
    const dir = temporary(); cpSync(resolve(root, "browser/dots-bridge"), join(dir, "browser/dots-bridge"), { recursive: true });
    mkdirSync(join(dir, ".dots-bridge"));
    const legacyId = "a".repeat(32);
    writeFileSync(join(dir, ".dots-bridge/dots-browser-install.json"), JSON.stringify({ extensionId: legacyId }));
    const options = { dotUrl: "https://chatgpt.com/dots/home", phoneHost: "mac.example.invalid" };
    const shared = prepare(options, dir);
    const expected = ["chrome-extension://" + shared.extensionId + "/", "chrome-extension://" + legacyId + "/"];
    expect(JSON.parse(readFileSync(join(dir, ".dots-bridge/dots-native-manifest.json"), "utf8")).allowed_origins).toEqual(expected);
    prepare(options, dir);
    expect(JSON.parse(readFileSync(join(dir, ".dots-bridge/dots-native-manifest.json"), "utf8")).allowed_origins).toEqual(expected);
    writeFileSync(join(dir, ".dots-bridge/dots-browser-install.json"), JSON.stringify({ extensionId: "*" }));
    prepare(options, dir);
    expect(JSON.parse(readFileSync(join(dir, ".dots-bridge/dots-native-manifest.json"), "utf8")).allowed_origins).toEqual(expected.slice(0, 1));
  });
  it("copies only reviewed unconfigured extension files and replaces stale generated files", () => {
    const dir = temporary(), output = join(dir, "extension");
    mkdirSync(output); writeFileSync(join(output, "private-settings.json"), "local-only");
    copyChromeExtension(root, output);
    for (const file of chromeFiles) expect(readFileSync(join(output, file))).toEqual(readFileSync(resolve(root, "browser/dots-bridge", file)));
    expect(() => readFileSync(join(output, "private-settings.json"))).toThrow();
  });
  it("accepts the canonical home URL with exact scope", () => {
    expect(validateDotUrl("https://chatgpt.com/dots/home")).toBe("https://chatgpt.com/dots/home");
    for (const url of ["https://chatgpt.com/dots/home/other", "https://chatgpt.com/dots/home?other=true", "https://chatgpt.com/dots/home#other", "https://chatgpt.com/dots", "https://chatgpt.com/dots/other"]) expect(() => validateDotUrl(url)).toThrow();
  });
  it("rejects invalid Dot URLs, host strings and port collisions", () => {
    for (const url of ["https://other.example/dots/" + randomUUID(), "https://chatgpt.com/dots/*", "https://chatgpt.com/dots/" + randomUUID() + "?token=test"]) expect(() => validateDotUrl(url)).toThrow();
    for (const host of ["ws://mac.example", "mac.example:8799", ["user", "mac.example"].join("@"), "mac.example/path"]) expect(() => validateHost(host)).toThrow();
    expect(validateHost("mac.example.invalid")).toBe("mac.example.invalid"); expect(() => ports({ relay: 18787 })).toThrow(); expect(() => publicPort(65536)).toThrow();
  });
  it("keeps runtime connection tokens in phone storage and validates endpoint paths", () => {
    let saved = ""; const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    const settings = { voiceUrl: "ws://mac.example.invalid:8799/voice/ws", inboxUrl: "ws://mac.example.invalid:8798/dots/ws", textVoiceUrl: "ws://mac.example.invalid:8787/ws", token: randomBytes(32).toString("hex") };
    saveConnection(settings, storage); expect(loadConnection({ ...settings, token: "" }, storage)).toEqual(settings);
    expect(() => validateConnection({ ...settings, voiceUrl: "ws://mac.example.invalid:8799/wrong" })).toThrow();
    expect(() => validateConnection({ ...settings, token: "short" })).toThrow();
    saved = "invalid"; expect(loadConnection({ ...settings, token: "" }, storage).token).toBe("");
    const unified = connectionFromBaseUrl("http://mac.example.invalid:9799", settings.token);
    expect(new Set([unified.voiceUrl, unified.inboxUrl, unified.textVoiceUrl].map(url => new URL(url).origin)).size).toBe(1);
    for (const invalid of ["ws://mac.example.invalid:9799/ws", "ws://" + ["user", "mac.example.invalid"].join("@"), "ws://mac.example.invalid?token=x"]) expect(() => connectionFromBaseUrl(invalid, settings.token)).toThrow();
  });
  it("migrates three-port pairing without changing the user's credential", () => {
    const dir = temporary(), token = randomBytes(32).toString("hex"); mkdirSync(join(dir, ".dots-bridge"));
    writeFileSync(join(dir, ".dots-bridge/pairing.json"), JSON.stringify({ token, phoneHost: "mac.example.invalid", ports: { text: 8787, relay: 8798, voice: 8799 } }));
    const config = readPairing(dir);
    expect(config.token).toBe(token); expect(config.port).toBe(8799); expect(Object.values(config.ports)).not.toContain(config.port);
    expect(readPairing(dir).ports).toEqual(config.ports);
  });
  it("excludes configured state, logs, packages and builds; rejects credentials in selected source", () => {
    const dir = temporary(); writeFileSync(join(dir, "README.md"), "Public source"); mkdirSync(join(dir, ".dots-bridge"));
    writeFileSync(join(dir, ".dots-bridge/pairing.json"), randomBytes(32).toString("hex")); writeFileSync(join(dir, ".env"), "private setting");
    mkdirSync(join(dir, "build")); writeFileSync(join(dir, "build/private.js"), "generated config"); writeFileSync(join(dir, "personal.ehpk"), "private package");
    const inventory = (files: string[]) => writeFileSync(join(dir, "release-files.json"), JSON.stringify({ version: 1, files: ["release-files.json", ...files].sort() }));
    inventory(["README.md"]);
    expect(sourceFiles(dir)).toEqual(["README.md", "release-files.json"]); expect(checkRelease(dir).ok).toBe(true);
    writeFileSync(join(dir, "leak.ts"), randomBytes(32).toString("hex")); inventory(["README.md", "leak.ts"]);
    expect(() => checkRelease(dir)).toThrow("credential");
  });
});
