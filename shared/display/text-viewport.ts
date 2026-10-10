export interface TextViewportLayout {
  /** Preferred body width. Two spare columns prevent a second native G2 wrap. */
  columns: number;
  bodyLines: number;
}

export interface TextViewport {
  text: string;
  lines: string[];
  offset: number;
  page: number;
  pages: number;
  canScrollOlder: boolean;
  canScrollNewer: boolean;
}

const LINE_START_PROHIBITED = /^[、。，．！？!?：；:;）］｝〕〉》」』】〗〙〛’”»…‥・ー〜～ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/u;
const LINE_END_PROHIBITED = /[（［｛〔〈《「『【〖〘〚‘“«]$/u;

export function displayColumns(value: string): number {
  let width = 0;
  for (const character of Array.from(value)) {
    const point = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character)) continue;
    width += (
      point >= 0x1100 && (
        point <= 0x115f ||
        point === 0x2329 || point === 0x232a ||
        (point >= 0x2e80 && point <= 0xa4cf) ||
        (point >= 0xac00 && point <= 0xd7a3) ||
        (point >= 0xf900 && point <= 0xfaff) ||
        (point >= 0xfe10 && point <= 0xfe6f) ||
        (point >= 0xff01 && point <= 0xff60) ||
        (point >= 0xffe0 && point <= 0xffe6) ||
        point >= 0x1f300
      )
    ) ? 2 : 1;
  }
  return width;
}

function wordSegments(value: string): string[] {
  const raw = typeof Intl.Segmenter === "function"
    ? Array.from(
        new Intl.Segmenter(["ja", "en"], { granularity: "word" }).segment(value),
        ({ segment }) => segment,
      )
    : Array.from(value);
  const grouped: string[] = [];
  for (const segment of raw) {
    const previous = grouped[grouped.length - 1] ?? "";
    const followsJapanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(previous);
    const isJapaneseContinuation = /^[\p{Script=Hiragana}]+$/u.test(segment) && followsJapanese;
    const attachesLeft = LINE_START_PROHIBITED.test(segment);
    if (previous && !/^\s/u.test(segment) && !/\s$/u.test(previous) && (isJapaneseContinuation || attachesLeft)) {
      grouped[grouped.length - 1] = previous + segment;
    } else {
      grouped.push(segment);
    }
  }
  return grouped;
}

function splitLongSegment(value: string, columns: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  let width = 0;
  for (const character of Array.from(value)) {
    const characterWidth = displayColumns(character);
    if (piece && width + characterWidth > columns) {
      // If punctuation would start the next physical line, carry one glyph
      // with it instead. Unlike hanging punctuation, this never exceeds the
      // declared width and therefore cannot trigger a second native G2 wrap.
      let carry = "";
      if (LINE_START_PROHIBITED.test(character)) {
        const characters = Array.from(piece);
        carry = characters.pop() ?? "";
        piece = characters.join("");
      }
      pieces.push(piece);
      piece = carry;
      width = displayColumns(carry);
    }
    piece += character;
    width += characterWidth;
  }
  if (piece) pieces.push(piece);

  // Avoid a one-glyph orphan such as a lone Japanese full stop. It is better
  // to make the preceding line slightly shorter than to create a fourth G2
  // line that falls below the three-line viewport.
  const lastIndex = pieces.length - 1;
  if (lastIndex > 0 && displayColumns(pieces[lastIndex] ?? "") <= 2) {
    const previous = Array.from(pieces[lastIndex - 1] ?? "");
    let orphan = pieces[lastIndex] ?? "";
    while (previous.length > 2 && displayColumns(orphan) < 6) {
      orphan = `${previous.pop() ?? ""}${orphan}`;
    }
    pieces[lastIndex - 1] = previous.join("");
    pieces[lastIndex] = orphan;
  }
  return pieces;
}

function wrapParagraph(value: string, columns: number): string[] {
  const lines: string[] = [];
  let line = "";

  const pushLine = () => {
    const cleanLine = line.trimEnd();
    if (cleanLine) lines.push(cleanLine);
    line = "";
  };

  for (const rawSegment of wordSegments(value)) {
    let segment = /^\s+$/u.test(rawSegment) ? " " : rawSegment;
    if (!line) segment = segment.trimStart();
    if (!segment) continue;

    const candidateWidth = displayColumns(line + segment);
    if (candidateWidth <= columns) {
      line += segment;
      continue;
    }

    // Never leave an opening bracket or quote at the end of the previous line.
    let prefix = "";
    while (line && LINE_END_PROHIBITED.test(line)) {
      const characters = Array.from(line);
      prefix = `${characters.pop() ?? ""}${prefix}`;
      line = characters.join("");
    }
    pushLine();
    segment = `${prefix}${segment.trimStart()}`;

    if (displayColumns(segment) <= columns) {
      line = segment;
      continue;
    }

    const pieces = splitLongSegment(segment, columns);
    for (let index = 0; index < pieces.length; index += 1) {
      line = pieces[index] ?? "";
      if (index < pieces.length - 1) pushLine();
    }
  }

  pushLine();
  // Intl.Segmenter can leave a one-glyph word/bunsetsu on any wrapped line,
  // including the first row of a later page. Rebalance every such line.
  for (let index = 1; index < lines.length; index += 1) {
    if (displayColumns(lines[index] ?? "") > 2) continue;
    const previous = Array.from(lines[index - 1] ?? "");
    let orphan = lines[index] ?? "";
    const targetWidth = Math.min(6, columns);
    while (previous.length > 2 && displayColumns(orphan) < targetWidth) {
      orphan = `${previous.pop() ?? ""}${orphan}`;
    }
    lines[index - 1] = previous.join("");
    lines[index] = orphan;
  }
  return lines;
}

