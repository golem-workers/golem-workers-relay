import { describe, expect, it } from "vitest";
import { composeMessageWithTranscript } from "./transcription.js";

describe("composeMessageWithTranscript", () => {
  it("returns only transcript for voice placeholder messages", () => {
    expect(
      composeMessageWithTranscript({
        messageText: "[Voice message]",
        transcript: "hello from voice",
      })
    ).toBe("hello from voice");
  });

  it("keeps user text when it contains more than a voice placeholder", () => {
    expect(
      composeMessageWithTranscript({
        messageText: "Please use this note\n[Voice message]",
        transcript: "hello from voice",
      })
    ).toBe("Please use this note\n\n[Voice transcript]\nhello from voice");
  });
});
