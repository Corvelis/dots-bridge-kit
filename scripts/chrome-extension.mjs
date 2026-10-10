import { createHash, createPublicKey } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export const chromeFiles = ["background.js", "call-control.js", "content.js", "manifest.json", "options.html", "options.js", "settings.js", "tab-routing.js", "watch.js"];

export function chromeIdentity(base) {
  const manifest = JSON.parse(readFileSync(resolve(base, "browser/dots-bridge/manifest.json"), "utf8"));
  const der = Buffer.from(manifest.key, "base64");
  const key = createPublicKey({ key: der, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048
    || der.toString("base64") !== manifest.key || manifest.manifest_version !== 3) throw new Error("Invalid Chrome public identity");
  const extensionId = [...createHash("sha256").update(der).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15]).map(n => String.fromCharCode(97 + n)).join("");
  return { extensionId, manifest };
}

export function copyChromeExtension(base, target) {
  const identity = chromeIdentity(base);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of chromeFiles) copyFileSync(resolve(base, "browser/dots-bridge", file), resolve(target, file));
  return identity;
}
