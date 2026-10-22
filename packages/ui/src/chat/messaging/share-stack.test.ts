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
    const files = (...names: string[]) =>
      names.map((name) => ({ name, kind: "file", vaultPath: `reports/${name}` }));
    type Attachments = Array<{ name: string; kind: string; vaultPath: string }>;
    const cases: Array<[string, Attachments]> = [
      ["Shared a folder with you: outpost-autoscale (in HQ at projects/outpost-autoscale/).", base.attachments],
      ["Shared a file with you: q3.pdf (in HQ at reports/q3.pdf).", files("q3.pdf")],
      ["Shared 2 files with you: q1.csv, q3.pdf.", files("q1.csv", "q3.pdf")],
      ["Shared 5 files with you: a.md, b.md, c.md and 2 more.", files("a.md", "b.md", "c.md", "d.md", "e.md")],
      ["Shared a folder with you: the whole vault (in HQ at /).", [{ name: "/", kind: "folder", vaultPath: "/" }]],
      [`Shared a file with you: ${"x".repeat(79)}\u2026 (in HQ at reports/x).`, files("x".repeat(120))],
      ["Shared a file with you: a b.md (in HQ at reports/a b.md).", files("a\u202eb.md")],
    ];
    for (const [body, attachments] of cases) {
      expect(isStackableShare({ ...plain, body, attachments })).toBe(true);
    }
  });

  it("rejects a share line followed by text on another line", () => {
    const deck = {
      ...base,
      messageKind: undefined,
      attachments: [{ name: "deck.pdf", kind: "file", vaultPath: "projects/deck.pdf" }],
    };
    for (const body of [
      "Shared a file with you: deck.pdf.\nPlease review by Friday",
      "Shared a file with you: deck.pdf (in HQ at projects/deck.pdf).\r\nPlease review by Friday",
      "Shared a file with you: deck.pdf.\rDeadline moved to Friday",
      "Shared a file with you: deck\r.pdf",
      "Shared a file with you:\nPlease wire the money today",
      "Shared a file with you:\n\nThe deadline moved to Friday, see note below",
      `Shared a file with you: deck.pdf.${String.fromCharCode(0x2028)}Deadline moved to Friday`,
      "Shared a file with you.\nPlease review by Friday",
    ]) {
      expect(isStackableShare({ ...deck, body })).toBe(false);
    }
  });

  it("rejects a one-line note that does not name the attachment", () => {
    const deck = {
      ...base,
      messageKind: undefined,
      attachments: [{ name: "deck.pdf", kind: "file", vaultPath: "projects/deck.pdf" }],
    };
    expect(isStackableShare({ ...deck, body: "Shared a file with you: please call me before you open this" })).toBe(false);
    expect(isStackableShare({ ...deck, body: "Shared a file with you and here is why" })).toBe(false);
  });

  it("does not throw on missing or very long bodies and stays fast on adversarial whitespace", () => {
    expect(isStackableShare({ ...base, body: undefined, messageKind: undefined })).toBe(true);
    const named = { ...base, messageKind: undefined, attachments: [{ name: "x", kind: "file", vaultPath: "a/x" }] };
    const long = `Shared a file with you: ${"x".repeat(50_000)}`;
    expect(isStackableShare({ ...named, body: `${long}\nmore` })).toBe(false);
    expect(isStackableShare({ ...named, body: long })).toBe(true);
    const started = performance.now();
    expect(isStackableShare({ ...named, body: `Shared a file with you:${" ".repeat(50_000)}\nx\ny` })).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
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
