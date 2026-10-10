import { readConfiguredDotUrl } from "./settings.js";
import { normalDotTab, prepareDotTab, openNormalDot } from "./tab-routing.js";
let owner = null, native = null, activeId = null, retry = null;
let dotUrl, settingsPending;
function loadSettings() {
  if (owner && dotUrl) return Promise.resolve(dotUrl);
  if (!settingsPending) settingsPending = readConfiguredDotUrl(chrome).then(url => { dotUrl = url; return url; })
    .finally(() => { settingsPending = undefined; });
  return settingsPending;
}
const badge = (text, color) => { chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color }); };
const prepareWindow = (port, options) => prepareDotTab(chrome, dotUrl, port.sender.tab.id, options);
function disconnect() {
  clearTimeout(retry);
  const old = native; native = null; activeId = null;
  old?.disconnect();
}
function connect() {
  if (!owner || native) return;
  const connection = chrome.runtime.connectNative("org.dotsbridgekit.chrome");
  native = connection;
  connection.onMessage.addListener(async message => {
    if (connection !== native || !owner) return;
    if (message.type === "voice.command") {
      const page = owner;
      try {
        if (message.url !== dotUrl) throw new Error("Wrong dot call target");
        if (message.action === "start" || message.action === "prepare") await prepareWindow(page);
        if (page === owner && connection === native) page.postMessage(message);
      } catch (error) { connection.postMessage({ type: "voice.result", id: message.id, error: error.message }); }
    } else if (message.type === "job") {
      if (activeId) { disconnect(); return; }
      activeId = message.id;
      const page = owner;
      try {
        await prepareWindow(page);
        if (page !== owner || connection !== native) return;
        page.postMessage({ ...message, url: dotUrl });
      } catch (error) {
        connection.postMessage({ type: "failure", id: message.id, reason: error.message, sent: false });
      }
      badge("…", "#aa7711");
    } else if (message.type === "accepted") {
      activeId = null; owner.postMessage(message); badge("ON", "#18834b");
    } else if (message.type === "ready") { owner.postMessage({ type: "watch-ready" }); badge("ON", "#18834b"); }
    else if (["notification-accepted", "history-accepted", "history-error"].includes(message.type)) owner.postMessage(message);
    else if (message.type === "error") { owner.postMessage(message); disconnect(); badge("!", "#aa3333"); retry = setTimeout(connect, 5000); }
  });
  connection.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    if (connection !== native) return;
    native = null; activeId = null;
    owner?.postMessage({ type: "error", message: error ?? "Local bridge disconnected" });
    badge("!", "#aa3333");
    retry = setTimeout(connect, 5000);
  });
  connection.postMessage({ type: "ready", url: dotUrl });
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "dots-page" || !port.sender?.url?.startsWith("https://chatgpt.com/dots/")
    || port.sender?.frameId !== 0 || !port.sender?.tab) { port.disconnect(); return; }
  let alive = true;
  // Validate the window before claiming ownership. A reconnecting old popup must
  // not exclude a normal tab, and messages sent during this lookup must survive.
  const initialized = loadSettings().then(async url => {
    if (!alive) return false;
    if (port.sender.url !== url) { port.postMessage({ type: "inactive" }); port.disconnect(); return false; }
    await normalDotTab(chrome, url, port.sender.tab.id);
    if (!alive) return false;
    if (owner) throw new Error("Another dot tab owns the bridge");
    owner = port;
    return true;
  }).catch(error => {
    if (alive) {
      try { port.postMessage({ type: "error", message: error.message }); } catch { /* disconnected */ }
      port.disconnect();
    }
    return false;
  });
  port.onMessage.addListener(message => {
    void initialized.then(accepted => {
      if (!accepted || port !== owner) return;
      if (native && ["voice.state", "voice.result", "voice.diagnostic"].includes(message.type)) {
        if (JSON.stringify(message).length <= 8000) native.postMessage(message);
        return;
      }
      if (message.type === "ready") {
        prepareWindow(port, { activate: false }).then(() => { if (port === owner) connect(); })
          .catch(error => { port.postMessage({ type: "error", message: error.message }); badge("!", "#aa3333"); });
        return;
      }
      if (native && message.type === "history" && Number.isSafeInteger(message.revision) && message.revision > 0
        && typeof message.latest === "boolean" && Array.isArray(message.items) && message.items.length <= 100
        && new TextEncoder().encode(JSON.stringify(message)).length <= 240 * 1024) {
        native.postMessage({ type: "history", revision: message.revision, latest: message.latest, items: message.items }); return;
      }
      if (native && message.type === "notification" && typeof message.sourceId === "string"
        && message.sourceId.length <= 512 && typeof message.text === "string" && [...message.text].length <= 24000) {
        native.postMessage({ type: "notification", sourceId: message.sourceId, text: message.text,
          ...(message.role === "user" ? { role: "user", ...(typeof message.inputId === "string" ? { inputId: message.inputId } : {}) } : {}) });
        return;
      }
      if (!native || message.id !== activeId) return;
      if (message.type === "reply" && typeof message.text === "string" && [...message.text].length <= 24000) {
        native.postMessage({ type: "reply", id: activeId, sourceId: message.sourceId, text: message.text, browserReplyMs: message.browserReplyMs });
      } else if (message.type === "failure") {
        native.postMessage({ type: "failure", id: activeId, reason: String(message.reason).slice(0, 1000), sent: message.sent !== false });
      }
    });
  });
  port.onDisconnect.addListener(() => { alive = false; if (owner !== port) return; owner = null; disconnect(); badge("OFF", "#777777"); });
});
const openDot = async (focus = false) => openNormalDot(chrome, await loadSettings(), { focus, preferredTabId: owner?.sender.tab.id });
const openInBackground = () => { void openDot().catch(error => { console.warn(error.message); badge("!", "#aa3333"); }); };
chrome.runtime.onStartup.addListener(openInBackground);
chrome.runtime.onInstalled.addListener(openInBackground);
chrome.action.onClicked.addListener(() => { void openDot(true).catch(error => {
  console.warn(error.message); badge("!", "#aa3333"); void chrome.runtime.openOptionsPage();
}); });
