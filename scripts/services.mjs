import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { root, readPairing } from "./configuration.mjs";
if (process.platform !== "darwin") throw new Error("Background services require macOS launchd");
readPairing();
const action = process.argv[2], directory = resolve(homedir(), "Library/LaunchAgents");
if (!["start", "stop", "status"].includes(action)) throw new Error("Choose start, stop or status");
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const domain = "gui/" + process.getuid();
const installed = target => { try { return execFileSync("/bin/launchctl", ["print", target], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
// Retire only registrations belonging to this checkout when upgrading.
if (action !== "status") for (const kind of ["voice", "text", "relay"]) {
  const label = "org.dotsbridgekit." + kind, target = domain + "/" + label;
  const runner = resolve(root, "scripts/run.mjs"), plistPath = resolve(directory, label + ".plist");
  const existing = installed(target);
  if (existing?.includes(runner)) execFileSync("/bin/launchctl", ["bootout", target], { stdio: "inherit" });
  if (existsSync(plistPath) && readFileSync(plistPath, "utf8").includes(xml(runner))) {
    const { unlinkSync } = await import("node:fs"); unlinkSync(plistPath);
  }
}
for (const kind of ["bridge"]) {
  const label = "org.dotsbridgekit." + kind, target = domain + "/" + label;
  const plistPath = resolve(directory, label + ".plist"), existing = installed(target);
  const runner = resolve(root, "scripts/start.mjs");
  if (existing && !existing.includes(runner)) throw new Error("Another installation owns " + label);
  if (action === "status") { console.log(kind + ": " + (existing ? "loaded" : "not loaded")); continue; }
  if (action === "stop") {
    if (existing) execFileSync("/bin/launchctl", ["bootout", target], { stdio: "inherit" });
    // Remove only a matching login registration; keep pairing and history.
    if (existsSync(plistPath) && readFileSync(plistPath, "utf8").includes(xml(runner))) {
      const { unlinkSync } = await import("node:fs"); unlinkSync(plistPath);
    }
    console.log(kind + ": stopped"); continue;
  }
  if (existing) { console.log(kind + ": already loaded"); continue; }
  if (existsSync(plistPath) && !readFileSync(plistPath, "utf8").includes(xml(runner))) throw new Error("Another installation owns " + label);
  if (!existsSync(resolve(root, "build/servers/server.js"))) throw new Error("Run npm run build first");
  mkdirSync(directory, { recursive: true });
  const logDirectory = resolve(root, ".dots-bridge/logs"); mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  for (const suffix of ["out", "err"]) {
    const path = resolve(logDirectory, kind + "." + suffix + ".log");
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  }
  const plist = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
    + "<key>Label</key><string>" + label + "</string><key>ProgramArguments</key><array>"
    + [process.execPath, runner].map(value => "<string>" + xml(value) + "</string>").join("")
    + "</array><key>WorkingDirectory</key><string>" + xml(root) + "</string>"
    + "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>"
    + "<key>ExitTimeOut</key><integer>45</integer>"
    + "<key>StandardOutPath</key><string>" + xml(resolve(logDirectory, kind + ".out.log")) + "</string>"
    + "<key>StandardErrorPath</key><string>" + xml(resolve(logDirectory, kind + ".err.log")) + "</string></dict></plist>";
  writeFileSync(plistPath, plist, { mode: 0o600 });
  execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "ignore" });
  execFileSync("/bin/launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
  console.log(kind + ": started (also starts at login)");
}
