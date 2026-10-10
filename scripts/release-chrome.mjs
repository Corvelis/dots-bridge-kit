import { copyFileSync, readFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { root } from "./configuration.mjs";
import { chromeFiles, copyChromeExtension } from "./chrome-extension.mjs";
import { checkRelease } from "./release-check.mjs";
import { checkArtifactDirectory, checkArtifactDocumentation } from "./release-artifacts.mjs";

checkRelease();
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const name = "dots-bridge-kit-chrome-v" + version;
const output = resolve(root, "build/releases"); mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(resolve(output, ".chrome-")), stage = resolve(temporary, name);
try {
  copyChromeExtension(root, stage);
  copyFileSync(resolve(root, "docs/chrome-extension.md"), resolve(stage, "README.md"));
  copyFileSync(resolve(root, "LICENSE"), resolve(stage, "LICENSE"));
  const files = [...chromeFiles, "README.md", "LICENSE"].sort();
  const checked = checkArtifactDirectory(stage, files);
  checkArtifactDocumentation(stage);
  execFileSync("zip", ["-q", resolve(temporary, "chrome.zip"), "-@"], { cwd: temporary,
    input: files.map(file => name + "/" + file).join("\n") + "\n" });
  renameSync(resolve(temporary, "chrome.zip"), resolve(output, name + ".zip"));
  console.log(JSON.stringify({ artifact: "build/releases/" + name + ".zip", ...checked }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
