import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./configuration.mjs";
import { digest } from "./release-artifacts.mjs";
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const names = ["dots-bridge-kit-source.zip", "dots-bridge-kit-macos-" + process.arch + "-v" + version + ".zip"];
if (names.some(name => !existsSync(resolve(root, "build/releases", name)))) throw new Error("Build source and runtime archives first");
writeFileSync(resolve(root, "build/releases/SHA256SUMS.txt"), names.map(name => digest(readFileSync(resolve(root, "build/releases", name))) + "  " + name).join("\n") + "\n");
console.log("Release checksums: build/releases/SHA256SUMS.txt");
