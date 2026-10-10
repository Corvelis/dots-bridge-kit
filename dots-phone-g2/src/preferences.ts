import { autoOffSeconds } from "./auto-off";
import { historyLimit, type HistoryLimit } from "./history-limit";
import type { InputMode } from "./model";
import type { GlassesSide } from "../../src/gestures";

export interface Preferences { historyLimit: HistoryLimit; animateCharacter: boolean; screenSide: GlassesSide; inputMode: InputMode; reviewTranscript: boolean; displayOffSeconds: number }
export const DEFAULT_PREFERENCES: Preferences = { historyLimit: 100, animateCharacter: false, screenSide: "right", inputMode: "text", reviewTranscript: false, displayOffSeconds: 30 };
export function decodePreferences(value: unknown): Preferences | undefined {
  if (!value || typeof value !== "object") return;
  const saved = value as Partial<Preferences>;
  if (!["historyLimit", "animateCharacter", "screenSide", "inputMode", "reviewTranscript", "displayOffSeconds"].some(key => key in saved)) return;
  return {
    historyLimit: historyLimit(saved.historyLimit),
    animateCharacter: saved.animateCharacter === true,
    screenSide: saved.screenSide === "left" ? "left" : "right",
    inputMode: saved.inputMode === "phone" ? "phone" : "text",
    reviewTranscript: saved.reviewTranscript === true,
    displayOffSeconds: autoOffSeconds(saved.displayOffSeconds),
  };
}
