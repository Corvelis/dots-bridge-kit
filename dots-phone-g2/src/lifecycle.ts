import { OsEventTypeList } from "@evenrealities/even_hub_sdk";

/** FOREGROUND means the glasses' OS overlay, not the phone WebView visibility. */
export class OverlayLifecycle {
  visible = false;
  private blockedUntil = 0;
  constructor(private callbacks: { overlay(visible: boolean): void; resume(): void }, private now = () => Date.now()) {}
  handle(type: OsEventTypeList | undefined): boolean {
    if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      this.visible = true; this.callbacks.overlay(true); return true;
    }
    if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      this.visible = false; this.blockedUntil = this.now() + 400;
      this.callbacks.overlay(false); this.callbacks.resume(); return true;
    }
    return false;
  }
  accepts(type: OsEventTypeList | undefined): boolean {
    // A notification must not end a held PTT, but its physical release must
    // still close the mic while the OS owns the screen (and during the grace).
    return type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT || this.acceptsGesture;
  }
  get acceptsGesture(): boolean { return !this.visible && this.now() >= this.blockedUntil; }
}
