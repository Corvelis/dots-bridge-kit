import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { root, readPairing } from "./configuration.mjs";
import { startBridge } from "./supervisor.mjs";
process.chdir(root);
if (existsSync(".env")) loadEnvFile(".env");
try {
  const config = readPairing(), bridge = await startBridge({ root, config });
  console.log(`Dots Bridge Kit ready: http://${config.phoneHost}:${config.port}/ (call, text and ASR)`);
  const result = await bridge.done;
  if (result.error) { console.error(result.error.message); process.exitCode = 1; }
} catch (error) { console.error(error.message); process.exitCode = 1; }
