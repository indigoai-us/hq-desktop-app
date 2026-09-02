import { describe, expect, it } from "vitest";
import {
  attachmentKindForContentType,
  attachmentVaultScopeUid,
  buildChatAttachmentVaultPath,
  chatAttachmentValidatorForPlatform,
  conversationPairKey,
  filesFromDataTransfer,
  isAllowedChatAttachment,
  isImageFile,
  namePastedImageFile,
} from "./chat-attachments.js";
import {
  formatUploadServerError,
  presignUrlFromResult,
  uploadChatAttachments,
} from "./upload-chat-attachments.js";
import { formatComposerSendError } from "./composer-send-error.js";

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

  it("reads clipboard files, falling back to items when files is empty", () => {
    const png = new File([new Uint8Array(4)], "image.png", {
      type: "image/png",
    });
    expect(filesFromDataTransfer({ files: [png], items: [] })).toEqual([png]);
    expect(
      filesFromDataTransfer({
        files: [],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => png,
          } as DataTransferItem,
        ],
      }),
    ).toEqual([png]);
  });

  it("uniquifies generic pasted screenshot names and leaves named files alone", () => {
    const now = new Date("2026-09-02T01:17:00.000Z");
    const shot = new File([new Uint8Array(4)], "image.png", {
      type: "image/png",
    });
    expect(namePastedImageFile(shot, 1, now).name).toBe(
      "pasted-2026-09-02T01-17-00-1.png",
    );
    const named = new File([new Uint8Array(4)], "hero.png", {
      type: "image/png",
    });
    expect(namePastedImageFile(named, 2, now)).toBe(named);
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

  it("prefixes the server error verbatim when presign fails", async () => {
    const file = new File([new Uint8Array([1])], "shot.png", {
      type: "image/png",
    });
    await expect(
      uploadChatAttachments({
        files: [file],
        companyUid: "prs_me",
        scope: "dm",
        scopeId: "prs_me#agt_izzy",
        presignPut: async () => ({
          ok: false,
          reason: "error",
          message:
            "No active membership for caller in company prs_me",
        }),
      }),
    ).rejects.toThrow(
      "Could not upload shot.png: No active membership for caller in company prs_me",
    );
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

describe("attachmentVaultScopeUid", () => {
  const selfUid = "prs_me";

  it("uses the personal scope for a DM with no company uid", () => {
    expect(
      attachmentVaultScopeUid({
        row: { kind: "dm", companyUid: null },
        selfUid,
      }),
    ).toBe(selfUid);
  });

  it("uses the personal scope when the row carries a person uid labelled as company", () => {
    expect(
      attachmentVaultScopeUid({
        row: { kind: "dm", companyUid: "prs_me" },
        selfUid,
      }),
    ).toBe(selfUid);
  });

  it("uses the company uid for a company-scoped DM", () => {
    expect(
      attachmentVaultScopeUid({
        row: { kind: "dm", companyUid: "cmp_indigo" },
        selfUid,
      }),
    ).toBe("cmp_indigo");
  });

  it("uses the company uid for a company channel", () => {
    expect(
      attachmentVaultScopeUid({
        row: { kind: "channel", companyUid: "cmp_indigo" },
        selfUid,
      }),
    ).toBe("cmp_indigo");
  });
});

describe("formatComposerSendError", () => {
  it("keeps the server error verbatim behind a friendly prefix", () => {
    expect(
      formatComposerSendError(
        "No active membership for caller in company prs_me",
        true,
      ),
    ).toBe(
      "Couldn't send — No active membership for caller in company prs_me",
    );
    expect(
      formatUploadServerError(
        "No active membership for caller in company prs_me",
        "shot.png",
      ),
    ).toBe(
      "Could not upload shot.png: No active membership for caller in company prs_me",
    );
  });
});
