import { describe, expect, it } from "vitest";
import {
  attachmentPreviewKind,
  canUseWebAttachmentProxy,
  isNetworkFetchError,
  parseCsv,
} from "./attachment-preview.js";

describe("attachmentPreviewKind", () => {
  it("classifies images, pdfs, text, and sheets", () => {
    expect(
      attachmentPreviewKind({ name: "a.png", contentType: "image/png" }),
    ).toBe("image");
    expect(
      attachmentPreviewKind({
        name: "notes.pdf",
        contentType: "application/pdf",
      }),
    ).toBe("pdf");
    expect(
      attachmentPreviewKind({
        name: "readme.md",
        contentType: "text/markdown",
      }),
    ).toBe("markdown");
    expect(
      attachmentPreviewKind({ name: "log.txt", contentType: "text/plain" }),
    ).toBe("text");
    expect(
      attachmentPreviewKind({ name: "grid.csv", contentType: "text/csv" }),
    ).toBe("sheet");
    expect(
      attachmentPreviewKind({
        name: "book.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe("sheet");
    expect(attachmentPreviewKind({ name: "source.gif", contentType: "" })).toBe(
      "image",
    );
  });
});

describe("parseCsv", () => {
  it("parses quoted commas", () => {
    expect(parseCsv('name,note\n"Ada, Lovelace","hi""there"')).toEqual([
      ["name", "note"],
      ["Ada, Lovelace", 'hi"there'],
    ]);
  });
});

describe("canUseWebAttachmentProxy", () => {
  it("is only for hosted web, never desktop vite", () => {
    expect(canUseWebAttachmentProxy("https://work.hq.computer")).toBe(true);
    expect(canUseWebAttachmentProxy("http://127.0.0.1:1420")).toBe(false);
    expect(canUseWebAttachmentProxy("http://localhost:5173")).toBe(true);
  });
});

describe("isNetworkFetchError", () => {
  it("treats WebKit Load failed like Failed to fetch", () => {
    expect(isNetworkFetchError(new Error("Load failed"))).toBe(true);
    expect(isNetworkFetchError(new Error("Failed to fetch"))).toBe(true);
    expect(isNetworkFetchError(new Error("Upload failed for a.pdf"))).toBe(
      false,
    );
  });
});
