import { describe, expect, it } from "vitest";
import { DotsModel, type DotMessage } from "../dots-phone-g2/src/model";
import { DEFAULT_PREFERENCES, decodePreferences } from "../dots-phone-g2/src/preferences";
import { HISTORY_LIMITS } from "../dots-phone-g2/src/history-limit";

const messages = (count = 100): DotMessage[] => Array.from({ length: count }, (_, index) => ({
  id: `message-${index + 1}`, sequence: index + 1, text: `返答 ${index + 1}`, receivedAt: index + 1,
}));
const restored = (history = messages()) => new DotsModel({ cursor: history.length, initialized: true, history, seen: history.map(item => item.id) });

describe("configurable visible history", () => {
  it.each(HISTORY_LIMITS)("limits browsing to the latest %i messages without discarding retained history", limit => {
    const model = restored(); model.setHistoryLimit(limit);
    expect(model.historyLimit).toBe(limit); expect(model.messageCount).toBe(limit);
    expect(model.visibleHistory.map(item => item.id)).toEqual(messages().slice(-limit).map(item => item.id));
    expect(model.heading).toBe(`dot ${limit}/${limit}`); expect(model.canNewer).toBe(false);
    for (let i = 0; i < 110; i++) model.scroll(1);
    expect(model.selectedId).toBe(`message-${101 - limit}`); expect(model.messageIndex).toBe(0);
    expect(model.canOlder).toBe(false); expect(model.heading).toBe(`dot 1/${limit}`);
    model.select("message-1"); expect(model.selectedId).toBe(`message-${101 - limit}`);
    for (let i = 0; i < 110; i++) model.scroll(-1);
    expect(model.selectedId).toBe("message-100"); expect(model.canNewer).toBe(false);
    expect(model.save().history).toHaveLength(100); expect(model.save().cursor).toBe(100);
  });
  it("keeps a visible selection and its page, clamps an excluded selection, and restores the wider range", () => {
    const history = messages(); history[94]!.text = Array.from({ length: 12 }, (_, i) => `長い返答 ${i}`).join("\n");
    const model = restored(history); model.select("message-95"); model.scroll(-1); const page = model.viewport.page;
    model.setHistoryLimit(10); expect(model.selectedId).toBe("message-95"); expect(model.viewport.page).toBe(page);
    model.setHistoryLimit(100); model.select("message-20"); model.setHistoryLimit(30);
    expect(model.selectedId).toBe("message-71"); expect(model.messageIndex).toBe(0); expect(model.viewport.page).toBe(1);
    model.setHistoryLimit(100); expect(model.selectedId).toBe("message-71"); expect(model.messageCount).toBe(100);
    model.select("message-20"); expect(model.selectedId).toBe("message-20");
  });
  it("preserves all pages of the oldest visible message before stopping navigation", () => {
    const history = messages(); history[90]!.text = Array.from({ length: 12 }, (_, i) => `ページ ${i}`).join("\n");
    const model = restored(history); model.setHistoryLimit(10); model.select("message-91", false);
    expect(model.viewport.pages).toBe(3); expect(model.viewport.page).toBe(3);
    model.scroll(1); expect(model.viewport.page).toBe(2); expect(model.canOlder).toBe(true);
    model.scroll(1); expect(model.viewport.page).toBe(1); expect(model.canOlder).toBe(false);
    model.scroll(1); expect(model.selectedId).toBe("message-91"); expect(model.viewport.page).toBe(1);
    model.scroll(-1); expect(model.viewport.page).toBe(2);
  });
  it("keeps selection inside a moving display window and follows a notification that wakes the glasses", () => {
    const model = restored(); model.setHistoryLimit(10); model.select("message-91");
    model.incoming({ id: "message-101", sequence: 101, text: "新着", receivedAt: 101 });
    expect(model.selectedId).toBe("message-92"); expect(model.messageIndex).toBe(0);
    expect(model.visibleHistory).toHaveLength(10); expect(model.history).toHaveLength(100); expect(model.unread).toBe(1);
    model.sleepDisplay();
    model.incoming({ id: "message-102", sequence: 102, text: Array.from({ length: 8 }, (_, i) => `最新 ${i}`).join("\n"), receivedAt: 102 });
    expect(model.awake).toBe(true); expect(model.selectedId).toBe("message-102"); expect(model.viewport.page).toBe(1);
    expect(model.messageIndex).toBe(9); expect(model.unread).toBe(0);
  });
  it("preserves an unsent ASR result and its page when the history setting changes", () => {
    const model = restored(); model.select("message-20"); model.inputMode = "text";
    model.transcript = Array.from({ length: 12 }, (_, i) => `認識結果 ${i}`).join("\n");
    model.pendingTranscript = true; model.setActivity("reviewing"); model.scroll(1);
    const page = model.viewport.page; model.setHistoryLimit(10);
    expect(model.selectedId).toBe("message-91"); expect(model.pendingTranscript).toBe(true);
    expect(model.activity).toBe("reviewing"); expect(model.viewport.page).toBe(page); expect(model.heading).toContain("ASR確認");
  });
  it("bounds the visible count when fewer replies have been received and accepts an empty inbox", () => {
    const model = restored(messages(3)); model.setHistoryLimit(10);
    expect(model.messageCount).toBe(3); expect(model.heading).toBe("dot 3/3");
    const empty = new DotsModel(); empty.setHistoryLimit(10);
    expect(empty.visibleHistory).toEqual([]); expect(empty.messageCount).toBe(0); expect(empty.messageIndex).toBe(-1);
    empty.select("missing"); empty.scroll(1); empty.scroll(-1); expect(empty.selectedId).toBeUndefined();
  });
  it("fills legacy preferences with 100 and rejects unsupported saved values", () => {
    expect(DEFAULT_PREFERENCES.historyLimit).toBe(100); expect(decodePreferences({ inputMode: "phone" })?.historyLimit).toBe(100);
    for (const value of [undefined, null, "10", 0, 25, 1000]) {
      expect(decodePreferences({ historyLimit: value })?.historyLimit).toBe(100);
      const model = restored(); model.setHistoryLimit(value); expect(model.historyLimit).toBe(100);
    }
  });
});
