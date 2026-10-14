import { describe, expect, it } from "vitest";
import {
  forwardNoteText,
  omittedAttachmentsLabel,
  parseForwardedFrom,
  parseOmittedAttachments,
} from "./channelMessageModels";
import { messageHasVisibleContent } from "./richMessageContent";

describe("parseForwardedFrom (US-008 AC1)", () => {
  it("parses the server's forwardedFrom object", () => {
    expect(
      parseForwardedFrom({
        senderUid: "prs_a",
        senderName: "Ada",
        sourceKind: "channel",
        originalCreatedAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toEqual({
      senderUid: "prs_a",
      senderName: "Ada",
      sourceKind: "channel",
      originalCreatedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("returns null for absent, non-object, or nameless values", () => {
    expect(parseForwardedFrom(undefined)).toBeNull();
    expect(parseForwardedFrom(null)).toBeNull();
    expect(parseForwardedFrom("Forwarded from Mallory")).toBeNull();
    expect(parseForwardedFrom({ senderUid: "prs_a" })).toBeNull();
    expect(parseForwardedFrom({ senderName: "   " })).toBeNull();
  });
});

describe("omitted attachments (US-008 AC5)", () => {
  it("coerces the count to a non-negative integer", () => {
    expect(parseOmittedAttachments(3)).toBe(3);
    expect(parseOmittedAttachments(0)).toBe(0);
    expect(parseOmittedAttachments(-2)).toBe(0);
    expect(parseOmittedAttachments(1.5)).toBe(0);
    expect(parseOmittedAttachments("3")).toBe(0);
    expect(parseOmittedAttachments(undefined)).toBe(0);
  });

  it("labels the count in plain text", () => {
    expect(omittedAttachmentsLabel(1)).toBe("1 file not included");
    expect(omittedAttachmentsLabel(3)).toBe("3 files not included");
    expect(omittedAttachmentsLabel(0)).toBeNull();
  });
});

describe("forward note (US-008 AC2)", () => {
  it("trims the note and treats non-strings as empty", () => {
    expect(forwardNoteText("  fyi  ")).toBe("fyi");
    expect(forwardNoteText(undefined)).toBe("");
    expect(forwardNoteText(42)).toBe("");
  });

  it("counts a note as visible content", () => {
    expect(messageHasVisibleContent({ body: "", forwardNote: "fyi" })).toBe(true);
    expect(messageHasVisibleContent({ body: "" })).toBe(false);
  });
});
