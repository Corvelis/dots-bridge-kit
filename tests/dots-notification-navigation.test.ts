import { describe, expect, it } from "vitest";
import { DotsModel } from "../dots-phone-g2/src/model";
import { dotsTexts } from "../dots-phone-g2/src/glasses";

function readingHistory() {
  const model = new DotsModel();
  model.incoming({ id: "old", sequence: 1, text: "古い文章。".repeat(80), receivedAt: 1 });
  model.incoming({ id: "previous", sequence: 2, text: "前の新着", receivedAt: 2 });
  model.select("old", false);
  expect(model.viewport.pages).toBeGreaterThan(1);
  return model;
}
describe("notification navigation on automatic wake", () => {
  it.each(["inbox", "text"])("shows the newest %s message from page one when waking from history", route => {
    const model = readingHistory(), text = "新着の最初です。\n" + "続きの文章。".repeat(100);
    model.sleepDisplay();
    if (route === "inbox") model.incoming({ id: "new", sequence: 3, text, receivedAt: 3 });
    else model.textReply("new", text, 3);
    expect(model.awake).toBe(true); expect(model.selectedId).toBe("new");
    expect(model.viewport.pages).toBeGreaterThan(1); expect(model.viewport.page).toBe(1);
    expect(model.viewport.text).toContain("新着の最初です。");
    expect(dotsTexts(model).some(item => item.content.includes("新着の最初です。"))).toBe(true);
  });
  it("preserves the message and page the user is reading while already awake", () => {
    const model = readingHistory(), offset = model.offset;
    model.incoming({ id: "new", sequence: 3, text: "新着", receivedAt: 3 });
    expect(model.selectedId).toBe("old"); expect(model.offset).toBe(offset);
  });
  it("keeps history and position when manually waking without a new notification", () => {
    const model = readingHistory(), offset = model.offset; model.sleepDisplay(); model.toggleDisplay();
    expect(model.selectedId).toBe("old"); expect(model.offset).toBe(offset);
  });
  it("does not wake or jump on silent historical sync or duplicate delivery", () => {
    const model = readingHistory(), offset = model.offset;
    model.sleepDisplay(); model.incoming({ id: "retained", sequence: 3, text: "履歴", receivedAt: 3 }, false);
    model.incoming({ id: "previous", sequence: 2, text: "前の新着", receivedAt: 2 });
    expect(model.awake).toBe(false); expect(model.selectedId).toBe("old"); expect(model.offset).toBe(offset);
  });
  it("does not jump on audio-only wake or when automatic wake is disabled", () => {
    const model = readingHistory(), offset = model.offset;
    model.sleepDisplay(); model.wakeFromDot(); expect(model.selectedId).toBe("old"); expect(model.offset).toBe(offset);
    model.sleepDisplay(); model.wakeOnIncoming = false;
    model.incoming({ id: "new", sequence: 3, text: "新着", receivedAt: 3 });
    expect(model.awake).toBe(false); expect(model.selectedId).toBe("old");
  });
});
