import { describe, expect, it, vi } from "vitest";
import { createSyncPlatformAdapter, type PlatformAdapter } from "@hq/platform";

import {
  ChatAttachmentUploadError,
  presignItemRefusal,
  uploadChatAttachments,
  uploadErrorUpgradeUrl,
} from "./upload-chat-attachments";

const UPGRADE_URL = "https://hq.computer/companies/acme/billing?upgrade=1";

/** hq-pro `evaluatePlanHardStopFromInputs` body for files.create over storage. */
const HARD_STOP_BODY = {
  error: "plan_limit_reached",
  code: "PLAN_LIMIT_EXCEEDED",
  status: 402,
  blocked: "files.create",
  resources: [
    { resource: "storageBytes", used: 10_995_116_278, limit: 10_737_418_240 },
  ],
  message: "New files are paused while Acme is over its Starter limits.",
  fixOptions: { storageBytes: 10_737_418_240 },
  upgradeUrl: UPGRADE_URL,
};

function syncAdapterReturning(status: number, body: unknown): PlatformAdapter {
  return createSyncPlatformAdapter({
    invoke: async (cmd: string) => {
      if (cmd === "hq_pro_fetch") return { status, body: JSON.stringify(body) };
      throw new Error(`unexpected command ${cmd}`);
    },
    fetch: (() => {
      throw new Error("production must not use window.fetch");
    }) as unknown as typeof globalThis.fetch,
    requestPolicy: { throttle: null, sleep: async () => {} },
  });
}

function pdf(): File {
  return new File([new Uint8Array([1, 2, 3])], "report.pdf", {
    type: "application/pdf",
  });
}

describe("uploadChatAttachments plan-limit refusals", () => {
  it("names the storage limit and keeps the upgrade link from a 402", async () => {
    const adapter = syncAdapterReturning(402, HARD_STOP_BODY);
    const putObject = vi.fn();
    const error = await uploadChatAttachments({
      files: [pdf()],
      companyUid: "cmp_acme",
      scope: "chan",
      scopeId: "chn_1",
      presignPut: (cmp, key, contentType, integrity) =>
        adapter.files.presignVaultPut(cmp, key, contentType, integrity),
      putObject,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChatAttachmentUploadError);
    const refusal = error as ChatAttachmentUploadError;
    expect(refusal.message).toBe(
      "Could not upload report.pdf: New files are paused while Acme is over its Starter limits. Storage: 10.2 GB of 10 GB used.",
    );
    expect(refusal.message).not.toContain("plan_limit_reached");
    expect(refusal.upgradeUrl).toBe(UPGRADE_URL);
    expect(refusal.planLimit).toBe(true);
    expect(uploadErrorUpgradeUrl(refusal)).toBe(UPGRADE_URL);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("reads a per-item refusal inside a 200 presign batch", async () => {
    const item = {
      key: "chat/attachments/dm/a--b/f/report.pdf",
      op: "put",
      error: "New files are paused while your personal HQ is over its limits.",
      code: "PLAN_LIMIT_REACHED",
      upgradeUrl: "https://hq.computer/billing",
    };
    const adapter = syncAdapterReturning(200, { results: [item] });
    const error = await uploadChatAttachments({
      files: [pdf()],
      companyUid: "prs_me",
      scope: "dm",
      scopeId: "a--b",
      presignPut: (cmp, key, contentType, integrity) =>
        adapter.files.presignVaultPut(cmp, key, contentType, integrity),
      putObject: vi.fn(),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChatAttachmentUploadError);
    expect((error as Error).message).toBe(
      "Could not upload report.pdf: New files are paused while your personal HQ is over its limits.",
    );
    expect(uploadErrorUpgradeUrl(error)).toBe("https://hq.computer/billing");
  });

  it("drops a link on a host hq-pro never returns", () => {
    const error = new ChatAttachmentUploadError("Could not upload x", {
      upgradeUrl: "https://app.indigo-hq.com/billing/upgrade",
      planLimit: true,
    });
    expect(error.upgradeUrl).toBeUndefined();
    expect(uploadErrorUpgradeUrl(error)).toBeNull();
    expect(uploadErrorUpgradeUrl(new Error("plain"))).toBeNull();
  });

  it("does not treat a minted URL as a refusal", () => {
    expect(
      presignItemRefusal({ results: [{ key: "k", op: "put", url: "https://s3/x" }] }),
    ).toBeNull();
    expect(presignItemRefusal({ results: [] })).toBeNull();
  });
});
