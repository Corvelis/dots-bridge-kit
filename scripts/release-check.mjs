import { readdirSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, relative, extname, sep } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { root } from "./configuration.mjs";

const inventoryName = "release-files.json";
const excluded = new Set([".git", "node_modules", "build", "dist-dots-phone-g2", ".dots-bridge", ".state", ".swift-cache", ".build", "bin", "dist", "coverage"]);
const sourceExtensions = new Set([".ts", ".js", ".mjs", ".mts", ".json", ".md", ".swift", ".html", ".css", ".yml", ".plist", ".svg"]);
const specialSources = new Set([".env.example", ".gitignore", ".nvmrc", "LICENSE"]);
const loopback = new Set(["127.0.0.1", "0.0.0.0", "::", "::1", "::ffff:127.0.0.1"]);
const publicHosts = new Set(["chatgpt.com", "github.com", "nodejs.org", "www.apple.com", "developer.chrome.com",
  "support.apple.com", "www.w3.org", "hub.evenrealities.com", "registry.npmjs.org", "www.npmjs.com", "opencollective.com", "tidelift.com", "tailscale.com"]);

function excludedName(name) {
  return excluded.has(name) || name === ".DS_Store" || name.startsWith(".env") && name !== ".env.example"
    || /\.(ehpk|zip|log|jsonl)$/.test(name) || name.endsWith(".paired.json");
}
function utf8(path) {
  let bytes;
  try { bytes = readFileSync(path); } catch { throw new Error("Unable to read release source"); }
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) throw new Error("Non-text or oversized release source");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Invalid UTF-8 release source"); }
}

/** Only explicitly reviewed files can enter a release, never a directory glob. */
export function sourceFiles(base = root) {
  let manifest;
  try { manifest = JSON.parse(utf8(resolve(base, inventoryName))); }
  catch { throw new Error("Missing or invalid release inventory"); }
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length
    || manifest.files.length > 1024 || !manifest.files.includes(inventoryName)
    || new Set(manifest.files).size !== manifest.files.length) throw new Error("Invalid release inventory");
  for (const name of manifest.files) {
    if (typeof name !== "string" || name.includes("\\") || name.startsWith("/") || name.split("/").some(part =>
      !part || part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part) || excludedName(part))
      || !sourceExtensions.has(extname(name)) && !specialSources.has(name)) throw new Error("Unsafe release inventory entry");
    let path = resolve(base);
    try {
      const parts = name.split("/");
      for (const [index, part] of parts.entries()) {
        path = resolve(path, part);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error();
      }
    } catch { throw new Error("Missing or unsafe release source"); }
  }
  return [...manifest.files].sort();
}

function actualSourceFiles(base) {
  const files = [];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      if (excludedName(name)) continue;
      const path = resolve(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Unexpected source symlink");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(relative(base, path).split(sep).join("/"));
      else throw new Error("Unexpected source entry");
    }
  }
  try { walk(base); } catch { throw new Error("Unable to inspect source inventory or unsafe source symlink"); }
  return files;
}

export function dependencyText(text) {
  let lock;
  try { lock = JSON.parse(text); } catch { throw new Error("Invalid dependency lockfile"); }
  for (const pkg of Object.values(lock.packages ?? {})) {
    if (pkg.integrity === undefined) continue;
    // npm integrity digests are public metadata, not application credentials.
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(pkg.integrity);
    if (!match || Buffer.from(match[1], "base64").length !== 64
      || Buffer.from(match[1], "base64").toString("base64") !== match[1]) throw new Error("Invalid dependency integrity");
    delete pkg.integrity;
  }
  return JSON.stringify(lock);
}

