import { describe, expect, it } from "vitest";
import {
  parseAttachment,
  parseLifecycleCard,
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

describe("parseSystemEvent — lifecycle_card", () => {
  const envelope = {
    v: 1 as const,
    type: "lifecycle_card",
    cardId: "card_create_1",
    kind: "create_company",
    companyUid: null,
    state: "open",
    title: "Name your company",
    fields: [
      { id: "name", label: "Company name", control: "text", required: true },
      { id: "slug", label: "Slug", control: "text", required: true },
    ],
    actions: [{ id: "submit", label: "Create", style: "primary" }],
    viewer: { canAct: true },
  };

  it("parses a v1 LifecycleCardModel", () => {
    const model = parseSystemEvent(envelope);
    expect(model).toMatchObject({
      kind: "lifecycle_card",
      cardId: "card_create_1",
      cardKind: "create_company",
      companyUid: null,
      state: "open",
      title: "Name your company",
      viewer: { canAct: true },
    });
    expect(parseLifecycleCard(envelope)?.fields).toHaveLength(2);
  });

  it("parses every known kind including companies_summary", () => {
    for (const kind of [
      "create_company",
      "activate_cloud",
      "upgrade_plan",
      "create_agent",
      "status",
      "companies_summary",
      "tab_row",
    ] as const) {
      const parsed = parseLifecycleCard({
        ...envelope,
        kind,
        companyUid:
          kind === "create_company" || kind === "companies_summary"
            ? null
            : "cmp_acme",
      });
      expect(parsed?.cardKind).toBe(kind);
    }
  });

  it("returns null for an unknown version", () => {
    expect(parseSystemEvent({ ...envelope, v: 2 })).toBeNull();
    expect(parseLifecycleCard({ ...envelope, v: 2 })).toBeNull();
  });

  it("returns null for invalid kind, state, or missing cardId", () => {
    expect(parseLifecycleCard({ ...envelope, cardId: "" })).toBeNull();
    expect(parseLifecycleCard({ ...envelope, kind: "nope" })).toBeNull();
    expect(parseLifecycleCard({ ...envelope, state: "running" })).toBeNull();
    expect(
      parseLifecycleCard({
        ...envelope,
        kind: "activate_cloud",
        companyUid: null,
      }),
    ).toBeNull();
  });

  it("stamps viewer.canAct false and keeps the actor name", () => {
    const model = parseLifecycleCard({
      ...envelope,
      viewer: { canAct: false, actorName: "Corey Epstein" },
    });
    expect(model?.viewer).toEqual({
      canAct: false,
      actorName: "Corey Epstein",
    });
  });

  it("parses radio options with prices and field errors", () => {
    const model = parseLifecycleCard({
      ...envelope,
      kind: "upgrade_plan",
      companyUid: "cmp_acme",
      fields: [
        {
          id: "plan",
          label: "Plan",
          control: "radio",
          value: "workforce",
          options: [
            {
              id: "workforce",
              label: "Workforce",
              description: "Unlimited people, agents, every integration",
              price: "$500 / mo",
            },
          ],
          error: "Checkout is paused",
        },
      ],
    });
    expect(model?.fields[0]).toMatchObject({
      control: "radio",
      error: "Checkout is paused",
      options: [
        {
          id: "workforce",
          label: "Workforce",
          price: "$500 / mo",
        },
      ],
    });
  });

  it("does not hide a parseable lifecycle_card system message", () => {
    expect(
      shouldHideSystemMessage({
        messageKind: "system",
        systemEvent: envelope,
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
