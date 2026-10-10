import {
  EventSourceType,
  OsEventTypeList,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

export type InputDevice = "g2" | "r1" | "unknown";
export type GlassesSide = "left" | "right";

export interface GestureCallbacks {
  onG2SingleTap(side?: GlassesSide): void;
  onG2DoubleTap(side?: GlassesSide): void;
  onR1Tap(): void;
  onR1DoubleTap(): void;
  onR1Scroll(delta: -1 | 1): void;
  onG2LongPress?(side?: GlassesSide): void;
  onG2LongPressRelease?(side?: GlassesSide): void;
  onR1LongPress?(): void;
  onR1LongPressRelease?(): void;
}

function normalizedNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

export function inputDevice(event: EvenHubEvent): InputDevice {
  return glassesSide(event) ? "g2" : inputSource(event) === EventSourceType.TOUCH_EVENT_FROM_RING ? "r1" : "unknown";
}

function inputSource(event: EvenHubEvent): EventSourceType | number | undefined {
  const raw = event.jsonData ?? {};
  const rawSource =
    event.sysEvent?.eventSource ??
    raw.eventSource ??
    raw.EventSource ??
    raw.Event_Source ??
    raw.event_source ??
    raw.source;
  const source = EventSourceType.fromJson(rawSource) ?? normalizedNumber(rawSource);
  return source;
}

export function glassesSide(event: EvenHubEvent): GlassesSide | undefined {
  const source = inputSource(event);
  if (source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) return "right";
  if (source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L) return "left";
  return undefined;
}

export function gestureEventType(event: EvenHubEvent): OsEventTypeList | undefined {
  const raw = event.jsonData ?? {};
  const envelopeType =
    event.sysEvent?.eventType ??
    event.textEvent?.eventType ??
    event.listEvent?.eventType;
  const rawType =
    envelopeType ??
    raw.eventType ??
    raw.EventType ??
    raw.Event_Type ??
    raw.event_type ??
    raw.type;
  const value = OsEventTypeList.fromJson(rawType) ?? normalizedNumber(rawType);
  if (value !== undefined) return value as OsEventTypeList;

  // CLICK_EVENT is protobuf enum value 0. Protobuf omits zero-valued fields,
  // so a real hardware single tap arrives with a sys/text/list envelope but
  // no eventType property. Only apply the CLICK fallback when an envelope is
  // actually present; otherwise unrelated/raw events would become taps.
  if (event.sysEvent || event.textEvent || event.listEvent) {
    return OsEventTypeList.CLICK_EVENT;
  }
  return undefined;
}

export class GestureRouter {
  private lastDiscreteDevice: InputDevice | `g2-${GlassesSide}` | undefined;
  private lastDiscreteAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly callbacks: GestureCallbacks,
    private readonly now: () => number = () => Date.now(),
  ) {}

  route(event: EvenHubEvent): void {
    const type = gestureEventType(event);
    let device = inputDevice(event);
    const side = glassesSide(event);
    // Ring clicks and sustained presses can arrive without EventSource. On
    // Even App 2.2.9, R1 LONG_PRESS events are delivered as source-less
    // sysEvent envelopes, while source-less clicks use text/list envelopes.
    // Keep the fallback narrow so unrelated system events do not become R1.
    if (
      device === "unknown" &&
      (
        ((event.textEvent || event.listEvent) && (
          type === OsEventTypeList.CLICK_EVENT
          || type === OsEventTypeList.DOUBLE_CLICK_EVENT
        ))
        || type === OsEventTypeList.LONG_PRESS_EVENT
        || type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT
      )
    ) {
      device = "r1";
    }
    // Even Hub currently reports both R1 and G2 scrolls as source-less
    // textEvent envelopes. Preserve R1 navigation until the host exposes a
    // scroll EventSource; this necessarily means G2 swipes follow it too.
    if (
      device === "unknown" &&
      (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT)
    ) {
      device = "r1";
    }

    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (this.suppressDuplicateDiscreteInput(device, side)) return;
      if (device === "r1") {
        this.callbacks.onR1DoubleTap();
      } else {
        // Some Even G2 firmware builds omit EventSource for glasses taps. Audio
        // events are removed before this router, so an explicit, non-R1 click is
        // safe to treat as G2 input.
        this.callbacks.onG2DoubleTap(side);
      }
      return;
    }

    if (type === OsEventTypeList.CLICK_EVENT) {
      if (this.suppressDuplicateDiscreteInput(device, side)) return;
      // Even OS already classifies CLICK and DOUBLE_CLICK as distinct events.
      // Dispatch single taps immediately: delaying them with a web timer is not
      // reliable in the Even Hub runtime, which virtualizes window timers.
      if (device === "r1") this.callbacks.onR1Tap();
      else this.callbacks.onG2SingleTap(side);
      return;
    }

    if (type === OsEventTypeList.LONG_PRESS_EVENT) {
      if (device === "r1") this.callbacks.onR1LongPress?.();
      else this.callbacks.onG2LongPress?.(side);
      return;
    }

    if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
      if (device === "r1") this.callbacks.onR1LongPressRelease?.();
      else this.callbacks.onG2LongPressRelease?.(side);
      return;
    }

    if (device === "r1" && type === OsEventTypeList.SCROLL_TOP_EVENT) {
      this.callbacks.onR1Scroll(-1);
    } else if (device === "r1" && type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      this.callbacks.onR1Scroll(1);
    }
  }

  dispose(): void {
    // No pending gesture work. Kept for the page lifecycle API.
  }

  private suppressDuplicateDiscreteInput(device: InputDevice, side?: GlassesSide): boolean {
    // One physical G2 temple press is occasionally delivered once per glasses
    // side. The second CLICK can arrive after voice.start has completed and
    // would therefore immediately stop the recording it just started. R1 can
    // exhibit the same mirrored delivery, so coalesce per-device presses.
    const now = this.now();
    const discreteDevice = side ? (`g2-${side}` as const) : device;
    const duplicate = discreteDevice === this.lastDiscreteDevice && now - this.lastDiscreteAt < 900;
    if (!duplicate) {
      this.lastDiscreteDevice = discreteDevice;
      this.lastDiscreteAt = now;
    }
    return duplicate;
  }
}
