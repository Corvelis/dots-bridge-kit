import {
  CreateStartUpPageContainer, RebuildPageContainer, TextContainerProperty, TextContainerUpgrade,
  ImageContainerProperty, ImageRawDataUpdate, ImageRawDataUpdateResult, StartUpPageCreateResult,
  validateEvenHubPageContainer, formatEvenHubPageContainerValidationError,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { SerialOperationQueue } from "../../src/serial-operation-queue";
import { withFrameTimeout } from "../../src/frame-timeout";
import { DOT_SIZE, EYES, FIXED_DOT_POSE, dotGray4, dotGlassesPose } from "./avatar";
import { DotsModel } from "./model";
import type { DisplayTransfer } from "./power-diagnostics";
import { buildDotsMenu, dotsMenuKey } from "./menu";

export const DOT_X = 28, DOT_Y = 66;
export function dotsTexts(model: DotsModel) {
  return [
    { id: 21, name: "dotsHeader", x: 20, y: 8, w: 372, h: 30, content: model.linkHeading, z: 1 },
    { id: 27, name: "dotsHud", x: 400, y: 8, w: 156, h: 30, content: model.hud.text, z: 7 },
    { id: 24, name: "dotsStatus", x: 20, y: 218, w: 168, h: 30, content: model.connected ? `${model.status.code} · ${model.activity === "reviewing" ? "送信確認" : model.activity === "waiting" ? "返答待ち" : model.activity === "recognizing" ? "文字変換" : model.activity === "playing" ? "再生中" : model.activity === "arming" ? "マイク準備" : model.activity === "recording" ? "録音中" : model.activity === "ending" ? "終了中" : "待機"}` : "RELINK · 接続待ち", z: 4 },
    { id: 25, name: "dotsReply", x: 204, y: 52, w: 352, h: 180, content: `${model.heading}\n${model.viewport.text}`, z: 5 },
    { id: 26, name: "dotsFooter", x: 20, y: 252, w: 536, h: 30, content: model.footer, z: 6 },
  ];
}
export function buildDotsPage(model: DotsModel): RebuildPageContainer {
  if (!model.awake) return buildDotsSleepPage();
  return new RebuildPageContainer({
    containerTotalNum: 7,
    menuObject: buildDotsMenu(model),
    textObject: dotsTexts(model).map(t => new TextContainerProperty({
      containerID: t.id, containerName: t.name, xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
      content: t.content, zOrderIndex: t.z, isEventCapture: t.id === 25 ? 1 : 0,
      borderWidth: t.id === 25 ? 1 : 0, borderColor: 5, borderRadius: 12, paddingLength: t.id === 25 ? 8 : 0,
    })),
    imageObject: [
      new ImageContainerProperty({ containerID: 22, containerName: "dotsBody", xPosition: DOT_X, yPosition: DOT_Y, width: DOT_SIZE, height: DOT_SIZE, zOrderIndex: 2 }),
      new ImageContainerProperty({ containerID: 23, containerName: "dotsEyes", xPosition: DOT_X + EYES.x, yPosition: DOT_Y + EYES.y, width: EYES.width, height: EYES.height, zOrderIndex: 3 }),
    ],
  });
}
export function buildDotsSleepPage(): RebuildPageContainer {
  return new RebuildPageContainer({ containerTotalNum: 1, textObject: [new TextContainerProperty({
    containerID: 31, containerName: "dotsBlank", xPosition: 0, yPosition: 0, width: 576, height: 288,
    content: "", isEventCapture: 1, zOrderIndex: 1, borderWidth: 0,
  })] });
}

/** Text has priority over image animation. Epochs discard queued work from a previous power state. */
export class DotsGlasses {
  private queue = new SerialOperationQueue();
  private epoch = 0;
  private desiredAwake?: boolean;
  private appliedAwake?: boolean;
  private desiredMenu?: string;
  private appliedMenu?: string;
  private text = new Map<number, string>();
  private imageBusy = false;
  private mic = false;
  private inputPending = false;
  private overlay = false;
  private bodyPainted = false;
  private lastEyes?: Uint8Array;
  private retryAt = 0;
  private readonly bodyImage = dotGray4(FIXED_DOT_POSE);
  private readonly fixedEyes = dotGray4(FIXED_DOT_POSE, EYES);
  private animationEnabled?: boolean;
  private initialized = false;
  private pendingRenders = 0;
  constructor(private bridge: EvenAppBridge, private transfer?: (kind: DisplayTransfer, awake: boolean) => void) {}

  async initialize(model: DotsModel): Promise<void> {
    const page = buildDotsPage(model);
    const validation = validateEvenHubPageContainer(page);
    if (!validation.valid) throw new Error(formatEvenHubPageContainerValidationError(validation));
    this.transfer?.("page", model.awake);
    const result = await withFrameTimeout(this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page)), "Dots G2 startup", 8_000);
    if (result !== StartUpPageCreateResult.success && result !== StartUpPageCreateResult.invalid) throw new Error(`Dots G2 page creation failed (${result})`);
    this.setDesiredAwake(model.awake);
    this.desiredMenu = model.awake ? dotsMenuKey(model) : undefined;
    if (result === StartUpPageCreateResult.success) {
      this.appliedAwake = model.awake;
      this.appliedMenu = this.desiredMenu;
      for (const item of model.awake ? dotsTexts(model) : []) this.text.set(item.id, item.content);
    }
    this.initialized = true;
    await this.render(model);
  }
  setMicrophone(open: boolean): void { this.mic = open; }
  setInputPending(pending: boolean): void {
    if (this.inputPending === pending) return;
    this.inputPending = pending;
    if (pending) this.epoch++; // Discard queued images/text before the mic RPC.
  }
  setDesiredAwake(awake: boolean): void {
    if (this.desiredAwake !== awake) {
      this.desiredAwake = awake; this.epoch++;
    }
  }
  setOverlayVisible(visible: boolean): void {
    if (this.overlay === visible) return;
    this.overlay = visible;
    this.epoch++;
    if (!visible) this.appliedAwake = undefined;
  }
  restoreCapture(): void {
    if (this.overlay) return;
    this.epoch++; this.appliedAwake = undefined;
  }
  render(model: DotsModel): Promise<boolean> {
    const awake = model.awake;
    this.setDesiredAwake(awake);
    this.setAnimationEnabled(model.animateCharacter);
    const menu = awake ? dotsMenuKey(model) : undefined;
    if (this.desiredMenu !== menu) { this.desiredMenu = menu; this.epoch++; }
    if (!this.initialized || this.overlay || this.inputPending) return Promise.resolve(false);
    if (!awake && this.appliedAwake === false && !this.pendingRenders) return Promise.resolve(true);
    const epoch = this.epoch, page = buildDotsPage(model), texts = awake ? dotsTexts(model) : [];
    this.pendingRenders++;
    return this.queue.runPriority(async () => {
      if (!this.initialized || this.overlay || this.inputPending || epoch !== this.epoch) return false;
      if (this.appliedAwake !== awake || this.appliedMenu !== menu) {
        this.transfer?.("page", awake);
        const ok = await withFrameTimeout(this.bridge.rebuildPageContainer(page), "Dots G2 display", 8_000);
        if (!ok) throw new Error("Dots G2 display update failed");
        this.appliedAwake = awake; this.appliedMenu = menu; this.text.clear(); this.bodyPainted = false; this.lastEyes = undefined;
        for (const item of texts) this.text.set(item.id, item.content);
        if (this.inputPending || epoch !== this.epoch) return false;
      }
      if (!awake) return true;
      for (const item of texts) {
        if (this.inputPending || epoch !== this.epoch) return false;
        if (this.text.get(item.id) === item.content) continue;
        this.transfer?.("text", awake);
        const ok = await withFrameTimeout(this.bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: item.id, containerName: item.name, content: item.content,
        })), "Dots G2 message", 8_000);
        if (!ok) throw new Error("Dots G2 message update failed");
        this.text.set(item.id, item.content);
      }
      return epoch === this.epoch;
    }).finally(() => { this.pendingRenders--; });
  }
  async animate(model: DotsModel, time: number, energy: number): Promise<void> {
    this.setAnimationEnabled(model.animateCharacter);
    if (!this.initialized || this.overlay || !this.desiredAwake || !this.appliedAwake || this.inputPending || this.mic || this.imageBusy || time < this.retryAt) return;
    if (!model.animateCharacter && this.bodyPainted && this.lastEyes === this.fixedEyes) return;
    // Keep the 144×144 body stable; only the small eye patch animates. Periodic
    // whole-body transfers visibly refreshed the character in either mode.
    const eyes = model.animateCharacter ? dotGray4(dotGlassesPose(model.phase, time, energy), EYES) : this.fixedEyes;
    const eyesChanged = !this.lastEyes || eyes.some((value, i) => value !== this.lastEyes![i]);
    if (this.bodyPainted && !eyesChanged) { this.lastEyes = eyes; return; }
    const epoch = this.epoch;
    this.imageBusy = true;
    try {
      await this.queue.run(async () => {
        if (epoch !== this.epoch || this.inputPending || this.mic) return;
        if (!this.bodyPainted) {
          await this.image(22, "dotsBody", this.bodyImage);
          if (epoch !== this.epoch) return;
          this.bodyPainted = true;
        }
        if (epoch !== this.epoch || this.inputPending || this.mic) return;
        if (eyesChanged) {
          await this.image(23, "dotsEyes", eyes);
          if (epoch === this.epoch) this.lastEyes = eyes;
        }
      });
    } catch (error) { this.retryAt = time + 3; throw error; }
    finally { this.imageBusy = false; }
  }
  private setAnimationEnabled(enabled: boolean): void {
    if (this.animationEnabled === enabled) return;
    this.animationEnabled = enabled;
    this.epoch++; // Discard queued frames from the previous animation setting.
  }
  private async image(id: number, name: string, bytes: Uint8Array): Promise<void> {
    this.transfer?.("image", this.desiredAwake !== false);
    const result = await withFrameTimeout(this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: bytes })), "Dots G2 character", 8_000);
    if (result !== ImageRawDataUpdateResult.success) throw new Error(`Dots G2 image transfer failed (${result})`);
  }
}
