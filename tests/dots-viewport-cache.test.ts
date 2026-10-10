import { afterEach, describe, expect, it, vi } from "vitest";
import { TextViewportCache, textViewport } from "../shared/display/text-viewport";
import { DotsModel } from "../dots-phone-g2/src/model";
import { dotsTexts } from "../dots-phone-g2/src/glasses";

afterEach(() => vi.unstubAllGlobals());
function countWrapping() {
  const NativeSegmenter = Intl.Segmenter, wraps = vi.fn();
  class CountedSegmenter extends NativeSegmenter {
    constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) { super(...args); wraps(); }
  }
  vi.stubGlobal("Intl", new Proxy(Intl, { get: (target, name) => name === "Segmenter" ? CountedSegmenter : Reflect.get(target, name) }));
  return wraps;
}
describe("bounded Dot page cache", () => {
  it("keeps Japanese wrapping and page boundaries when navigating cached text", () => {
    const layout = { columns: 32, bodyLines: 4 }, cache = new TextViewportCache(layout);
    for (const text of ["", "始まりです。\n\n「長い日本語の文章、読めますか？」🙂".repeat(30)]) {
      for (const offset of [0, 1, 2, 2000, -1]) expect(cache.get(text, offset)).toEqual(textViewport(text, layout, offset));
    }
  });
  it("wraps once per text and reuses it across page navigation", () => {
    const wraps = countWrapping(), cache = new TextViewportCache({ columns: 32, bodyLines: 4 });
    const first = cache.get("長い返答です。".repeat(100), 0);
    expect(cache.get("長い返答です。".repeat(100), 0)).toBe(first);
    for (let page = 0; page < 20; page++) cache.get("長い返答です。".repeat(100), page);
    expect(wraps).toHaveBeenCalledOnce();
    cache.get("新しい返答です。", 0); expect(wraps).toHaveBeenCalledTimes(2);
    cache.get("長い返答です。".repeat(100), 0); expect(wraps).toHaveBeenCalledTimes(3);
  });
  it("does not rewrap a long selected reply during wake and PTT state updates", () => {
    const wraps = countWrapping(), model = new DotsModel();
    model.incoming({ id: "long", text: "過去の長い返答です。".repeat(1000), sequence: 1, receivedAt: 1 });
    expect(wraps).toHaveBeenCalledOnce();
    for (let i = 0; i < 20; i++) {
      model.sleepDisplay(); model.wakeDisplay(); model.setActivity("arming"); model.setActivity("recording");
      dotsTexts(model); model.viewport.text; model.viewport.page; model.viewport.pages; model.canOlder; model.canNewer;
    }
    expect(wraps).toHaveBeenCalledOnce();
    model.textReply("long", "更新された本文"); expect(model.viewport.text).toBe("更新された本文");
    expect(wraps).toHaveBeenCalledTimes(2);
  });
  it("retains separate reply and ASR pages without letting their offsets affect each other", () => {
    const model = new DotsModel(); model.inputMode = "text";
    model.textReply("dot", "Dotからの返答です。".repeat(100)); const reply = model.viewport;
    model.transcript = "認識した文章です。".repeat(100); model.pendingTranscript = true;
    const transcript = model.viewport; model.asrOffset = 1; expect(model.viewport.page).toBe(transcript.pages - 1);
    model.pendingTranscript = false; expect(model.viewport).toBe(reply);
    model.pendingTranscript = true; expect(model.viewport.pages).toBe(transcript.pages);
    model.transcript = "新しい認識結果"; expect(model.viewport.text).toBe("新しい認識結果");
  });
});
