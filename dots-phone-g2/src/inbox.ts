import { DotsModel, type DotMessage } from "./model";
import { PhoneSocket } from "./socket";
/** First installation baselines retained history; subsequent missed messages can wake. */
export async function synchronizeInbox(socket: Pick<PhoneSocket, "request">, model: DotsModel, changed: () => void, conversation = false): Promise<void> {
  let wake = model.initialized;
  if (conversation) {
    try {
      const snapshot = await socket.request("history/sync", {});
      if (!model.orderedHistory) wake = false; // Migration is baseline, never speech/wake.
      model.applyConversation(snapshot); changed();
    } catch (error) { if (!String(error).includes("Unsupported dots method")) throw error; }
  }
  let restarted = false, includeInputs = true;
  for (let page = 0; page < 64; page++) {
    let result: { items: DotMessage[]; nextCursor: number; hasMore: boolean; gap: boolean };
    try { result = await socket.request("notification/sync", { after: model.cursor, limit: 100, ...(includeInputs ? { includeInputs: true } : {}) }); }
    catch (error) {
      if (includeInputs && String(error).includes("Unsupported parameter")) { includeInputs = false; continue; }
      if (!restarted && model.cursor > 0 && String(error).includes("cursor")) { model.cursor = 0; restarted = true; continue; }
      throw error;
    }
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.nextCursor) || result.nextCursor < 0) throw new Error("通知の同期結果が不正です");
    for (const item of result.items) model.incoming(item, wake);
    model.cursor = result.nextCursor;
    if (result.gap) model.notice = "保存期間を過ぎたメッセージがあります";
    if (!result.hasMore) { model.initialized = true; changed(); return; }
    changed();
  }
  throw new Error("通知の同期が完了しませんでした");
}
