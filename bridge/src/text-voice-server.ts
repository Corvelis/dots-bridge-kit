import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppleSpeechTranscriber } from "./apple-speech-transcriber";
import { DotsEchoClient } from "./dots-echo-client";
import { createTextVoiceService } from "./text-voice-service";

const pairing = JSON.parse(readFileSync(resolve(".dots-bridge/pairing.json"), "utf8"));
const port = Number(process.env.DOTS_TEXT_PORT || pairing.ports.text);
const relayPort = Number(process.env.DOTS_RELAY_PORT || pairing.ports.relay);
const dots = new DotsEchoClient({ url: "ws://127.0.0.1:" + relayPort + "/dots/ws", token: pairing.token, appId: "g2-text-voice" });
dots.start();
const service = createTextVoiceService({
  token: pairing.token, speech: new AppleSpeechTranscriber(), dots,
  cursorPath: resolve(".dots-bridge/text-voice-notification-cursor.json"),
});
service.server.on("error", error => { console.error(error.message); process.exitCode = 1; void service.close().finally(() => dots.stop()); });
service.server.listen(port, process.env.DOTS_TEXT_HOST || "127.0.0.1", () => {
  console.log("Dots ASR/text worker ready");
  process.send?.({ type: "ready", kind: "text", port });
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void service.close().finally(() => { dots.stop(); process.exit(0); }); });
