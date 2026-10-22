import { describe, expect, it } from "vitest";

import { parseAttachment, type FileAttachmentModel } from "./channelMessageModels";
import { attachmentBadgeLabel } from "./chat-attachments";
import { isStackableShare, shareStackSummary } from "./share-stack";

const base = {
  eventId: "evt_1",
  createdAt: "2026-10-14T15:18:17.500Z",
  body: "Shared a folder with you.",
  attachments: [{ name: "outpost-autoscale", kind: "folder", vaultPath: "projects/outpost-autoscale/" }],
};

function model(raw: Record<string, unknown>): FileAttachmentModel {
  const parsed = parseAttachment(raw);
  if (!parsed) throw new Error("unparseable attachment");
  return parsed;
}

describe("folder attachments", () => {
  it("keeps the folder kind and badge", () => {
    const item = model({ name: "outpost-autoscale", kind: "folder", vaultPath: "projects/outpost-autoscale/" });
    expect(item.kind).toBe("folder");
    expect(attachmentBadgeLabel(item)).toBe("FOLDER");
  });

  it("treats a trailing-slash vault path as a folder and names it from the last segment", () => {
    const item = model({ vaultPath: "projects/hq-sync-storage-cost/research/" });
    expect(item.kind).toBe("folder");
    expect(item.name).toBe("research");
  });

  it("still labels files by extension", () => {
    expect(attachmentBadgeLabel(model({ name: "plan.pdf", vaultPath: "a/plan.pdf" }))).toBe("PDF");
  });
});

describe("isStackableShare", () => {
  it("accepts a share-only message", () => {
    expect(isStackableShare(base)).toBe(true);
    expect(isStackableShare({ ...base, body: "Shared 2 file(s) with you." })).toBe(true);
    expect(isStackableShare({ ...base, body: "", messageKind: "file_share" })).toBe(true);
  });

  it("accepts the named share bodies hq-pro sends (feedback_7c7daa44)", () => {
    const plain = { ...base, messageKind: undefined };
    for (const body of [
      "Shared a folder with you: outpost-autoscale (in HQ at projects/outpost-autoscale/).",
      "Shared a file with you: q3.pdf (in HQ at reports/q3.pdf).",
      "Shared 2 files with you: q1.csv, q3.pdf.",
      "Shared 5 files with you: a.md, b.md, c.md and 2 more.",
      "Shared a folder with you: the whole vault (in HQ at /).",
    ]) {
      expect(isStackableShare({ ...plain, body })).toBe(true);
    }
  });

  it("still rejects a share line followed by a second line of text", () => {
    expect(
      isStackableShare({ ...base, body: "Shared a file with you: q3.pdf.\nPlease review by Friday" }),
    ).toBe(false);
    expect(isStackableShare({ ...base, body: "Shared a file with you and here is why" })).toBe(false);
  });

  it("does not throw on missing or very long bodies", () => {
    expect(isStackableShare({ ...base, body: undefined, messageKind: undefined })).toBe(true);
    const long = `Shared a file with you: ${"x".repeat(50_000)}`;
    expect(isStackableShare({ ...base, body: `${long}\nmore`, messageKind: undefined })).toBe(false);
    expect(isStackableShare({ ...base, body: long, messageKind: undefined })).toBe(true);
  });

  it("rejects a message that says something else", () => {
    expect(isStackableShare({ ...base, body: "Here is the folder for tomorrow" })).toBe(false);
  });

  it("rejects messages carrying a prompt, replies or reactions", () => {
    expect(isStackableShare({ ...base, prompt: "Do X" })).toBe(false);
    expect(isStackableShare({ ...base, replyCount: 2 })).toBe(false);
    expect(
      isStackableShare({ ...base, reactions: [{ emoji: "👍", count: 1, reactedByMe: false }] }),
    ).toBe(false);
  });

  it("rejects image shares and messages without attachments", () => {
    expect(
      isStackableShare({ ...base, attachments: [{ name: "a.png", vaultPath: "x/a.png", contentType: "image/png" }] }),
    ).toBe(false);
    expect(isStackableShare({ ...base, attachments: [] })).toBe(false);
  });
});

describe("shareStackSummary", () => {
  const folder = model({ name: "f", kind: "folder", vaultPath: "p/f/" });
  const file = model({ name: "a.md", vaultPath: "p/a.md" });

  it("counts folders and files", () => {
    expect(shareStackSummary([folder, folder, folder])).toBe("Shared 3 folders with you.");
    expect(shareStackSummary([file, file])).toBe("Shared 2 files with you.");
    expect(shareStackSummary([folder, folder, file])).toBe("Shared 2 folders and a file with you.");
  });
});
