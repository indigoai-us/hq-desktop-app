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

describe("parseSystemEvent — work_session card", () => {
  it("renders a work-mesh session card from cache envelopes", () => {
    const model = parseSystemEvent({
      v: 1,
      type: "work_session",
      status: "done",
      note: "US-006 throwaway cleanup",
    });
    expect(model).toMatchObject({
      kind: "work_session_card",
      type: "work_session",
      title: "US-006 throwaway cleanup",
      summary: "done",
      status: "done",
      note: "US-006 throwaway cleanup",
    });
    expect(
      shouldHideSystemMessage({
        messageKind: "system",
        systemEvent: { v: 1, type: "work_session", status: "in_progress" },
      }),
    ).toBe(false);
  });

  it("accepts additive envelope fields and ignores unknown keys", () => {
    const model = parseSystemEvent({
      v: 1,
      type: "work_session",
      status: "active",
      actorUid: "agt_parker",
      actorType: "agent",
      harness: "claude-code",
      taskId: "US-015",
      turnCount: 12,
      lastTurnAt: "2026-09-04T11:58:00.000Z",
      principal: { uid: "agt_parker", kind: "agent" },
      displayName: "Parker",
      futureField: { nested: true },
      anotherUnknown: "ignored",
    });
    expect(model).toMatchObject({
      kind: "work_session_card",
      type: "work_session",
      actorUid: "agt_parker",
      actorType: "agent",
      harness: "claude-code",
      taskId: "US-015",
      turnCount: 12,
      lastTurnAt: "2026-09-04T11:58:00.000Z",
      status: "active",
      principalDisplay: "Parker",
    });
    expect(model && "futureField" in model).toBe(false);
  });

  it("keeps the v=1 gate and returns null for unknown types", () => {
    expect(parseSystemEvent({ v: 2, type: "work_session" })).toBeNull();
    expect(
      parseSystemEvent({ v: 1, type: "work_session_unknown_future" }),
    ).toBeNull();
  });
});

describe("parseSystemEvent — discrete work_session lines", () => {
  it("maps blocked / task_status / finished to line titles from note", () => {
    expect(
      parseSystemEvent({
        v: 1,
        type: "work_session_blocked",
        note: "Deacon is blocked on review",
      }),
    ).toMatchObject({
      kind: "line",
      type: "work_session_blocked",
      title: "Deacon is blocked on review",
      summary: null,
    });
    expect(
      parseSystemEvent({
        v: 1,
        type: "work_session_task_status",
        note: "Deacon moved US-3 to done",
      }),
    ).toMatchObject({
      kind: "line",
      type: "work_session_task_status",
      title: "Deacon moved US-3 to done",
    });
    expect(
      parseSystemEvent({
        v: 1,
        type: "work_session_finished",
        note: "Deacon finished 30 turns on US-3",
      }),
    ).toMatchObject({
      kind: "line",
      type: "work_session_finished",
      title: "Deacon finished 30 turns on US-3",
    });
  });

  it("falls back to DEFAULT_TITLES when title/note/body are absent", () => {
    expect(
      parseSystemEvent({ v: 1, type: "work_session_blocked" }),
    ).toMatchObject({ title: "Blocked" });
    expect(
      parseSystemEvent({ v: 1, type: "work_session_task_status" }),
    ).toMatchObject({ title: "Task moved" });
    expect(
      parseSystemEvent({ v: 1, type: "work_session_finished" }),
    ).toMatchObject({ title: "Finished" });
  });

  it("prefers summary when note is absent", () => {
    expect(
      parseSystemEvent({
        v: 1,
        type: "work_session_blocked",
        summary: "Blocked waiting on review",
      }),
    ).toMatchObject({ title: "Blocked waiting on review" });
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
