import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe.skipIf(process.platform !== "darwin")("Native bounded microphone PCM", () => {
  it("runs the real Swift buffer with burst overflow and split samples", () => {
    const dir = mkdtempSync(join(tmpdir(), "dots-pcm-buffer-"));
    try {
      const executable = join(dir, "check");
      execFileSync("/usr/bin/swiftc", ["-module-cache-path", "dots-voice-bridge/.swift-cache", "-parse-as-library", "dots-voice-bridge/native/bounded-pcm.swift", "tests/fixtures/dots-bounded-pcm.swift", "-o", executable], { timeout: 30000 });
      expect(execFileSync(executable, { encoding: "utf8", timeout: 10000 })).toContain("1000 bursts passed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40000);
});
