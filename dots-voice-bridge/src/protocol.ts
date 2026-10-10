export const VOICE_PROTOCOL = 1;
export type CallState = "idle" | "connecting" | "active" | "unknown";
export interface CallSnapshot {
  state: CallState;
  url: string;
  ownedSession: string | null;
  muted: boolean | null;
}
export type CallAction = "status" | "prepare" | "start" | "stop";
export interface CallController {
  readonly online: boolean;
  command(action: CallAction, sessionId?: string): Promise<CallSnapshot>;
}
export interface AudioRoute {
  prepare(onAudio: (pcm: Buffer) => void, signal: AbortSignal): Promise<void>;
  append(pcm: Buffer): void | boolean;
  restart?(onAudio: (pcm: Buffer) => void, signal: AbortSignal): Promise<void>;
  stop(restoreInput: boolean): Promise<void>;
  readonly heldInput: boolean;
}
export function secretMatches(expected: string, actual: unknown): boolean {
  // Credentials have fixed, high entropy lengths. Compare all bytes.
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}
export function parseSnapshot(value: unknown, url: string): CallSnapshot {
  if (!value || typeof value !== "object") throw new Error("Invalid call state");
  const state = value as CallSnapshot;
  if (state.url !== url || !["idle", "connecting", "active", "unknown"].includes(state.state)
    || !(state.ownedSession === null || typeof state.ownedSession === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(state.ownedSession))
    || !(state.muted === null || typeof state.muted === "boolean")) throw new Error("Invalid call state or wrong dot");
  return { state: state.state, url, ownedSession: state.ownedSession, muted: state.muted };
}
