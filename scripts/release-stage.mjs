import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { root } from "./configuration.mjs";
import { checkRelease, sourceFiles } from "./release-check.mjs";

checkRelease();
const parent = resolve(root, "build/github");
const output = resolve(parent, "dots-bridge-kit");
if (existsSync(resolve(output, ".git"))) throw new Error("Move the Git repository before regenerating the release folder");
mkdirSync(parent, { recursive: true });
const temporary = mkdtempSync(resolve(parent, ".source-"));
try {
  for (const name of sourceFiles()) {
    const target = resolve(temporary, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, name), target);
  }
  checkRelease(temporary);
  rmSync(output, { recursive: true, force: true });
  renameSync(temporary, output);
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log("GitHub source folder: build/github/dots-bridge-kit");
