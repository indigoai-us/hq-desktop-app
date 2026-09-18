import { describe, expect, it } from "vitest";
import {
  formatComposerSendError,
  isMentionSendError,
  isTerminalSendError,
} from "./composer-send-error.js";

/**
 * Regression: a thread reply that tagged someone the channel refuses showed a
 * bare "Failed — tap to retry". The retry could never succeed and the message
 * never said which name was the problem.
 */
describe("terminal send errors", () => {
  it("marks mention denials as un-retryable", () => {
    expect(
      isTerminalSendError(
        "[MENTION_PARTICIPANT_NOT_VISIBLE] Mentioned participant is not active in this company",
      ),
    ).toBe(true);
    expect(
      isTerminalSendError(
        "[INVALID_MENTIONS] Field 'mentions' supports at most 25 participants",
      ),
    ).toBe(true);
  });

  it("leaves a transient network failure retryable", () => {
    expect(isTerminalSendError("Failed to fetch")).toBe(false);
    expect(isTerminalSendError("")).toBe(false);
  });

  it("recognises a mention denial", () => {
    expect(isMentionSendError("[MENTION_PARTICIPANT_NOT_VISIBLE] …")).toBe(true);
    expect(isMentionSendError("Failed to fetch")).toBe(false);
  });
});

describe("formatComposerSendError names the mentions", () => {
  const notVisible =
    "[MENTION_PARTICIPANT_NOT_VISIBLE] Mentioned participant is not active in this company";

  it("names the single mention that could not be tagged", () => {
    expect(formatComposerSendError(notVisible, false, ["Jacob Posel"])).toBe(
      "Couldn't send — @Jacob Posel isn't in this company, so they can't be tagged here. Remove the name and send again.",
    );
  });

  it("lists every mention when the server cannot say which one failed", () => {
    const message = formatComposerSendError(notVisible, false, [
      "Shawon Majid",
      "Shepherd",
    ]);
    expect(message).toContain("@Shawon Majid, @Shepherd");
    expect(message).toContain("Remove the name and send again.");
  });

  it("falls back to the plain reason with no mention names", () => {
    expect(formatComposerSendError(notVisible, false)).toBe(
      "Couldn't send — that person isn't active in this company.",
    );
  });

  it("reports the mention cap in plain words", () => {
    expect(
      formatComposerSendError(
        "[INVALID_MENTIONS] Field 'mentions' supports at most 25 participants",
        false,
      ),
    ).toBe("Couldn't send — field 'mentions' supports at most 25 participants");
  });

  it("keeps network failures unchanged", () => {
    expect(formatComposerSendError("Failed to fetch", false)).toBe(
      "Could not send the message",
    );
  });
});
