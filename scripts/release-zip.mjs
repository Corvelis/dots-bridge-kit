import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { root } from "./configuration.mjs";
import { checkRelease, sourceFiles } from "./release-check.mjs";
checkRelease();
const outputDirectory = resolve(root, "build/releases"); mkdirSync(outputDirectory, { recursive: true });
const output = resolve(outputDirectory, "dots-bridge-kit-source.zip");
// Archive an explicit source inventory, never the whole configured workspace.
const temporary = mkdtempSync(resolve(outputDirectory, ".source-"));
try {
  const archive = resolve(temporary, "source.zip");
  execFileSync("zip", ["-q", archive, "-@"], { cwd: root, input: sourceFiles().join("\n") + "\n" });
  renameSync(archive, output);
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log("Source-only archive: build/releases/dots-bridge-kit-source.zip");
