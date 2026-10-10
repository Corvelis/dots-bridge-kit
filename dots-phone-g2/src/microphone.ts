import type { PcmStreamPlayer } from "../../shared/audio/pcm-player";

export type MicrophoneRoute = "phone" | "text";

/** A foreground/overlay recovery must retain duplex playback during native input. */
export function restorePhonePlayback(
  player: Pick<PcmStreamPlayer, "resumeDuringRecording" | "restoreBackgroundPlayback">,
  route?: MicrophoneRoute,
): void {
  if (route === "phone") player.resumeDuringRecording();
  else player.restoreBackgroundPlayback();
}

/** One native source shared by two independently asynchronous PTT controllers. */
export class OwnedMicrophone {
  private owner?: MicrophoneRoute;
  private work: Promise<unknown> = Promise.resolve();
  constructor(private control: (enabled: boolean, route: MicrophoneRoute) => Promise<void>) {}
  // Includes a pending native open/close, before PTT can report recording.
  get activeRoute(): MicrophoneRoute | undefined { return this.owner; }
  /** Repair an unowned native stream without racing a queued PTT open. */
  closeIfIdle(route: MicrophoneRoute, canClose: () => boolean): Promise<boolean> {
    const operation = this.work.catch(() => {}).then(async () => {
      if (!canClose()) return false;
      await this.control(false, this.owner ?? route);
      this.owner = undefined;
      return true;
    });
    this.work = operation; return operation;
  }
  set(enabled: boolean, route: MicrophoneRoute): Promise<void> {
    const operation = this.work.catch(() => {}).then(async () => {
      if (enabled) {
        if (this.owner && this.owner !== route) throw new Error("別の入力方法がG2マイクを使用中です");
        // Retain ownership after a failed open so its controller can close it.
        this.owner = route;
      } else if (this.owner !== route) return;
      await this.control(enabled, route);
      if (!enabled) this.owner = undefined;
    });
    this.work = operation; return operation;
  }
}
