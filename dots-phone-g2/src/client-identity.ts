/** Per-WebView identity; separate clients cannot reclaim each other's call. */
export function voiceResumeKey(storage: Pick<Storage, "getItem" | "setItem"> | undefined, random = (bytes: Uint8Array) => crypto.getRandomValues(bytes)): string {
  const name = "dots-phone-g2.voice-resume.v1";
  try { const saved = storage?.getItem(name); if (saved && /^[a-f0-9]{64}$/.test(saved)) return saved; } catch { /* Storage may be disabled. */ }
  const bytes = random(new Uint8Array(32));
  const key = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  try { storage?.setItem(name, key); } catch { /* In-memory socket reconnect still works. */ }
  return key;
}
