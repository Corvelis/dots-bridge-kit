import { readFileSync, writeFileSync, readdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";

export function personalManifest(template, urls, packageId) {
  const manifest = structuredClone(template);
  if (packageId !== undefined) {
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(packageId) || packageId.length > 128)
      throw new Error("Use a lowercase reverse-domain package ID, for example org.example.dotsphone");
    manifest.package_id = packageId;
  }
  const network = manifest.permissions.find(item => item.name === "network");
  if (!network) throw new Error("Missing G2 network permission");
  network.whitelist = [...new Set(Object.values(urls).flatMap(value => {
    const url = new URL(value);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Invalid G2 endpoint");
    return [url.origin, url.origin.replace(/^ws/, "http")];
  }))];
  return manifest;
}
export function assertNoToken(path, token) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Unexpected package symlink");
    if (entry.isDirectory()) assertNoToken(file, token);
    else if (!entry.isFile() || readFileSync(file).includes(token)) throw new Error("Credential or unsafe file in G2 package input");
  }
}
export function preparePrebuiltG2(input, output, baseUrl, token) {
  assertNoToken(input, token);
  cpSync(input, output, { recursive: true });
  const index = resolve(output, "index.html");
  const html = readFileSync(index, "utf8");
  if (!/<head(?:\s[^>]*)?>/i.test(html) || /name=["']dots-bridge-base-url["']/.test(html)) throw new Error("Invalid prebuilt G2 entrypoint");
  const origin = new URL(baseUrl).origin;
  const escaped = origin.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  writeFileSync(index, html.replace(/<head(?:\s[^>]*)?>/i, head => head + '\n<meta name="dots-bridge-base-url" content="' + escaped + '">'));
  assertNoToken(output, token);
}
