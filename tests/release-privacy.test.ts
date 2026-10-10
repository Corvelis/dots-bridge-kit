import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error Release scripts also run directly in Node.
import { checkRelease, sourceFiles, inspectReleaseImage } from "../scripts/release-check.mjs";
// @ts-expect-error Shared setup paths are supplied by a JavaScript module.
import { root } from "../scripts/configuration.mjs";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(content = "Public source") {
  const dir = mkdtempSync(join(tmpdir(), "dots-release-test-")); directories.push(dir);
  writeFileSync(join(dir, "README.md"), content);
  inventory(dir, ["README.md"]); return dir;
}
function inventory(dir: string, files: string[]) {
  writeFileSync(join(dir, "release-files.json"), JSON.stringify({ version: 1, files: [...files, "release-files.json"].sort() }));
}

describe("release privacy boundary", () => {
  it("rejects unknown files without adding them to the archive inventory or printing their content", () => {
    const dir = fixture(), privateValue = randomBytes(32).toString("hex");
    writeFileSync(join(dir, "notes.md"), privateValue);
    expect(sourceFiles(dir)).toEqual(["README.md", "release-files.json"]);
    let error = ""; try { checkRelease(dir); } catch (value) { error = String(value); }
    expect(error).toContain("unlisted source"); expect(error).not.toContain(privateValue);
  });
  it("requires an explicit inventory and rejects traversal, excluded state and non-source formats", () => {
    const dir = fixture(); rmSync(join(dir, "release-files.json"));
    expect(() => sourceFiles(dir)).toThrow("inventory");
    for (const file of ["../outside.md", ".dots-bridge/pairing.json", "build/private.js", "recording.wav", "key.pem", "photo.jpg"]) {
      inventory(dir, [file]); expect(() => sourceFiles(dir)).toThrow("inventory");
    }
  });
  it("rejects missing files and file or directory symlinks", () => {
    const dir = fixture(); inventory(dir, ["missing.md"]); expect(() => sourceFiles(dir)).toThrow("unsafe release source");
    inventory(dir, ["README.md"]); rmSync(join(dir, "README.md"));
    const other = fixture(); symlinkSync(join(other, "README.md"), join(dir, "README.md"));
    expect(() => sourceFiles(dir)).toThrow("unsafe release source");
    rmSync(join(dir, "README.md")); writeFileSync(join(dir, "README.md"), "Public");
    symlinkSync(other, join(dir, "docs")); inventory(dir, ["README.md", "docs/README.md"]);
    expect(() => sourceFiles(dir)).toThrow("unsafe release source");
  });
  it.each([
    ["email address", () => ["reader", "example.invalid"].join("@")],
    ["personal absolute path", () => ["", "Users", "ExampleUser", "project"].join("/")],
    ["personal absolute path", () => ["", "home", "ExampleUser", "project"].join("/")],
    ["personal absolute path", () => ["C:", "Users", "ExampleUser", "project"].join("\\")],
    ["embedded network address", () => [10, 9, 8, 7].join(".")],
    ["embedded network address", () => ["2001", "db8", "", "1"].join(":")],
    ["literal credential", () => randomBytes(32).toString("hex")],
    ["literal credential", () => "Aa1".repeat(14) + "_"],
    ["literal credential", () => "sk" + "-" + randomBytes(24).toString("base64url")],
    ["private key", () => ["-----BEGIN", "PRIVATE KEY-----"].join(" ")],
    ["configured Dot identifier", () => "https://chatgpt.com/dots/" + randomUUID()],
    ["unreviewed endpoint", () => "https://" + ["unreviewed", "server"].join(".") + "/api"],
    ["URL credential", () => "https://" + ["reader:password", "example.invalid"].join("@") + "/api"],
  ] as const)("rejects %s without reporting the offending value", (rule, payload) => {
    const value = payload(), dir = fixture(value);
    let error = ""; try { checkRelease(dir); } catch (caught) { error = String(caught); }
    expect(error).toContain(rule); expect(error).not.toContain(value);
  });
  it("checks literal identity and project markers with local rules, without bundling those rules", () => {
    const marker = ["PRIVATE", "PROJECT", "MARKER"].join("-");
    const dir = fixture(marker.toLowerCase());
    expect(() => checkRelease(dir, { forbiddenStrings: [marker] })).toThrow("private identifier");
  });
  it("uses private CLI rules without printing the identity, policy path or workspace path", () => {
    const marker = ["PRIVATE", "PROJECT", "MARKER"].join("-");
    const dir = fixture(marker), policyDir = fixture();
    mkdirSync(join(dir, "scripts"));
    for (const name of ["chrome-extension.mjs", "configuration.mjs", "release-check.mjs"]) copyFileSync(resolve(root, "scripts", name), join(dir, "scripts", name));
    inventory(dir, ["README.md", "scripts/chrome-extension.mjs", "scripts/configuration.mjs", "scripts/release-check.mjs"]);
    const policy = join(policyDir, ".policy.json");
    writeFileSync(policy, JSON.stringify({ forbiddenStrings: [marker] }));
    const result = spawnSync(process.execPath, [join(dir, "scripts/release-check.mjs")], {
      encoding: "utf8", env: { ...process.env, DOTS_RELEASE_PRIVATE_CHECK_FILE: policy },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private identifier");
    expect(result.stderr).not.toContain(marker); expect(result.stderr).not.toContain(dir); expect(result.stderr).not.toContain(policy);
  });
  it("fails closed for malformed local policy without echoing the supplied file", () => {
    const dir = fixture(); mkdirSync(join(dir, "scripts"));
    for (const name of ["chrome-extension.mjs", "configuration.mjs", "release-check.mjs"]) copyFileSync(resolve(root, "scripts", name), join(dir, "scripts", name));
    inventory(dir, ["README.md", "scripts/chrome-extension.mjs", "scripts/configuration.mjs", "scripts/release-check.mjs"]);
    const policyDir = fixture(), policy = join(policyDir, ".policy.json"), privateValue = randomBytes(32).toString("hex");
    writeFileSync(policy, privateValue);
    const result = spawnSync(process.execPath, [join(dir, "scripts/release-check.mjs")], {
      encoding: "utf8", env: { ...process.env, DOTS_RELEASE_PRIVATE_CHECK_FILE: policy },
    });
    expect(result.status).toBe(1); expect(result.stderr).toContain("Invalid private release check file");
    expect(result.stderr).not.toContain(privateValue); expect(result.stderr).not.toContain(policy);
  });
  it("ignores valid npm integrity metadata while checking other lockfile fields", () => {
    const dir = fixture(), integrity = "sha512-" + randomBytes(64).toString("base64");
    const lock = { packages: { "node_modules/example": { integrity, resolved: "https://registry.npmjs.org/example" } } };
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock)); inventory(dir, ["README.md", "package-lock.json"]);
    expect(checkRelease(dir).ok).toBe(true);
    (lock.packages["node_modules/example"] as any).token = randomBytes(32).toString("hex");
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock)); expect(() => checkRelease(dir)).toThrow("credential");
    delete (lock.packages["node_modules/example"] as any).token;
    lock.packages["node_modules/example"].integrity = "sha512-invalid";
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock)); expect(() => checkRelease(dir)).toThrow("integrity");
  });
  it("accepts loopback transport, placeholders and public documentation URLs", () => {
    const dir = fixture("http://127.0.0.1:8799/ ws://localhost:8799/ ws://[::1]:8799/ ws://YOUR_MAC_HOST:8799/ https://chatgpt.com/dots/home https://github.com/example/project https://tailscale.com/download https://tailscale.com/docs/how-to/connect-to-devices");
    expect(checkRelease(dir).ok).toBe(true);
  });
  it("allows passive SVG guides and rejects active or external image content", () => {
    const dir = fixture(); mkdirSync(join(dir, "docs"));
    const image = join(dir, "docs/guide.svg"); inventory(dir, ["README.md", "docs/guide.svg"]);
    writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg"><text>Setup</text></svg>');
    expect(checkRelease(dir).ok).toBe(true);
    for (const content of ['<script>run()</script>', '<svg onload="run()"/>', '<image href="https://example.invalid/image"/>', '<foreignObject/>']) {
      writeFileSync(image, content); expect(() => checkRelease(dir)).toThrow("image content");
    }
  });
  it("rejects binary or invalid UTF-8 content even when the extension is approved", () => {
    const dir = fixture();
    for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([255, 254])]) {
      writeFileSync(join(dir, "README.md"), bytes); expect(() => checkRelease(dir)).toThrow();
    }
  });
  it("allows reviewed documentation JPEGs but rejects metadata, trailing data and invalid images without exposing content", () => {
    const dir = fixture(), name = "docs/images/g2-device.jpg";
    mkdirSync(join(dir, "docs/images"), { recursive: true }); inventory(dir, ["README.md", name]);
    const photo = readFileSync(resolve(root, name));
    writeFileSync(join(dir, name), photo);
    expect(inspectReleaseImage(photo)).toEqual({ width: 588, height: 1280 });
    expect(checkRelease(dir).ok).toBe(true);
    const privateValue = randomBytes(32).toString("hex"), payload = Buffer.from("Exif\0" + privateValue);
    const header = Buffer.from([255, 225, 0, 0]); header.writeUInt16BE(payload.length + 2, 2);
    writeFileSync(join(dir, name), Buffer.concat([photo.subarray(0, 2), header, payload, photo.subarray(2)]));
    let error = ""; try { checkRelease(dir); } catch (caught) { error = String(caught); }
    expect(error).toContain("metadata"); expect(error).not.toContain(privateValue);
    writeFileSync(join(dir, name), Buffer.concat([photo, Buffer.from(privateValue)]));
    expect(() => checkRelease(dir)).toThrow("Invalid documentation image");
    writeFileSync(join(dir, name), Buffer.from([255, 216, 255, 217]));
    expect(() => checkRelease(dir)).toThrow("Invalid documentation image");
  });
  it("creates a clean source-only GitHub folder and refuses to overwrite Git history", () => {
    const dir = fixture(), scripts = ["chrome-extension.mjs", "configuration.mjs", "release-check.mjs", "release-stage.mjs"];
    for (const name of scripts) {
      const target = join(dir, "scripts", name); mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(root, "scripts", name), target);
    }
    inventory(dir, ["README.md", ...scripts.map(name => "scripts/" + name)]);
    mkdirSync(join(dir, ".dots-bridge")); writeFileSync(join(dir, ".dots-bridge/pairing.json"), randomBytes(32).toString("hex"));
    const stage = () => spawnSync(process.execPath, [join(dir, "scripts/release-stage.mjs")], { encoding: "utf8" });
    expect(stage().status).toBe(0);
    const output = join(dir, "build/github/dots-bridge-kit");
    expect(sourceFiles(output)).toEqual(sourceFiles(dir)); expect(checkRelease(output).ok).toBe(true);
    expect(existsSync(join(output, ".dots-bridge"))).toBe(false); expect(existsSync(join(output, ".git"))).toBe(false);
    expect(readFileSync(join(output, "README.md"), "utf8")).toBe("Public source");
    mkdirSync(join(output, ".git")); writeFileSync(join(output, ".git/keep"), "Existing history");
    expect(stage().status).not.toBe(0); expect(readFileSync(join(output, ".git/keep"), "utf8")).toBe("Existing history");
  });
});
