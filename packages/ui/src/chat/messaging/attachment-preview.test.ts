import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentPreviewKind,
  canUseWebAttachmentProxy,
  createHostAttachmentResolver,
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

describe("createHostAttachmentResolver", () => {
  const item = {
    previewUrl: null as string | null,
    companyUid: "co-1",
    vaultPath: "chat/a/photo.png",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns previewUrl without calling presign", async () => {
    const presign = vi.fn(async () => "https://signed.example/a");
    const resolve = createHostAttachmentResolver({ presign });
    await expect(
      resolve({ ...item, previewUrl: "blob:local" }),
    ).resolves.toBe("blob:local");
    expect(presign).not.toHaveBeenCalled();
  });

  it("returns the presigned url when getObject is omitted", async () => {
    const resolve = createHostAttachmentResolver({
      presign: async () => "https://signed.example/a",
    });
    await expect(resolve(item)).resolves.toBe("https://signed.example/a");
  });

  it("returns a blob object URL when getObject succeeds", async () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-1");
    const blob = new Blob(["png"], { type: "image/png" });
    const resolve = createHostAttachmentResolver({
      presign: async () => "https://signed.example/a",
      getObject: async () => new Response(blob, { status: 200 }),
    });
    await expect(resolve(item)).resolves.toBe("blob:mock-1");
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("returns null when getObject is not ok", async () => {
    const resolve = createHostAttachmentResolver({
      presign: async () => "https://signed.example/a",
      getObject: async () => new Response(null, { status: 403 }),
    });
    await expect(resolve(item)).resolves.toBeNull();
  });

  it("returns null when presign returns null", async () => {
    const resolve = createHostAttachmentResolver({
      presign: async () => null,
    });
    await expect(resolve(item)).resolves.toBeNull();
  });

  it("returns null when companyUid is missing and there is no fallback", async () => {
    const presign = vi.fn(async () => "https://signed.example/a");
    const resolve = createHostAttachmentResolver({ presign });
    await expect(resolve({ ...item, companyUid: "" })).resolves.toBeNull();
    expect(presign).not.toHaveBeenCalled();
  });

  it("uses fallbackCompanyUid when item.companyUid is empty", async () => {
    const presign = vi.fn(
      async (companyUid: string) => `https://signed/${companyUid}`,
    );
    const resolve = createHostAttachmentResolver({
      presign,
      fallbackCompanyUid: () => "co-fallback",
    });
    await expect(resolve({ ...item, companyUid: "" })).resolves.toBe(
      "https://signed/co-fallback",
    );
    expect(presign).toHaveBeenCalledWith("co-fallback", item.vaultPath);
  });
});
