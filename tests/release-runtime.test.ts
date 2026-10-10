import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Node release scripts are also imported by tests.
import { checkArtifactDirectory, checkRuntimeManifest, digest } from "../scripts/release-artifacts.mjs";
// @ts-expect-error Packaging is a standalone Node script.
import { personalManifest, preparePrebuiltG2 } from "../scripts/g2-package.mjs";
import { connectionEndpoints } from "../dots-phone-g2/src/connection-settings";
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "dots-runtime-test-")); directories.push(dir); return dir; }

describe("compiled release privacy", () => {
  it("checks compiled native strings for credentials, private paths and UTF-16 identity", () => {
    const dir = fixture(), file = join(dir, "helper");
    for (const value of [randomBytes(32).toString("hex"), ["", "Users", "ExampleUser", "source.swift"].join("/")]) {
      writeFileSync(file, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(value), Buffer.from([0])]));
      expect(() => checkArtifactDirectory(dir, ["helper"])).toThrow();
    }
    const marker = ["PRIVATE", "IDENTITY"].join("_");
    writeFileSync(file, Buffer.from(marker, "utf16le"));
    expect(() => checkArtifactDirectory(dir, ["helper"], { forbiddenStrings: [marker] })).toThrow("private identifier");
  });
  it("does not treat Swift compiler symbols as credentials, but still checks literal constants", () => {
    const dir = fixture(), file = join(dir, "helper"), value = "Aa1".repeat(14) + "_";
    writeFileSync(file, Buffer.from("\0_$s" + value + "\0_symbolic " + value + "\0"));
    expect(checkArtifactDirectory(dir, ["helper"]).ok).toBe(true);
    writeFileSync(file, Buffer.from("\0" + value + "\0"));
    expect(() => checkArtifactDirectory(dir, ["helper"])).toThrow("literal credential");
  });
  it("rejects an extra artifact, configured state and symlink", () => {
    const dir = fixture(); writeFileSync(join(dir, "helper"), "public");
    expect(() => checkArtifactDirectory(dir, [])).toThrow("inventory");
    mkdirSync(join(dir, ".dots-bridge")); writeFileSync(join(dir, ".dots-bridge/pairing.json"), "state");
    expect(() => checkArtifactDirectory(dir, ["helper", ".dots-bridge/pairing.json"])).toThrow("filename");
    rmSync(join(dir, ".dots-bridge"), { recursive: true }); symlinkSync(join(dir, "helper"), join(dir, "alias"));
    expect(() => checkArtifactDirectory(dir, ["helper", "alias"])).toThrow("symlink");
  });
  it("verifies every runtime file hash and rejects extra manifest fields", () => {
    const dir = fixture(), bytes = Buffer.from("Public runtime"); writeFileSync(join(dir, "helper"), bytes);
    const manifest = { format: 1, version: "0.1.0", platform: "darwin", arch: "arm64", macos: "26.0", files: { helper: digest(bytes) } };
    const save = (value: unknown) => writeFileSync(join(dir, "release-runtime.json"), JSON.stringify(value));
    save(manifest); expect(checkRuntimeManifest(dir).arch).toBe("arm64");
    expect(checkArtifactDirectory(dir, ["helper", "release-runtime.json"]).ok).toBe(true);
    writeFileSync(join(dir, "helper"), "changed"); expect(() => checkRuntimeManifest(dir)).toThrow("checksum");
    writeFileSync(join(dir, "helper"), bytes); save({ ...manifest, token: randomBytes(32).toString("hex") });
    expect(() => checkRuntimeManifest(dir)).toThrow("Invalid runtime manifest");
    save(manifest); writeFileSync(join(dir, "notes.md"), "unlisted"); expect(() => checkRuntimeManifest(dir)).toThrow("inventory");
  });
});
describe("G2 packaging without compilers", () => {
  const urls = { voice: "ws://mac.example.invalid:9799/voice/ws", relay: "ws://mac.example.invalid:9799/dots/ws", text: "ws://mac.example.invalid:9799/ws" };
  it("restricts permissions to configured origins and validates the user's package ID", () => {
    const template = { package_id: "org.example.initial", permissions: [{ name: "network", whitelist: [] }] };
    const manifest = personalManifest(template, urls, "org.example.dotsphone");
    expect(manifest.permissions[0].whitelist).toEqual(["ws://mac.example.invalid:9799", "http://mac.example.invalid:9799"]);
    expect(template.package_id).toBe("org.example.initial"); expect(template.permissions[0].whitelist).toEqual([]);
    for (const id of ["MyApp", "org.bad-id", "../app", "org.2app"]) expect(() => personalManifest(template, urls, id)).toThrow();
  });
  it("personalizes only a copied prebuilt entrypoint and keeps the token out", () => {
    const dir = fixture(), input = join(dir, "web"), output = join(dir, "paired"); mkdirSync(input);
    const html = '<html><head><script src="./app.js"></script></head><body></body></html>';
    writeFileSync(join(input, "index.html"), html); writeFileSync(join(input, "app.js"), "/* compiled UI */");
    const token = randomBytes(32).toString("hex");
    preparePrebuiltG2(input, output, "ws://mac.example.invalid:9799", token);
    const packed = readFileSync(join(output, "index.html"), "utf8");
    expect(packed).toContain('name="dots-bridge-base-url" content="ws://mac.example.invalid:9799"');
    expect(packed).not.toContain(token); expect(readFileSync(join(input, "index.html"), "utf8")).toBe(html);
    expect(readFileSync(join(output, "app.js"), "utf8")).toBe("/* compiled UI */");
    const endpoints = connectionEndpoints("ws://mac.example.invalid:9799");
    expect(endpoints.voiceUrl).toBe(urls.voice); expect(endpoints.textVoiceUrl).toBe(urls.text);
  });
  it("refuses credentials and symlinks in the prebuilt input", () => {
    const dir = fixture(), input = join(dir, "web"); mkdirSync(input);
    const token = randomBytes(32).toString("hex"); writeFileSync(join(input, "index.html"), "<head>" + token + "</head>");
    expect(() => preparePrebuiltG2(input, join(dir, "out"), urls.voice, token)).toThrow("Credential");
    writeFileSync(join(input, "index.html"), "<head></head>"); symlinkSync(join(input, "index.html"), join(input, "alias"));
    expect(() => preparePrebuiltG2(input, join(dir, "out"), urls.voice, token)).toThrow("symlink");
  });
});