export function inspectReleaseText(text, forbiddenStrings = [], { allowSwiftSymbols = false, publicConstants = [] } = {}) {
  const rules = new Set();
  if (/(?<![\w/])\/(?:Users|home|Volumes)\/[^\s/"'<>]+|(?<![\w/])\/private\/(?:tmp|var)(?:\/|\b)|\b[A-Z]:\\+(?:Users|Documents and Settings)\\+|\bfile:\/\//i.test(text)) rules.add("personal absolute path");
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) rules.add("email address");
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g))
    if (isIP(match[0]) && !loopback.has(match[0])) rules.add("embedded network address");
  for (const match of text.matchAll(/(?<![\w])(?:[a-f0-9]{0,4}:){2,}[a-f0-9:.%]*(?![\w])/gi))
    if (isIP(match[0]) === 6 && !loopback.has(match[0])) rules.add("embedded network address");
  if (/\b[a-f0-9]{64}\b/i.test(text)
    || /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text)
    || /\bBearer\s+[A-Za-z0-9_+/=-]{24,}/i.test(text)
    || /\b(?:token|api[_-]?key|secret|password|resumeKey)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{24,}["']/i.test(text)) rules.add("literal credential");
  for (const match of text.matchAll(/(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/-]{43}=?($|(?=[^A-Za-z0-9_+/=-]))/g)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const symbol = allowSwiftSymbols && /^(?:_?\$s[A-Za-z0-9_$]+|_symbolic [A-Za-z0-9_$ ]+)$/m.test(text.slice(lineStart, text.indexOf("\n", match.index) < 0 ? text.length : text.indexOf("\n", match.index)));
    if (!symbol && !publicConstants.includes(match[0]) && /[a-z]/.test(match[0]) && /[A-Z]/.test(match[0]) && /\d/.test(match[0])) rules.add("literal credential");
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) rules.add("private key");
  if (/https:\/\/chatgpt\.com\/dots\/[a-f0-9]{8}-/i.test(text)) rules.add("configured Dot identifier");
  for (const match of text.matchAll(/\b(?:https?|wss?):\/\/([^/?#\s"'\x60<>{}()\\]+)/g)) {
    const authority = match[1];
    if (authority.includes("@")) { rules.add("URL credential"); continue; }
    if (authority.includes("$") || /^YOUR_[A-Z_]+(?::|$)/.test(authority)) continue;
    const host = (authority.startsWith("[") ? authority.slice(1, authority.indexOf("]")) : authority.split(":")[0]).toLowerCase();
    if (loopback.has(host) || host === "localhost" || publicHosts.has(host) || /(?:^|\.)example(?:\.invalid)?$|(?:^|\.)invalid$/.test(host)) continue;
    rules.add("unreviewed endpoint");
  }
  const normalized = text.normalize("NFKC").toLowerCase();
  if (forbiddenStrings.some(value => normalized.includes(value.normalize("NFKC").toLowerCase()))) rules.add("private identifier");
  return [...rules];
}

export function privateRules() {
  const file = process.env.DOTS_RELEASE_PRIVATE_CHECK_FILE;
  if (!file) return [];
  let config;
  try { config = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Invalid private release check file"); }
  if (!Array.isArray(config.forbiddenStrings) || config.forbiddenStrings.some(value => typeof value !== "string" || value.length < 4))
    throw new Error("Invalid private release check rules");
  return config.forbiddenStrings;
}

/** Errors report only rule names and reviewed relative filenames, never matches. */
export function checkRelease(base = root, { forbiddenStrings = privateRules() } = {}) {
  const problems = [], files = sourceFiles(base), approved = new Set(files);
  if (actualSourceFiles(base).some(name => !approved.has(name))) problems.push({ rule: "unlisted source file" });
  for (const name of files) {
    let text = utf8(resolve(base, name));
    if (name === "package-lock.json") text = dependencyText(text);
    if (name.endsWith(".svg") && /<script\b|<foreignObject\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["'](?!#)|<!ENTITY/i.test(text))
      problems.push({ file: name, rule: "active or external image content" });
    for (const rule of inspectReleaseText(name + "\n" + text, forbiddenStrings)) problems.push({ file: name, rule });
  }
  if (problems.length) throw new Error(JSON.stringify({ problems }, null, 2));
  return { ok: true, files: files.length };
}
let main = false;
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* Imported module. */ }
if (main) {
  try { console.log(JSON.stringify(checkRelease())); }
  catch (error) { console.error(error instanceof Error ? error.message : "Release check failed"); process.exitCode = 1; }
}
