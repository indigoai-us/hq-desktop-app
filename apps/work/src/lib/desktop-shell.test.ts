import { readFile } from "node:fs/promises";

import { failure, ok, type PlatformAdapter } from "@hq/platform";
import { describe, expect, it, vi } from "vitest";

import {
  createTauriAttachmentHandlers,
  hydrateDesktopSelf,
} from "./desktop-shell.js";

function identityAdapter(
  kind: "web" | "desktop",
  whoami: PlatformAdapter["identity"]["whoami"],
) {
  return { kind, identity: { whoami } } as Pick<
    PlatformAdapter,
    "kind" | "identity"
  >;
}

describe("desktop shell identity", () => {
  it("hydrates a missing host identity from the desktop adapter", async () => {
    const whoami = vi.fn(async () =>
      ok({
        personUid: "prs_desktop",
        email: "desktop@example.com",
        displayName: "Desktop Person",
      }),
    );

    await expect(
      hydrateDesktopSelf(null, identityAdapter("desktop", whoami)),
    ).resolves.toEqual({
      uid: "prs_desktop",
      email: "desktop@example.com",
      displayName: "Desktop Person",
    });
    expect(whoami).toHaveBeenCalledOnce();
  });

  it("keeps a server-verified web identity without a whoami round trip", async () => {
    const whoami = vi.fn(async () =>
      ok({ personUid: "prs_unexpected", email: "unexpected@example.com" }),
    );
    const hostSelf = {
      uid: "prs_server",
      email: "server@example.com",
      displayName: "Server Person",
    };

    await expect(
      hydrateDesktopSelf(hostSelf, identityAdapter("web", whoami)),
    ).resolves.toBe(hostSelf);
    expect(whoami).not.toHaveBeenCalled();
  });

  it("keeps an unsigned web shell signed out without a whoami round trip", async () => {
    const whoami = vi.fn(async () =>
      ok({ personUid: "prs_unexpected", email: "unexpected@example.com" }),
    );

    await expect(
      hydrateDesktopSelf(null, identityAdapter("web", whoami)),
    ).resolves.toBeNull();
    expect(whoami).not.toHaveBeenCalled();
  });

  it("stays signed out when desktop whoami fails", async () => {
    const whoami = vi.fn(async () => failure("unauthenticated"));

    await expect(
      hydrateDesktopSelf(null, identityAdapter("desktop", whoami)),
    ).resolves.toBeNull();
  });

  it("stays signed out when desktop whoami rejects", async () => {
    const whoami = vi.fn(async () => {
      throw new Error("native identity unavailable");
    });

    await expect(
      hydrateDesktopSelf(null, identityAdapter("desktop", whoami)),
    ).resolves.toBeNull();
  });
});

describe("Tauri attachment handlers", () => {
  it("forwards PUT bytes and returns the native status", async () => {
    const invoke = vi.fn(async () => 204);
    const handlers = createTauriAttachmentHandlers(invoke);
    const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);

    const response = await handlers.putAttachmentObject(
      "https://bucket.s3.amazonaws.com/chat/file?signature=1",
      { "content-type": "image/png", "x-amz-acl": "private" },
      { arrayBuffer } as unknown as File,
    );

    expect(invoke).toHaveBeenCalledWith("vault_s3_put", {
      url: "https://bucket.s3.amazonaws.com/chat/file?signature=1",
      headers: { "content-type": "image/png", "x-amz-acl": "private" },
      body: [1, 2, 3],
    });
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(response.status).toBe(204);
  });

  it("returns GET bytes and the native content type", async () => {
    const invoke = vi.fn(async () => ({
      status: 200,
      contentType: "application/pdf",
      body: [37, 80, 68, 70],
    }));
    const handlers = createTauriAttachmentHandlers(invoke);

    const response = await handlers.getAttachmentObject(
      "https://bucket.s3.amazonaws.com/chat/file?signature=1",
    );

    expect(invoke).toHaveBeenCalledWith("vault_s3_get", {
      url: "https://bucket.s3.amazonaws.com/chat/file?signature=1",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      37, 80, 68, 70,
    ]);
  });

  it("defaults a missing native GET content type to an octet stream", async () => {
    const handlers = createTauriAttachmentHandlers(async () => ({
      status: 200,
      contentType: "",
      body: [1],
    }));

    const response = await handlers.getAttachmentObject(
      "https://bucket.s3.amazonaws.com/chat/file?signature=1",
    );

    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("wires reactive desktop identity and native attachment handlers only for the desktop shell", async () => {
    const source = await readFile(
      new URL("../routes/+page.svelte", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /adapter\.kind === "desktop"\s*\? createTauriAttachmentHandlers\(tauriInvoke\)\s*:\s*null/,
    );
    expect(source).toMatch(/let self = \$state\(hostSelf\)/);
    expect(source).toMatch(/self = await hydrateDesktopSelf\(hostSelf, adapter\)/);
    expect(source).toMatch(
      /\$effect\(\(\) => \{\s*seedConversationCacheFromRail\(shallow\);\s*\}\)/,
    );
    expect(source).toMatch(
      /const sidebarApi = \$derived\(\s*createChatSidebarApi\(adapter, shallow\.directory, personUid\),\s*\)/,
    );
    expect(source).toMatch(
      /putAttachmentObject=\{attachmentHandlers\?\.putAttachmentObject\}/,
    );
    expect(source).toMatch(
      /getAttachmentObject=\{attachmentHandlers\?\.getAttachmentObject\}/,
    );
  });
});
