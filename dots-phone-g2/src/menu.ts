import { MenuContainerProperty, MenuItemProperty } from "@evenrealities/even_hub_sdk";
import type { DotsModel } from "./model";

export const DOTS_MENU_ITEM_ID = { inputMode: 301, discardAsr: 303, submitAsr: 304 } as const;
export function dotsMenuKey(model: DotsModel): string { return `${model.inputMode}:${model.pendingTranscript}`; }
export function buildDotsMenu(model: DotsModel): MenuContainerProperty {
  return new MenuContainerProperty({ menuItems: [
    new MenuItemProperty({ itemID: DOTS_MENU_ITEM_ID.inputMode, itemName: model.inputMode === "phone" ? "テキストDotへ" : "電話へ" }),
    ...(model.pendingTranscript ? [
      new MenuItemProperty({ itemID: DOTS_MENU_ITEM_ID.submitAsr, itemName: "Dotに送信" }),
      new MenuItemProperty({ itemID: DOTS_MENU_ITEM_ID.discardAsr, itemName: "ASR結果を破棄" }),
    ] : []),
  ] });
}
