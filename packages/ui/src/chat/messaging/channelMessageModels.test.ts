import { describe, expect, it } from "vitest";
import {
  parseAttachment,
  parseMessageAttachments,
  parseSystemEvent,
  shouldHideSystemMessage,
  systemModelForMessage,
} from "./channelMessageModels.js";

describe("parseMessageAttachments", () => {
  it("parses image and file metadata from attachments[]", () => {
    const items = parseMessageAttachments({
      attachments: [
        {
          id: "att_1",
          vaultPath: "chat/attachments/chan/chn_x/att_1-shot.png",
          companyUid: "cmp_1",
          name: "shot.png",
          contentType: "image/png",
          sizeBytes: 2048,
          kind: "image",
        },
        {
          vaultPath: "chat/attachments/chan/chn_x/notes.pdf",
          name: "notes.pdf",
          contentType: "application/pdf",
          sizeBytes: 12_000,
        },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "image", name: "shot.png" });
    expect(items[1]).toMatchObject({ kind: "file", caption: "FILES · 12 KB" });
  });

  it("treats a gif with no kind/contentType as an image", () => {
    const item = parseAttachment({
      vaultPath: "chat/attachments/chan/chn_x/source.gif",
      name: "source.gif",
    });
    expect(item?.kind).toBe("image");
    expect(item?.name).toBe("source.gif");
  });

  it("falls back to a legacy singular attachment", () => {
    const one = parseAttachment({
      vaultPath: "chat/attachments/chan/chn_x/a.txt",
      name: "a.txt",
    });
    expect(one?.name).toBe("a.txt");
    expect(
      parseMessageAttachments({
        attachment: {
          vaultPath: "chat/attachments/chan/chn_x/a.txt",
          name: "a.txt",
        },
      }),
    ).toHaveLength(1);
  });
});

describe("parseSystemEvent — work_session", () => {
  it("renders a work-mesh session card from cache envelopes", () => {
    const model = parseSystemEvent({
      v: 1,
      type: "work_session",
      status: "done",
      note: "US-006 throwaway cleanup",
    });
    expect(model).toMatchObject({
      kind: "line",
      type: "work_session",
      title: "US-006 throwaway cleanup",
      summary: "done",
    });
    expect(
      shouldHideSystemMessage({
        messageKind: "system",
        systemEvent: { v: 1, type: "work_session", status: "in_progress" },
      }),
    ).toBe(false);
  });
});

describe("systemModelForMessage — member_added", () => {
  it("renders hq-pro member_added posts as a system line", () => {
    expect(
      systemModelForMessage({
        messageKind: "member_added",
        body: "Stefan Johnson added Yousuf Kalim to the channel.",
        fromDisplayName: "Stefan Johnson",
      }),
    ).toEqual({
      kind: "line",
      type: "member_added",
      title: "Stefan Johnson added Yousuf Kalim to the channel.",
      summary: null,
    });
  });
});
