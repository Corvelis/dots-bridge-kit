const $ = id => document.getElementById(id);
let socket, context, mic, micStream, micSource, micGain, metadata, connected = false, phase = "idle", clientId, owner;
let workletLoaded = false;
let browserOnline = false, recovering = false, inputCongested = false;
let inputBytes = 0, outputBytes = 0, playbackAt = 0, streamId, held = false, sources = new Set();
const pending = new Map();
const resumeKey = (() => {
  try { const saved = sessionStorage.getItem("dots-voice.resume.v1"); if (/^[a-f0-9]{64}$/.test(saved || "")) return saved; } catch {}
  const key = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem("dots-voice.resume.v1", key); } catch {}
  return key;
})();
const note = text => { $("log").textContent = `${text}\n${$("log").textContent}`.slice(0, 7000); };
const refresh = () => {
  $("start").disabled = !connected || !browserOnline || phase !== "idle";
  $("stop").disabled = !connected || !(owner === clientId || phase === "needs-stop");
  $("ptt").disabled = !connected || recovering || phase !== "active" || owner !== clientId || !mic;
  $("microphone").disabled = !connected || phase !== "idle" || !mic;
  $("status").textContent = !connected ? "未接続" : phase === "idle" && !browserOnline ? "dotのChrome接続を待っています"
    : recovering && phase === "active" ? "通話を維持して音声・接続を復旧中"
    : ({ idle: "接続済み · 通話を開始できます", starting: "通話を準備中", active: "通話中", stopping: "通話を終了中", "needs-stop": "終了確認・入力復元が必要です" })[phase];
};
function rpc(method, params) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("接続してください"));
  const id = crypto.randomUUID(); socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("応答待ちが長引いています。状態を確認してください。自動再送はしません。")); }, 55000);
    pending.set(id, { resolve, reject, timer });
  });
}
function resetPlayback(nextStream) {
  for (const source of sources) { try { source.stop(); } catch {} } sources.clear();
  playbackAt = 0; streamId = nextStream; metadata = undefined;
}
function play(bytes, meta) {
  if (!context || context.state !== "running" || meta.streamId !== streamId) return;
  if (bytes.byteLength !== meta.byteLength || bytes.byteLength % (meta.channels * 2)) { note("音声フレームの形式が一致しません"); return; }
  if (playbackAt > context.currentTime + 2) { resetPlayback(meta.streamId); note("再生の遅れを解消するため古い音声を破棄しました。通話は継続します"); }
  const frames = bytes.byteLength / (meta.channels * 2), view = new DataView(bytes);
  const buffer = context.createBuffer(meta.channels, frames, meta.sampleRate);
  for (let channel = 0; channel < meta.channels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < frames; i++) samples[i] = view.getInt16((i * meta.channels + channel) * 2, true) / 32768;
  }
  const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
  const lead = 0.04;
  if (playbackAt <= context.currentTime) playbackAt = context.currentTime + lead;
  source.start(playbackAt); playbackAt += buffer.duration;
  sources.add(source); source.onended = () => sources.delete(source);
  outputBytes += bytes.byteLength; $("stats").textContent = `入力 ${inputBytes} B · 出力 ${outputBytes} B`;
}
async function enableMic() {
  if (mic) return;
  if (!window.isSecureContext) { note("このURLではブラウザのマイクを使えません。localhostかHTTPSで開いてください。音声受信は利用できます。"); return; }
  micStream?.getTracks().forEach(track => track.stop());
  const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  let devices;
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput"
      && !["default", "communications"].includes(device.deviceId) && !/BlackHole/i.test(device.label));
  } finally { permissionStream.getTracks().forEach(track => track.stop()); }
  if (!devices.length) throw new Error("BlackHole以外の入力マイクが見つかりません");
  const selected = devices.find(device => device.deviceId === $("microphone").value)
    || devices.find(device => /MacBook|built.in|内蔵/i.test(device.label)) || devices[0];
  $("microphone").replaceChildren(...devices.map(device => new Option(device.label || "入力マイク", device.deviceId)));
  $("microphone").value = selected.deviceId;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: selected.deviceId }, channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  try {
    if (!workletLoaded) { await context.audioWorklet.addModule("/mic-worklet.js"); workletLoaded = true; }
  } catch (error) { micStream.getTracks().forEach(track => track.stop()); micStream = undefined; throw error; }
  mic = new AudioWorkletNode(context, "dots-mic");
  micSource = context.createMediaStreamSource(micStream); micSource.connect(mic);
  micGain = context.createGain(); micGain.gain.value = 0; mic.connect(micGain).connect(context.destination);
  mic.port.onmessage = event => sendMic(event.data);
  refresh();
}
function sendMic(bytes) {
    if (!held || phase !== "active" || socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount + bytes.byteLength > 16000) {
      if (!inputCongested) note("マイク転送が混雑しています。通話と長押しは継続しますが、音声が一部途切れる場合があります");
      inputCongested = true; return;
    }
    if (inputCongested) { inputCongested = false; note("マイク転送が戻りました。そのまま話せます"); }
    socket.send(bytes); inputBytes += bytes.byteLength;
}
function applyState(next) {
  phase = next.phase; owner = next.owner; browserOnline = next.browserOnline;
  recovering = Object.values(next.recovery || {}).some(value => value === true);
  if (phase !== "active" || recovering) void endInput(); refresh();
}
async function beginInput(event) {
  if (held || $("ptt").disabled) return;
  held = true; $("ptt").classList.add("held"); $("ptt").textContent = "話しています · 離すと送信停止";
  if (event.pointerId !== undefined) $("ptt").setPointerCapture(event.pointerId);
  try {
    await context.resume(); await rpc("audio.input", { enabled: true });
    if (held) mic.port.postMessage(true);
    else await rpc("audio.input", { enabled: false });
  } catch (error) { held = false; note(error.message); await endInput(); }
}
async function endInput() {
  const wasHeld = held; held = false; mic?.port.postMessage(false);
  inputCongested = false;
  $("ptt").classList.remove("held"); $("ptt").textContent = "押している間だけ話す";
  if (wasHeld && connected) { try { await rpc("audio.input", { enabled: false }); } catch (error) { note(error.message); } }
}
$("connect").onclick = async () => {
  try {
    context ??= new AudioContext(); await context.resume();
    if (socket?.readyState === WebSocket.OPEN) { await enableMic(); return; }
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/voice/ws`); socket.binaryType = "arraybuffer";
    socket.onopen = () => socket.send(JSON.stringify({ type: "voice.hello", version: 1, token: $("token").value, resumeKey }));
    socket.onmessage = event => {
      if (event.data instanceof ArrayBuffer) { if (metadata) play(event.data, metadata); metadata = undefined; return; }
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); return;
      }
      if (message.type === "voice.ready") {
        connected = true; clientId = message.clientId; streamId = message.state.streamId; applyState(message.state);
        note("接続しました。dotを開くChromeのマイクはBlackHole 2chに設定してください。Macの確認画面はChrome以外で開いてください。"); void enableMic().catch(error => note(`マイク: ${error.message}`));
      } else if (message.type === "voice.state") {
        applyState(message);
      } else if (message.type === "audio.reset") resetPlayback(message.streamId);
      else if (message.type === "audio.chunk") metadata = message;
      else if (message.type === "voice.notice" || message.type === "voice.error") note(message.message);
      else if (message.type === "browser.state") { browserOnline = message.online; refresh(); }
    };
    socket.onclose = () => {
      connected = false; held = false; mic?.port.postMessage(false); resetPlayback(); refresh();
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("ブリッジとの接続が終了しました")); } pending.clear();
      note("接続が終了しました。通話は自動再開しません。");
    };
    socket.onerror = () => note("Macブリッジとの接続を確認してください");
  } catch (error) { note(error.message); }
};
$("start").onclick = () => rpc("session.start").catch(error => note(error.message));
$("stop").onclick = async () => { await endInput(); try { await rpc("session.stop"); } catch (error) { note(error.message); } };
$("microphone").onchange = async () => {
  mic?.disconnect(); micSource?.disconnect(); micGain?.disconnect(); micStream?.getTracks().forEach(track => track.stop()); mic = undefined;
  refresh(); try { await enableMic(); } catch (error) { note(error.message); }
};
$("ptt").onpointerdown = beginInput;
for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) $("ptt").addEventListener(event, () => void endInput());
addEventListener("blur", () => void endInput());
document.addEventListener("visibilitychange", () => { if (document.hidden) void endInput(); });
addEventListener("pagehide", () => { micStream?.getTracks().forEach(track => track.stop()); socket?.close(); });
refresh();
