(() => {
  if (window.top !== window || globalThis.__vibeDotsContentLoaded) return;
  globalThis.__vibeDotsContentLoaded = true;
  let port, current = null, observer, retry, readyTimer, watchObserver, watching = false, watchOnline = false;
  const watch = new globalThis.DotsMessageWatch(), historyWatch = new globalThis.DotsHistoryWatch(), outbox = new Map();
  let historyTimer, historyRetry, historyPending;
  const rows = () => [...document.querySelectorAll("article.message-row .message-body[data-message-id]")];
  const textOf = row => row.querySelector(".message-text")?.innerText.trim() ?? "";
  const self = row => row.closest("article.message-row").classList.contains("self");
  const composer = () => document.querySelector('[contenteditable="true"][role="textbox"]')
    ?? document.querySelector('[contenteditable="true"].ProseMirror')
    ?? document.querySelector('textarea[aria-label="メッセージ"]');
  const sendButton = () => document.querySelector('button[aria-label="送信"]')
    ?? document.querySelector('button[aria-label="Send"]');
  const inputText = box => box instanceof HTMLTextAreaElement ? box.value : box.innerText;
  const post = message => { try { port?.postMessage(message); } catch { /* native host records uncertainty */ } };
  const callControl = new globalThis.DotsCallControl({ document, location, storage: sessionStorage, report: post });
  callControl.monitor();
  const snapshot = (limit = Infinity) => rows().filter(row => limit === Infinity || row.querySelector(".message-text")?.textContent?.trim()).slice(-limit).map(row => ({ id: row.dataset.messageId, self: self(row), text: textOf(row), ...(row.dataset.messageId === current?.inputSourceId ? { inputId: current.id } : {}) }));
  function publishHistory(force = false) {
    if (!watchOnline || location.href !== watch.url) return;
    const scroll = document.querySelector('[data-role="messages-scroll"]');
    const latest = !!scroll && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 80;
    const message = historyWatch.capture(snapshot(100), latest, force);
    if (message) { historyPending = message; post(message); }
    clearTimeout(historyRetry);
    if (historyPending) historyRetry = setTimeout(() => publishHistory(true), 5000);
  }
  function scheduleHistory() {
    if (!historyTimer && watchOnline) historyTimer = setTimeout(() => { historyTimer = undefined; publishHistory(); }, 200);
  }
  function flushNotifications() {
    if (watchOnline) for (const message of outbox.values()) post({ type: "notification", ...message });
  }
  function observeAll() {
    if (!watching || location.href !== watch.url) return;
    // The request's first reply is routed through dots.message only.
    observeReply(); scheduleHistory();
    for (const message of watch.scan(snapshot(), current?.sourceId ? [current.sourceId] : [])) {
      if ([...message.text].length > 24000) { console.warn("Dot notification exceeds the 24000-character limit"); continue; }
      outbox.set(message.sourceId, message);
      if (watchOnline) post({ type: "notification", ...message });
    }
  }
  function startWatch() {
    if (watching) return;
    watch.initialize(snapshot()); watch.url = location.href; watching = true;
    watchObserver = new MutationObserver(observeAll);
    document.addEventListener("scroll", scheduleHistory, { capture: true, passive: true });
    watchObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
  }
  function finish() { if (current) clearTimeout(current.timer); observer?.disconnect(); }
  function failure(reason, sent = current?.sent ?? false) {
    if (!current || current.finished) return;
    finish(); current.finished = true;
    post({ type: "failure", id: current.id, reason, sent });
  }
  function observeReply() {
    if (!current || current.finished || !current.sent) return;
    if (location.href !== current.url) { failure("Dot page changed during delivery"); return; }
    const fresh = rows().filter(row => !current.baseline.has(row.dataset.messageId));
    const ownRows = fresh.filter(self);
    if (ownRows.length > 1) { failure("Concurrent input in the same dot; reply cannot be correlated"); return; }
    const own = ownRows.find(row => textOf(row));
    if (!own || textOf(own).trim() !== current.text.trim()) return;
    current.inputSourceId = own.dataset.messageId;
    const reply = fresh.find(row => !self(row) && textOf(row)
      && (own.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (!reply) return;
    const text = textOf(reply);
    if ([...text].length > 24000) { failure("Dot reply exceeds bridge limit"); return; }
    current.sourceId = reply.dataset.messageId;
    watch.seen.add(current.sourceId); watch.pending.delete(current.sourceId);
    finish(); current.finished = true;
    post({ type: "reply", id: current.id, sourceId: current.sourceId, text, browserReplyMs: performance.now() - current.startedAt });
  }
  function input(job) {
    if (current) { post({ type: "failure", id: job.id, reason: "Browser already has a delivery", sent: false }); return; }
    current = { id: job.id, text: job.text, url: location.href, sent: false, finished: false };
    if (location.href !== job.url) { failure("The connected tab is no longer this dot", false); return; }
    if (typeof job.text !== "string" || !job.text.trim() || [...job.text].length > 12000) { failure("Invalid input", false); return; }
    const box = composer(), button = sendButton();
    if (!box || !button) { failure("Dot composer is not available; sign in and open your dot", false); return; }
    const draft = inputText(box);
    if (draft.trim()) { failure("The dot composer contains a draft; it was not overwritten", false); return; }
    current.baseline = new Set(rows().map(row => row.dataset.messageId));
    const sendIfReady = () => {
      if (!current || current.finished || current.sent) return;
      const actual = inputText(box), enabled = sendButton();
      if (actual.trim() !== job.text.trim() || !enabled || enabled.disabled
        || enabled.getAttribute("aria-disabled") === "true") return;
      clearTimeout(current.timer);
      current.startedAt = performance.now(); current.sent = true;
      current.timer = setTimeout(() => failure("Dot reply timed out"), 110000);
      enabled.click();
    };
    observer = new MutationObserver(() => current?.sent ? observeReply() : sendIfReady());
    observer.observe(document.body, { childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
    current.timer = setTimeout(() => failure("Composer did not accept input; nothing was sent", false), 3000);
    box.focus();
    if (box instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, job.text);
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: job.text }));
    } else {
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(box); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand("insertText", false, job.text);
    }
    // React may enable Send after a later render; observe that transition rather
    // than adding a fixed sleep or failing before the input handler has run.
    queueMicrotask(sendIfReady);
  }
  function connect() {
    try {
      if (!chrome.runtime?.id) return;
      port = chrome.runtime.connect({ name: "dots-page" });
    } catch { return; }
    port.onMessage.addListener(message => {
      if (message.type === "voice.command") void callControl.execute(message);
      else if (message.type === "job") input(message);
      else if (message.type === "watch-ready") { callControl.connected(); watchOnline = true; publishHistory(true); flushNotifications(); observeAll(); }
      else if (message.type === "history-accepted") { if (historyPending?.revision === message.revision) { historyPending = undefined; clearTimeout(historyRetry); } }
      else if (message.type === "history-error") { if (historyPending?.revision === message.revision) { historyPending = undefined; clearTimeout(historyRetry); } console.warn("Dot history sync: " + message.message); }
      else if (message.type === "notification-accepted") outbox.delete(message.sourceId);
      else if (message.type === "accepted" && current?.id === message.id) { finish(); current = null; }
      else if (message.type === "error") { watchOnline = false; clearTimeout(historyTimer); historyTimer = undefined; clearTimeout(historyRetry); finish(); current = null; }
    });
    port.onDisconnect.addListener(() => {
      callControl.disconnect();
      watchOnline = false; clearTimeout(historyTimer); historyTimer = undefined; clearTimeout(historyRetry); finish(); current = null; clearInterval(readyTimer);
      try { void chrome.runtime.lastError; if (!chrome.runtime.id) return; } catch { return; }
      retry = setTimeout(connect, 5000);
    });
    const ready = () => { if (composer() && sendButton() && rows().length) { clearInterval(readyTimer); startWatch(); post({ type: "ready" }); } };
    readyTimer = setInterval(ready, 1000); ready();
  }
  addEventListener("pagehide", () => {
    callControl.close();
    finish(); watchObserver?.disconnect(); clearTimeout(historyTimer); clearTimeout(historyRetry); document.removeEventListener("scroll", scheduleHistory, true); clearTimeout(retry); clearInterval(readyTimer);
    try { port?.disconnect(); } catch { /* Extension was reloaded or removed. */ }
  });
  connect();
})();
