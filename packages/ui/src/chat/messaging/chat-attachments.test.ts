import { describe, expect, it } from "vitest";
import {
  attachmentKindForContentType,
  buildChatAttachmentVaultPath,
  chatAttachmentValidatorForPlatform,
  conversationPairKey,
  isAllowedChatAttachment,
  isImageFile,
} from "./chat-attachments.js";
import {
  presignUrlFromResult,
  uploadChatAttachments,
} from "./upload-chat-attachments.js";

describe("chat attachment helpers", () => {
  it("builds vault paths and pair keys", () => {
    expect(conversationPairKey("prs_b", "prs_a")).toBe("prs_a#prs_b");
    expect(
      buildChatAttachmentVaultPath({
        scope: "dm",
        scopeId: "prs_a#prs_b",
        fileId: "id1",
        name: "Notes.pdf",
      }),
    ).toBe("chat/attachments/dm/prs_a--prs_b/id1-Notes.pdf");
    expect(attachmentKindForContentType("image/png")).toBe("image");
    expect(attachmentKindForContentType("application/pdf")).toBe("file");
  });

  it("rejects oversized and unknown types", () => {
    const huge = new File([new Uint8Array(26 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });
    expect(isAllowedChatAttachment(huge)).toMatch(/25 MB/);
    const exe = new File([new Uint8Array(10)], "x.exe", {
      type: "application/x-msdownload",
    });
    expect(isAllowedChatAttachment(exe)).toMatch(/supported/);
  });

  it("rejects oversized web uploads without reducing the desktop limit", () => {
    const file = new File([new Uint8Array(5 * 1024 * 1024)], "report.pdf", {
      type: "application/pdf",
    });

    expect(chatAttachmentValidatorForPlatform("web")(file)).toEqual({
      code: "attachment-too-large",
      message: "report.pdf is larger than 4 MB, the web upload limit",
    });
    expect(chatAttachmentValidatorForPlatform("desktop")(file)).toBeNull();
  });

  it("classifies composer files as images via mime or extension", () => {
    const png = new File([new Uint8Array(4)], "shot.png", {
      type: "image/png",
    });
    expect(isImageFile(png)).toBe(true);
    const noMime = new File([new Uint8Array(4)], "photo.jpeg", { type: "" });
    expect(isImageFile(noMime)).toBe(true);
    const pdf = new File([new Uint8Array(4)], "doc.pdf", {
      type: "application/pdf",
    });
    expect(isImageFile(pdf)).toBe(false);
  });

  it("puts bytes through the host hop instead of S3", async () => {
    const puts: string[] = [];
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", {
      type: "image/png",
    });
    const uploaded = await uploadChatAttachments({
      files: [file],
      companyUid: "cmp_x",
      scope: "chan",
      scopeId: "chn_x",
      presignPut: async () => ({
        ok: true,
        value: {
          results: [
            {
              url: "https://bucket.s3.us-east-1.amazonaws.com/shot.png",
              headers: { "content-type": "image/png" },
            },
          ],
        },
      }),
      putObject: async (url, headers, body) => {
        puts.push(url);
        expect(headers["content-type"]).toBe("image/png");
        expect(body).toBe(file);
        return new Response(null, { status: 200 });
      },
    });
    expect(puts).toEqual([
      "https://bucket.s3.us-east-1.amazonaws.com/shot.png",
    ]);
    expect(uploaded[0]?.name).toBe("shot.png");
    expect(uploaded[0]?.vaultPath).toMatch(/^chat\/attachments\/chan\/chn_x\//);
  });

  it("reads a presign PUT result", () => {
    expect(
      presignUrlFromResult({
        results: [
          {
            url: "https://s3.example/put",
            headers: { "content-type": "image/png" },
          },
        ],
      }),
    ).toEqual({
      url: "https://s3.example/put",
      headers: { "content-type": "image/png" },
    });
  });
});
