import { DotsModel, type InputMode } from "./model";

/** One transaction for phone buttons, the right temple and the OS menu. */
export class InputModeSwitch {
  busy = false;
  constructor(private model: DotsModel, private host: {
    phase(): string; starting(): boolean; canStopCall(): boolean;
    stopCall(): Promise<void>; clearInputs(): Promise<void>; cancelText(): void;
    committed(): void; changed(): void;
  }) {}
  canSet(mode: InputMode): boolean {
    if (this.busy || this.host.starting()) return false;
    if (mode === this.model.inputMode) return true;
    const phase = this.host.phase();
    return phase === "idle" || mode === "text" && (phase === "active" || phase === "needs-stop") && this.host.canStopCall();
  }
  async set(mode: InputMode): Promise<void> {
    if (!this.canSet(mode)) throw new Error("自分の通話の接続・終了処理が完了してから切り替えてください");
    if (mode === this.model.inputMode) return;
    this.busy = true; this.model.setActivity("switching"); this.host.changed();
    try {
      this.host.cancelText();
      await this.host.clearInputs();
      if (this.host.phase() !== "idle") await this.host.stopCall();
      if (this.host.phase() !== "idle") throw new Error("通話の終了を確認できません。接続状態を確認してください");
      this.model.inputMode = mode;
      this.host.committed();
    } catch (error) { this.model.setActivity("error"); throw error; }
    finally { this.busy = false; this.host.changed(); }
  }
}
