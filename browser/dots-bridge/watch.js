// Pure DOM-snapshot tracker; it neither reads credentials nor sends requests.
globalThis.DotsMessageWatch = class {
  seen = new Set();
  pending = new Set();
  tail = null;
  initialize(rows) {
    this.seen = new Set(rows.map(row => row.id));
    this.tail = rows.at(-1)?.id ?? null;
  }
  scan(rows, claimed = []) {
    for (const id of claimed) { this.seen.add(id); this.pending.delete(id); }
    const anchor = rows.findIndex(row => row.id === this.tail);
    // Older history loaded by scrolling is not a new notification. If the
    // anchor is virtualized away, wait until it is visible again.
    if (anchor >= 0 || this.tail === null) {
      for (const row of rows.slice(anchor + 1)) if (!this.seen.has(row.id)) this.pending.add(row.id);
      this.tail = rows.at(-1)?.id ?? this.tail;
    }
    const found = [];
    for (const row of rows) {
      if (!this.pending.has(row.id) || this.seen.has(row.id)) continue;
      if (!row.text) continue;
      this.pending.delete(row.id); this.seen.add(row.id);
      found.push({ sourceId: row.id, text: row.text, ...(row.self ? { role: "user", ...(row.inputId ? { inputId: row.inputId } : {}) } : {}) });
    }
    while (this.seen.size > 8192) this.seen.delete(this.seen.values().next().value);
    return found;
  }
};

// Ordered history is separate from new-message notifications: baselines and
// scrolling must never trigger TTS or be mistaken for a new Dot message.
globalThis.DotsHistoryWatch = class {
  signature = "";
  revision = 0;
  capture(rows, latest, force = false) {
    const items = rows.filter(row => row.id && row.text?.trim() && [...row.text].length <= 24000).slice(-100)
      .map(row => ({ sourceId: row.id, text: row.text, role: row.self ? "user" : "assistant", ...(row.self && row.inputId ? { inputId: row.inputId } : {}) }));
    // Drop whole oldest messages, never truncate their bodies or reverse order.
    const encoder = new TextEncoder();
    let size = 2, start = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      size += encoder.encode(JSON.stringify(items[i])).length + 1;
      if (size > 232 * 1024) { start = i + 1; break; }
    }
    const window = items.slice(start);
    if (!window.length || new Set(window.map(row => row.sourceId)).size !== window.length) return null;
    const signature = JSON.stringify({ items: window, latest });
    if (!force && signature === this.signature) return null;
    this.signature = signature;
    return { type: "history", revision: ++this.revision, latest, items: window };
  }
};