/** Wraps at words/bunsetsu and Japanese punctuation while preserving paragraphs. */
export function wrapDisplayLines(value: string, columns: number): string[] {
  const paragraphs = value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((paragraph) => paragraph.replace(/[^\S\n]+/gu, " ").trim())
    .filter(Boolean);
  return paragraphs.flatMap((paragraph) => wrapParagraph(paragraph, columns));
}

/** Returns a fixed-line page. Offset 0 is always the newest (last) page. */
export function textViewport(
  value: string,
  layout: TextViewportLayout,
  requestedOffset: number,
): TextViewport {
  const allLines = wrapDisplayLines(value, layout.columns);
  return viewportFromLines(allLines, layout, requestedOffset);
}

function viewportFromLines(allLines: string[], layout: TextViewportLayout, requestedOffset: number): TextViewport {
  const pages = Math.max(1, Math.ceil(allLines.length / layout.bodyLines));
  const offset = Math.max(0, Math.min(pages - 1, Math.trunc(requestedOffset)));
  const page = pages - offset;
  const start = (page - 1) * layout.bodyLines;
  const lines = allLines.slice(start, start + layout.bodyLines);
  return {
    text: lines.join("\n"),
    lines,
    offset,
    page,
    pages,
    canScrollOlder: page > 1,
    canScrollNewer: page < pages,
  };
}

/** Retains only the current text; page navigation and state changes reuse its wrapping. */
export class TextViewportCache {
  private value?: string;
  private allLines: string[] = [];
  private requestedOffset?: number;
  private viewport?: TextViewport;
  constructor(private readonly layout: TextViewportLayout) {}
  get(value: string, requestedOffset: number): TextViewport {
    if (this.value !== value) {
      this.allLines = wrapDisplayLines(value, this.layout.columns);
      this.value = value; this.viewport = undefined;
    }
    if (!this.viewport || !Object.is(this.requestedOffset, requestedOffset)) {
      this.viewport = viewportFromLines(this.allLines, this.layout, requestedOffset);
      this.requestedOffset = requestedOffset;
    }
    return this.viewport;
  }
}

/** Maps audible progress from the first page toward the newest page. */
export function speechProgressOffset(
  value: string,
  layout: TextViewportLayout,
  progress: number,
): number {
  return speechProgressOffsetAfterPrefix("", value, layout, progress);
}

/** Locates the currently spoken page inside an accumulated spoken transcript. */
export function speechProgressOffsetAfterPrefix(
  prefix: string,
  value: string,
  layout: TextViewportLayout,
  progress: number,
): number {
  const accumulated = prefix ? `${prefix}\n${value}` : value;
  const pages = textViewport(accumulated, layout, 0).pages;
  const prefixLines = wrapDisplayLines(prefix, layout.columns).length;
  const speechLines = Math.max(1, wrapDisplayLines(value, layout.columns).length);
  const bounded = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const speechLineIndex = Math.min(speechLines - 1, Math.floor(bounded * speechLines));
  const pageIndex = Math.min(pages - 1, Math.floor((prefixLines + speechLineIndex) / layout.bodyLines));
  return pages - 1 - pageIndex;
}

export function nextTextOffset(
  value: string,
  layout: TextViewportLayout,
  currentOffset: number,
  direction: -1 | 1,
): number {
  const pages = Math.max(1, Math.ceil(wrapDisplayLines(value, layout.columns).length / layout.bodyLines));
  return Math.max(0, Math.min(pages - 1, currentOffset + (direction < 0 ? 1 : -1)));
}

export function viewportPosition(viewport: TextViewport): string {
  const arrows = `${viewport.canScrollOlder ? "▲" : ""}${viewport.canScrollNewer ? "▼" : ""}`;
  return `P${viewport.page}/${viewport.pages}${arrows ? ` ${arrows}` : ""}`;
}
