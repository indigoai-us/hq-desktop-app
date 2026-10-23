import { describe, expect, it } from "vitest";

import { fileKind, fileMetaLine } from "./chat-attachments";

// The iOS app tells three file kinds apart by colour (hq-native-mobile
// FileKindTint) and leads the second line with the kind: "PDF · 12 KB".
describe("fileKind", () => {
  it("separates folders, images and every other file", () => {
    expect(fileKind({ name: "Q3", contentType: "", kind: "folder" })).toBe("folder");
    expect(fileKind({ name: "mock.png", contentType: "image/png" })).toBe("image");
    expect(fileKind({ name: "shot", contentType: "image/jpeg" })).toBe("image");
    expect(fileKind({ name: "spec.pdf", contentType: "application/pdf" })).toBe("document");
    expect(fileKind({ name: "notes.md", contentType: "text/markdown" })).toBe("document");
  });
});

describe("fileMetaLine", () => {
  it("leads with the kind and follows with the size", () => {
    expect(
      fileMetaLine({ name: "spec.pdf", contentType: "application/pdf", sizeLabel: "12 KB" }),
    ).toBe("PDF · 12 KB");
  });

  it("says Folder for a folder and never a bare File when the type is known", () => {
    expect(fileMetaLine({ name: "Q3", contentType: "", kind: "folder", sizeLabel: "3 items" })).toBe("Folder");
    expect(fileMetaLine({ name: "spec.pdf", contentType: "application/pdf" })).toBe("PDF");
  });
});
