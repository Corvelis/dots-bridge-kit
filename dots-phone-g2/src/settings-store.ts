export interface NativeSettingsStorage {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}
type BrowserStorage = Pick<Storage, "getItem" | "setItem">;
interface RecordValue<T> { savedAt: number; value: T }

/** The native app store survives replacement of the Even App WebView. */
export class SettingsStore<T> {
  restoreError?: unknown;
  private native?: NativeSettingsStorage;
  private revision = 0;
  private savedAt = 0;
  private value: T;
  private writes: Promise<void> = Promise.resolve();
  constructor(private key: string, defaults: T, private decode: (value: unknown) => T | undefined,
    private browser?: BrowserStorage, private now = () => Date.now(), private nativeKey = key) { this.value = defaults; }

  async load(native?: NativeSettingsStorage): Promise<T> {
    this.native = native;
    const revision = this.revision;
    let cached: RecordValue<T> | undefined;
    try { cached = this.parse(this.browser?.getItem(this.key)); } catch { /* Native storage can still work. */ }
    let stored: RecordValue<T> | undefined, nativeRead = false;
    if (native) {
      try { stored = this.parse(await native.getLocalStorage(this.nativeKey)); nativeRead = true; }
      catch (error) { this.restoreError = error; }
    }
    if (revision !== this.revision) return this.value;
    const selected = cached && (!stored || cached.savedAt > stored.savedAt) ? cached : stored;
    if (selected) {
      this.value = selected.value; this.savedAt = selected.savedAt;
      const serialized = JSON.stringify(selected);
      try { this.browser?.setItem(this.key, serialized); } catch { /* Native storage is the durable copy. */ }
      // Migrate existing WebView settings, but never overwrite an unread native store with defaults.
      if (native && nativeRead && selected === cached) {
        try { await this.writeNative(serialized); } catch (error) { this.restoreError = error; }
      }
    }
    return this.value;
  }

  async save(value: T): Promise<void> {
    this.value = value; this.revision++;
    this.savedAt = Math.max(this.now(), this.savedAt + 1);
    const serialized = JSON.stringify({ savedAt: this.savedAt, value });
    let cached = false;
    try { if (this.browser) { this.browser.setItem(this.key, serialized); cached = true; } } catch { /* Try native storage. */ }
    if (this.native) await this.writeNative(serialized);
    else if (!cached) throw new Error("設定を保存できません。このスマホのストレージ設定を確認してください");
  }

  private writeNative(serialized: string): Promise<void> {
    const write = this.writes.catch(() => {}).then(async () => {
      if (!await this.native!.setLocalStorage(this.nativeKey, serialized)) throw new Error("Even Appに設定を保存できませんでした");
    });
    this.writes = write; return write;
  }
  private parse(serialized?: string | null): RecordValue<T> | undefined {
    if (!serialized) return;
    try {
      const record = JSON.parse(serialized);
      const envelope = record && typeof record === "object" && "savedAt" in record && "value" in record;
      const value = this.decode(envelope ? record.value : record);
      if (value !== undefined) return { savedAt: envelope && Number.isFinite(record.savedAt) ? record.savedAt : 0, value };
    } catch { /* Ignore malformed or obsolete settings. */ }
  }
}
