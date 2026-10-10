import { defineConfig } from "tsup";
export default defineConfig({
  entry: { "dots-server": "bridge/src/dots-server.ts", "text-voice-server": "bridge/src/text-voice-server.ts", server: "dots-voice-bridge/src/server.ts" },
  format: ["esm"], platform: "node", target: "node22", outDir: "build/servers", clean: true,
});
