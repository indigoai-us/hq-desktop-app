// @vitest-environment happy-dom

/**
 * hard-stop-readiness US-018 e2e: given a company over storage, when a user
 * attaches a file in chat, the error names the storage limit and shows the
 * upgrade link. Drives the real composer, the real upload helper, and the real
 * Sync adapter error mapping; only the Rust `hq_pro_fetch` bridge is faked,
 * returning the body hq-pro's hard stop emits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { createSyncPlatformAdapter } from "@hq/platform";

import ChannelConversation from "./ChannelConversation.svelte";
import ReplyPanel from "./ReplyPanel.svelte";
import { uploadChatAttachments } from "./upload-chat-attachments";
import type { ConversationApi } from "../chat-api";

const UPGRADE_URL = "https://hq.computer/companies/acme/billing?upgrade=1";

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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

function overStorageUploader() {
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd: string) => {
      if (cmd === "hq_pro_fetch") {
        return { status: 402, body: JSON.stringify(HARD_STOP_BODY) };
      }
      throw new Error(`unexpected command ${cmd}`);
    },
    fetch: (() => {
      throw new Error("production must not use window.fetch");
    }) as unknown as typeof globalThis.fetch,
    requestPolicy: { throttle: null, sleep: async () => {} },
  });
  const putObject = vi.fn();
  const upload = (files: File[]) =>
    uploadChatAttachments({
      files,
      companyUid: "cmp_acme",
      scope: "chan",
      scopeId: "chn_1",
      presignPut: (cmp, key, contentType, integrity) =>
        adapter.files.presignVaultPut(cmp, key, contentType, integrity),
      putObject,
    });
  return { upload, putObject };
}

function report(): File {
  return new File([new Uint8Array([1, 2, 3, 4])], "report.pdf", {
    type: "application/pdf",
  });
}

function dispatchPaste(el: HTMLElement, files: File[]): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files, items: [], types: ["Files"] },
  });
  el.dispatchEvent(event);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("chat attachment over the storage limit", () => {
  it("channel composer names the storage limit and opens the upgrade link", async () => {
    const { upload, putObject } = overStorageUploader();
    const onopenurl = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [],
        onopenurl,
        onsend: async (_body: string, _mentions: unknown, files?: File[]) => {
          await upload(files ?? []);
        },
      },
    });
    await settle();

    const composer = host.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    dispatchPaste(composer, [report()]);
    await settle();
    (host.querySelector('[data-testid="composer-send"]') as HTMLButtonElement).click();
    await settle();

    const error = host.querySelector(".composer-attach-error");
    expect(error?.textContent).toBe(
      "Could not upload report.pdf: New files are paused while Acme is over its Starter limits. Storage: 10.2 GB of 10 GB used.",
    );
    const upgrade = host.querySelector(
      '[data-testid="composer-attach-upgrade"]',
    ) as HTMLButtonElement | null;
    expect(upgrade?.textContent?.trim()).toBe("Upgrade plan");
    upgrade?.click();
    expect(onopenurl).toHaveBeenCalledWith(UPGRADE_URL);
    expect(putObject).not.toHaveBeenCalled();

    // A different attach problem must not keep the stale upgrade action.
    dispatchPaste(composer, [report()]);
    await settle();
    expect(host.querySelector('[data-testid="composer-attach-upgrade"]')).toBeNull();
  });

  it("thread reply panel shows the same sentence and link", async () => {
    const { upload } = overStorageUploader();
    const onopenurl = vi.fn();
    const rootMessage = {
      eventId: "evt_root",
      direction: "in",
      fromPersonUid: "prs_stefan",
      fromDisplayName: "Stefan",
      body: "thread",
      createdAt: "2026-09-18T22:00:00.000Z",
    };
    const api = {
      fetchReplyThread: async () => ({
        scope: "channel",
        root: rootMessage,
        replies: [],
        replyCount: 0,
      }),
      sendReply: vi.fn(),
    } as unknown as ConversationApi;
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api,
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_1",
        seedRoot: rootMessage,
        selfDisplayName: "Corey",
        onclose: () => {},
        onopenurl,
        onuploadfiles: upload,
      },
    });
    await settle();

    const input = host.querySelector("textarea.reply-input") as HTMLTextAreaElement;
    dispatchPaste(input, [report()]);
    await settle();
    input.value = "see attached";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();

    expect(
      host.querySelector('[data-testid="reply-panel-pending"] .composer-attach-error')
        ?.textContent,
    ).toContain("Storage: 10.2 GB of 10 GB used.");
    const upgrade = host.querySelector(
      '[data-testid="composer-attach-upgrade"]',
    ) as HTMLButtonElement | null;
    upgrade?.click();
    expect(onopenurl).toHaveBeenCalledWith(UPGRADE_URL);
    expect(api.sendReply).not.toHaveBeenCalled();
  });
});
