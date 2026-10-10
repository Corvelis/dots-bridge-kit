import { describe, expect, it } from "vitest";
import { parseSpeechEvent } from "../bridge/src/apple-speech-transcriber";

describe("Apple speech helper protocol", () => {
  it("parses readiness and transcript events", () => {
    expect(parseSpeechEvent('{"ready":true}')).toEqual({ ready: true });
    expect(parseSpeechEvent('{"text":"G2の音声","final":false}')).toEqual({
      text: "G2の音声",
      final: false,
    });
  });

  it("ignores unrelated output", () => {
    expect(parseSpeechEvent("diagnostic")).toBeUndefined();
  });
});

