export const HISTORY_LIMITS = [10, 30, 50, 100] as const;
export type HistoryLimit = typeof HISTORY_LIMITS[number];
export function historyLimit(value: unknown): HistoryLimit {
  return HISTORY_LIMITS.includes(value as HistoryLimit) ? value as HistoryLimit : 100;
}
