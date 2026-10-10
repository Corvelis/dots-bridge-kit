import { OsEventTypeList, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { GestureRouter, gestureEventType, glassesSide, inputDevice, type GlassesSide } from "../../src/gestures";
import { PTT_MAX_HOLD_MS } from "./push-to-talk";
import { DOTS_MENU_ITEM_ID } from "./menu";

/** While blank, only wake and PTT on this client's active call are accepted. */
export class DotsControls {
  private gestures: GestureRouter;
  private modeHeldUntil = new Map<string, number>();
  private taps = new Map<string, number>();
  private releases = new Map<string, number>();
  private menuHolds = new Set<string>();
  private doubles = new Map<string, number>();
  private pttHolds = new Set<string>();
  private reviewHeldUntil = 0;
  private reviewHeldSource?: string;
  private reviewReleasedUntil = 0;
  private reviewDoubleUntil = 0;
  constructor(private callbacks: {
    awake(): boolean; ownedCall(): boolean; canEndCall(): boolean; endCall(): void; screenSide?(): GlassesSide;
    reviewingAsr?(): boolean;
    switchMode(): void; discardAsr(): void; submitAsr(): void;
    doubleTap(): void; tap(): void; scroll(delta: number): void;
    hold(source: string): void; release(source: string): void;
  }, private now = () => Date.now()) {
    const tap = (source: string, side?: GlassesSide) => {
      if (this.now() - (this.releases.get(source) ?? -Infinity) < 900) return;
      this.taps.set(source, this.now());
      if (callbacks.awake() && (!side || side !== this.screenSide())) callbacks.tap();
    };
    this.gestures = new GestureRouter({
      onG2SingleTap: side => tap(`g2-${side || "both"}`, side), onR1Tap: () => tap("r1"),
      onG2DoubleTap: side => this.doubleTap("g2", side), onR1DoubleTap: () => this.doubleTap("r1"),
      onG2LongPress: side => {
        const source = `g2-${side || "both"}`;
        if (this.now() < this.reviewHeldUntil || this.now() < this.reviewReleasedUntil) return;
        if (this.isMenuHold(source)) return;
        // A mode-switch hold keeps its role until release, even if the display
        // sleeps or the side preference changes before the next repeat event.
        if (this.now() < (this.modeHeldUntil.get(source) ?? 0)) return;
        // A recording hold must not accept the draft produced by its own stop.
        if (this.pttHolds.has(source)) { this.hold(source); return; }
        if (this.submitReview(source)) return;
        if (side === this.screenSide()) this.modeHeldUntil.set(source, this.now() + PTT_MAX_HOLD_MS);
        if (callbacks.awake() && side === this.screenSide()) callbacks.switchMode();
        else { if (callbacks.awake() || callbacks.ownedCall()) this.pttHolds.add(source); this.hold(source); }
      },
      onG2LongPressRelease: side => this.release(`g2-${side || "both"}`),
      onR1LongPress: () => {
        if (this.now() < this.reviewHeldUntil || this.now() < this.reviewReleasedUntil || this.isMenuHold("r1")) return;
        if (this.pttHolds.has("r1")) { this.hold("r1"); return; }
        if (this.submitReview("r1")) return;
        if (callbacks.awake() || callbacks.ownedCall()) this.pttHolds.add("r1");
        this.hold("r1");
      }, onR1LongPressRelease: () => this.release("r1"),
      onR1Scroll: delta => { if (callbacks.awake()) callbacks.scroll(delta); },
    }, now);
  }
  private doubleTap(device: "g2" | "r1", side?: GlassesSide): void {
    const reviewing = this.reviewingAsr();
    // A ring double can also arrive in a source-less envelope. Suppress its
    // echo across both device classifications after the draft is discarded.
    if (this.now() < this.reviewDoubleUntil) return;
    // Only an explicitly identified right temple can end a call. Waking a
    // blank display takes priority, and ring/source-less doubles retain their role.
    const ending = device === "g2" && side === "right" && this.callbacks.awake() && this.callbacks.canEndCall();
    if (!reviewing && !ending && side && side !== this.screenSide()) return;
    // Share suppression across ending/waking so a mirrored double cannot
    // become a display toggle while the stop request is in flight.
    if (this.now() - (this.doubles.get(device) ?? -Infinity) < 900) return;
    this.doubles.set(device, this.now()); this.taps.clear();
    if (reviewing) {
      this.reviewReleasedUntil = this.reviewDoubleUntil = this.now() + 900;
      this.callbacks.discardAsr();
    } else if (ending) this.callbacks.endCall(); else this.callbacks.doubleTap();
  }
  private reviewingAsr(): boolean { return this.callbacks.awake() && !this.callbacks.ownedCall() && this.callbacks.reviewingAsr?.() === true; }
  private submitReview(source: string): boolean {
    if (!this.reviewingAsr()) return false;
    // Keep the send role until release, after submit clears the draft. Repeats
    // from either G2 or R1 cannot start PTT or change mode for the same hold.
    this.reviewHeldUntil = this.now() + PTT_MAX_HOLD_MS;
    this.reviewHeldSource = source;
    this.callbacks.submitAsr(); return true;
  }
  private screenSide(): GlassesSide { return this.callbacks.screenSide?.() ?? "right"; }
  private isMenuHold(source: string): boolean {
    // Tap -> hold is reserved by Even OS for its contextual menu on G2/R1.
    if (this.menuHolds.has(source)) return true;
    if (this.now() - (this.taps.get(source) ?? -Infinity) >= 1800) return false;
    this.menuHolds.add(source); return true;
  }
  private release(source: string): void {
    this.releases.set(source, this.now()); this.taps.delete(source);
    this.menuHolds.delete(source); this.modeHeldUntil.delete(source);
    this.pttHolds.delete(source);
    if (source === this.reviewHeldSource) {
      this.reviewHeldUntil = 0; this.reviewHeldSource = undefined;
      this.reviewReleasedUntil = this.now() + 900;
    }
    // Always forward release, even during a notification or OS menu.
    this.callbacks.release(source);
  }
  private hold(source: string): void { if (this.callbacks.awake() || this.callbacks.ownedCall()) this.callbacks.hold(source); }
  route(event: EvenHubEvent): void {
    if (event.menuItemClickEvent) {
      if (!this.callbacks.awake()) return;
      const id = event.menuItemClickEvent.itemID;
      if (id === DOTS_MENU_ITEM_ID.inputMode) this.callbacks.switchMode();
      else if (id === DOTS_MENU_ITEM_ID.discardAsr) this.callbacks.discardAsr();
      else if (id === DOTS_MENU_ITEM_ID.submitAsr) this.callbacks.submitAsr();
      return;
    }
    const side = glassesSide(event), type = gestureEventType(event);
    if (side && (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
      if (side !== this.screenSide() && this.callbacks.awake()) this.callbacks.scroll(type === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1);
      return;
    }
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      const device = inputDevice(event) === "r1" || !side && (event.textEvent || event.listEvent) ? "r1" : "g2";
      this.doubleTap(device, side); return;
    }
    this.gestures.route(event);
  }
  resetHolds(): void {
    this.modeHeldUntil.clear(); this.taps.clear(); this.releases.clear(); this.menuHolds.clear(); this.doubles.clear(); this.pttHolds.clear();
    this.reviewHeldUntil = 0; this.reviewHeldSource = undefined; this.reviewReleasedUntil = 0; this.reviewDoubleUntil = 0;
  }
  dispose(): void { this.gestures.dispose(); }
}
