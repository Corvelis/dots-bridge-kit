import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { inspectReleaseText, privateRules, dependencyText } from "./release-check.mjs";

export function artifactFiles(base) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory).sort()) {
      const path = resolve(directory, entry), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Artifact symlink rejected");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(relative(base, path).split(sep).join("/"));
      else throw new Error("Unsafe artifact entry");
    }
  }
  walk(base); return files;
}
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function checkRuntimeManifest(base) {
  const manifest = JSON.parse(readFileSync(resolve(base, "release-runtime.json"), "utf8"));
  if (Object.keys(manifest).sort().join(",") !== "arch,files,format,macos,platform,version" || manifest.format !== 1
    || manifest.platform !== "darwin" || !["arm64", "x64"].includes(manifest.arch) || manifest.macos !== "26.0"
    || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.files || Array.isArray(manifest.files)) throw new Error("Invalid runtime manifest");
  const names = Object.keys(manifest.files);
  if (JSON.stringify(artifactFiles(base)) !== JSON.stringify([...names, "release-runtime.json"].sort())) throw new Error("Runtime manifest inventory mismatch");
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(manifest.files[name]) || digest(readFileSync(resolve(base, name))) !== manifest.files[name]) throw new Error("Runtime file checksum mismatch");
  }
  return manifest;
}
export function checkArtifactDirectory(base, expected, { forbiddenStrings = privateRules() } = {}) {
  const files = artifactFiles(base);
  if (new Set(expected).size !== expected.length || JSON.stringify(files) !== JSON.stringify([...expected].sort()))
    throw new Error("Artifact inventory mismatch");
  const problems = [];
  for (const name of files) {
    if (name.split("/").some(part => !/^[A-Za-z0-9_. -]+$/.test(part) || [".git", ".dots-bridge", "node_modules", ".DS_Store"].includes(part))
      || /(?:^|\/)(?:\.env(?!\.example$)|pairing\.json)|\.(?:log|jsonl|ehpk)$/.test(name)) throw new Error("Unsafe artifact filename");
    const bytes = readFileSync(resolve(base, name));
    if (bytes.length > 64 * 1024 * 1024) throw new Error("Oversized artifact file");
    // Scan UTF-8 and UTF-16 identities in native executables, without printing matches.
    const identities = bytes.toString("utf8") + "\n" + bytes.toString("utf16le");
    const normalized = identities.normalize("NFKC").toLowerCase();
    if (forbiddenStrings.some(value => normalized.includes(value.normalize("NFKC").toLowerCase()))) problems.push({ file: name, rule: "private identifier" });
    if (name === "release-runtime.json") checkRuntimeManifest(base);
    else {
      const strings = name === "package-lock.json" ? dependencyText(bytes.toString("utf8"))
        : bytes.includes(0) ? (bytes.toString("latin1").match(/[\x20-\x7e]{4,}/g) ?? []).join("\n") : bytes.toString("utf8");
      // Public SDK 0.0.15 transport marker, verified against the npm package.
      // Compiler symbols and this marker are metadata, never application tokens.
      const sdkTransportMarker = ["qvbqx1jfuvvfu1r", "FuKvcvuLmrf9qqu", "Dfx1nvq0nfu1m"].join("");
      for (const rule of inspectReleaseText(strings, [], { allowSwiftSymbols: bytes.includes(0), publicConstants: [sdkTransportMarker] }))
        problems.push({ file: name, rule });
    }
  }
  if (problems.length) throw new Error(JSON.stringify({ problems }, null, 2));
  return { ok: true, files: files.length };
}
