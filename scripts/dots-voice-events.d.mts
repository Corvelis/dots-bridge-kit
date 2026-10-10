export type VoiceEventFields = Record<string, string | number | boolean | null | undefined>;
export function createVoiceEventRecorder(path?: string): (event: string, detail?: VoiceEventFields) => void;
export const recordVoiceEvent: (event: string, detail?: VoiceEventFields) => void;
