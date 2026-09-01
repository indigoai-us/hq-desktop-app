import { describe, expect, it, vi } from "vitest";
import type { ChannelFileItemModel } from "./channelTabModels";
import {
  MAX_CHANNEL_FILE_PREVIEW_BYTES,
  fileCompanyScope,
  loadVaultFilePreview,
} from "./channel-file-preview";

const file: ChannelFileItemModel = {
  key: "projects/demo/brief.md",
  vaultPath: "projects/demo/brief.md",
  companyUid: "cmp_a",
  name: "brief.md",
  caption: "PROJECT",
  iconKind: "markdown",
};

function presignOk() {
  return Promise.resolve({
    ok: true as const,
    value: { results: [{ url: "https://bucket.s3.amazonaws.com/brief", headers: {} }] },
  });
}

describe("channel file previews", () => {
  it("uses the selected company scope and decodes a bounded UTF-8 text response", async () => {
    const presign = vi.fn(presignOk);
    const get = vi.fn(async () =>
      new Response("# Approved brief", {
        status: 200,
        headers: { "content-type": "text/markdown", "content-length": "16" },
      }),
    );

    await expect(
      loadVaultFilePreview({
        item: file,
        selectedCompanyUid: "cmp_a",
        presign,
        get,
      }),
    ).resolves.toEqual({ kind: "text", text: "# Approved brief" });
    expect(presign).toHaveBeenCalledWith("cmp_a", "projects/demo/brief.md");
    expect(get).toHaveBeenCalledWith(
      "https://bucket.s3.amazonaws.com/brief",
      MAX_CHANNEL_FILE_PREVIEW_BYTES,
    );
  });

  it("fails closed before presigning a file from another company", async () => {
    const presign = vi.fn(presignOk);
    const result = await loadVaultFilePreview({
      item: { ...file, companyUid: "cmp_other" },
      selectedCompanyUid: "cmp_a",
      presign,
      get: vi.fn(),
    });

    expect(fileCompanyScope({ ...file, companyUid: "cmp_other" }, "cmp_a")).toBeNull();
    expect(presign).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "unavailable", state: "denied" });
  });

  it("renders explicit missing, denied, offline, large, and binary outcomes", async () => {
    const cases = [
      {
        response: new Response(null, { status: 404 }),
        state: "missing",
      },
      {
        response: new Response(null, { status: 403 }),
        state: "denied",
      },
      {
        response: new Response("too large", {
          status: 200,
          headers: { "content-length": String(MAX_CHANNEL_FILE_PREVIEW_BYTES + 1) },
        }),
        state: "too-large",
      },
      {
        response: new Response(new Uint8Array([0, 159, 146, 150]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
        state: "binary",
      },
    ] as const;

    for (const entry of cases) {
      const result = await loadVaultFilePreview({
        item: file,
        selectedCompanyUid: "cmp_a",
        presign: presignOk,
        get: async () => entry.response.clone(),
      });
      expect(result).toMatchObject({ kind: "unavailable", state: entry.state });
    }

    const unknownLengthLarge = await loadVaultFilePreview({
      item: file,
      selectedCompanyUid: "cmp_a",
      presign: presignOk,
      get: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_CHANNEL_FILE_PREVIEW_BYTES + 1));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
    });
    expect(unknownLengthLarge).toMatchObject({ kind: "unavailable", state: "too-large" });

    await expect(
      loadVaultFilePreview({
        item: file,
        selectedCompanyUid: "cmp_a",
        presign: presignOk,
        get: async () => {
          throw new Error("network offline");
        },
      }),
    ).resolves.toMatchObject({ kind: "unavailable", state: "offline" });

    await expect(
      loadVaultFilePreview({
        item: file,
        selectedCompanyUid: "cmp_a",
        presign: presignOk,
        get: async () => {
          throw new Error("vault S3 GET exceeds the 2097152-byte read limit");
        },
      }),
    ).resolves.toMatchObject({ kind: "unavailable", state: "too-large" });
  });

  it("creates renderer-local URLs only for allowed raster images and PDFs", async () => {
    const createObjectUrl = vi.fn(() => "blob:authorized-preview");
    const image = await loadVaultFilePreview({
      item: { ...file, iconKind: "image" },
      selectedCompanyUid: "cmp_a",
      presign: presignOk,
      get: async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      createObjectUrl,
    });
    expect(image).toEqual({ kind: "image", url: "blob:authorized-preview" });

    const pdf = await loadVaultFilePreview({
      item: { ...file, iconKind: "pdf" },
      selectedCompanyUid: "cmp_a",
      presign: presignOk,
      get: async () =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      createObjectUrl,
    });
    expect(pdf).toEqual({ kind: "pdf", url: "blob:authorized-preview" });

    const svg = await loadVaultFilePreview({
      item: { ...file, iconKind: "image" },
      selectedCompanyUid: "cmp_a",
      presign: presignOk,
      get: async () =>
        new Response("<svg><script>alert(1)</script></svg>", {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
      createObjectUrl,
    });
    expect(svg).toMatchObject({ kind: "unavailable", state: "binary" });
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
  });
});
