interface Draft { turnId: number; text: string }

/** ASR drafts remain local to this authenticated socket until explicitly accepted. */
export class TranscriptReview {
  private turnId?: number;
  private enabled = false;
  private draft?: Draft;
  begin(turnId: number, enabled: boolean): void {
    this.clear(); this.turnId = turnId; this.enabled = enabled;
  }
  finish(draft: Draft): "stale" | "empty" | "review" | "submit" {
    if (draft.turnId !== this.turnId) return "stale";
    if (!draft.text.trim()) { this.clear(); return "empty"; }
    if (!this.enabled) { this.clear(); return "submit"; }
    this.draft = { ...draft, text: draft.text.trim() };
    return "review";
  }
  take(turnId: number): Draft {
    if (!Number.isSafeInteger(turnId) || !this.draft || this.draft.turnId !== turnId) throw new Error("No matching ASR draft is awaiting confirmation");
    const draft = this.draft; this.clear(); return draft;
  }
  clear(): void { this.turnId = undefined; this.enabled = false; this.draft = undefined; }
}
