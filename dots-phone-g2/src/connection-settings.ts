export interface ConnectionSettings { voiceUrl: string; inboxUrl: string; textVoiceUrl: string; token: string }
export const CONNECTION_SETTINGS_KEY = "dots-bridge-kit.connection.v1";
const key = CONNECTION_SETTINGS_KEY;
export function decodeConnection(value: unknown): ConnectionSettings | undefined {
  try { if (value && typeof value === "object") return validateConnection(value as ConnectionSettings); } catch { /* Ignore incomplete settings. */ }
}
export function connectionEndpoints(base: string): Omit<ConnectionSettings, "token"> {
  const url = new URL(base.trim());
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Macの接続先を ws://YOUR_MAC_HOST:8799 の形式で入力してください");
  }
  const origin = url.origin.replace(/^http/, "ws");
  return { voiceUrl: origin + "/voice/ws", inboxUrl: origin + "/dots/ws", textVoiceUrl: origin + "/ws" };
}
export function connectionFromBaseUrl(base: string, token: string): ConnectionSettings {
  return validateConnection({ ...connectionEndpoints(base), token });
}
export function validateConnection(value: ConnectionSettings): ConnectionSettings {
  const paths = { voiceUrl: "/voice/ws", inboxUrl: "/dots/ws", textVoiceUrl: "/ws" } as const;
  for (const field of Object.keys(paths) as Array<keyof typeof paths>) {
    const url = new URL(value[field]);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== paths[field]) {
      throw new Error("接続先URLの形式を確認してください");
    }
  }
  if (!/^[a-f0-9]{64}$/.test(value.token.trim())) throw new Error("Macで生成した64文字のペアリングトークンを入力してください");
  return { ...value, token: value.token.trim() };
}
export function loadConnection(defaults: ConnectionSettings, storage?: Pick<Storage, "getItem">): ConnectionSettings {
  try {
    const saved = JSON.parse(storage?.getItem(key) || "null");
    if (saved) return validateConnection(saved.value ?? saved);
  } catch { /* An incomplete setup falls back to the package's endpoints. */ }
  return defaults;
}
export function saveConnection(value: ConnectionSettings, storage: Pick<Storage, "setItem">): void {
  storage.setItem(key, JSON.stringify(validateConnection(value)));
}
