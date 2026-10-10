import type { EchoPhase } from "../../shared/protocol";

// Adapted from the round Dot renderer for M5Stack StopWatch.
// Preserve the round body, eye proportions, mouthless face, and soft movement.
export const DOT_SIZE = 144;
export const EYES = { x: 28, y: 24, width: 88, height: 64 } as const;
export interface DotPose { x: number; y: number; sx: number; sy: number; angle: number; gazeX: number; gazeY: number; eyeOpen: number }
export function dotPose(phase: EchoPhase, time: number, energy = 0): DotPose {
  const breath = Math.sin(time * Math.PI * 2 / 5.2) * .008;
  const talk = phase === "speaking" ? Math.max(0, Math.min(1, energy)) : 0;
  const direction = Math.sin(time * 1.8);
  const thinking = phase === "thinking" || phase === "transcribing";
  const blinkPhase = ((time + 1.6) % 4.7) / .22;
  const blink = blinkPhase < 1 ? 1 - Math.sin(blinkPhase * Math.PI) : 1;
  return {
    x: direction * talk * .11, y: Math.sin(time * .7) * .014 - talk * .035,
    sx: 1 + breath - .07 * talk, sy: 1 - breath + .09 * talk,
    angle: Math.sin(time * .9) * (thinking ? .11 : .025) + direction * talk * .12,
    gazeX: Math.sin(time * .48) * .045, gazeY: thinking ? -.10 : 0,
    eyeOpen: Math.max(.07, blink) * (phase === "listening" ? 1.12 : thinking ? .88 : 1),
  };
}
/** One neutral pose for fixed characters, independent of audio and state. */
export const FIXED_DOT_POSE: Readonly<DotPose> = Object.freeze(dotPose("idle", 0));
/** G2's body stays still; gaze and blink use the small overlay only. */
export function dotGlassesPose(phase: EchoPhase, time: number, energy = 0, animated = true): Readonly<DotPose> {
  if (!animated) return FIXED_DOT_POSE;
  const next = dotPose(phase, time, energy);
  return { ...dotPose("idle", 0), eyeOpen: Math.round(next.eyeOpen * 3) / 3,
    gazeX: Math.round(next.gazeX * 50) / 50, gazeY: next.gazeY };
}
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function sample(x: number, y: number, pose: DotPose): { shade: number; eye: boolean } | undefined {
  const cx = 72 + pose.x * 60, cy = 74 + pose.y * 60;
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
  const nx = ((x - cx) * c + (y - cy) * s) / (60 * pose.sx);
  const ny = (-(x - cx) * s + (y - cy) * c) / (60 * pose.sy);
  const r2 = nx * nx + ny * ny;
  if (r2 > 1) return undefined;
  const z = Math.sqrt(1 - r2);
  const diffuse = Math.max(0, Math.min(1, -.3 * nx - .35 * ny + .86 * z));
  const grain = Math.sin(x * 127.1 + y * 311.7) * .015;
  const eye = [-.20, .20].some(offset => {
    const ex = (nx - offset - pose.gazeX) / .09;
    const ey = (ny + .20 - pose.gazeY) / (.145 * pose.eyeOpen);
    return ex * ex + ey * ey < 1;
  });
  return { shade: .84 + .14 * diffuse + grain, eye };
}

/** Packed gray4, matching the existing Even G2 image transport (high nibble first). */
export function dotGray4(pose: DotPose, patch?: typeof EYES): Uint8Array {
  const width = patch?.width ?? DOT_SIZE, height = patch?.height ?? DOT_SIZE;
  const pixels = new Uint8Array(width * height / 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + (patch?.x ?? 0), py = y + (patch?.y ?? 0);
    const value = sample(px + .5, py + .5, pose);
    const threshold = ((bayer[(py % 4) * 4 + px % 4] ?? 0) / 16 - .5) * .7;
    const shade = value ? value.eye ? 0 : Math.max(1, Math.min(15, Math.round(11.5 * value.shade + threshold))) : 0;
    const index = y * width + x;
    pixels[index >> 1] = (pixels[index >> 1] ?? 0) | (shade << (index % 2 === 0 ? 4 : 0));
  }
  return pixels;
}

export function drawPinkDot(ctx: CanvasRenderingContext2D, pose: DotPose): void {
  const image = ctx.createImageData(DOT_SIZE, DOT_SIZE);
  for (let y = 0; y < DOT_SIZE; y++) for (let x = 0; x < DOT_SIZE; x++) {
    const value = sample(x + .5, y + .5, pose);
    if (!value) continue;
    const index = (y * DOT_SIZE + x) * 4;
    const color = value.eye ? [27, 19, 28] : [250, 112, 171].map(v => v * value.shade);
    image.data.set([color[0]!, color[1]!, color[2]!, 255], index);
  }
  ctx.clearRect(0, 0, DOT_SIZE, DOT_SIZE);
  ctx.putImageData(image, 0, 0);
}
