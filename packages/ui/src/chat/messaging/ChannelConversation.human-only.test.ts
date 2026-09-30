// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const MESH_BODY =
  '{"v":1,"kind":"work-session-event","threadId":"work-desktop-dogfood:T-002","event":{"kind":"done","at":"2026-08-28T15:14:05.854Z","by":"Stefan Johnson","summary":"T-002 marked done on the board"}}';

function mountWith(props: Record<string, unknown>): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [
        {
          eventId: "evt_mesh",
          direction: "in",
          fromDisplayName: "work-mesh",
          body: MESH_BODY,
          createdAt: "2026-08-28T15:14:05.000Z",
        },
        {
          eventId: "evt_human",
          direction: "in",
          fromDisplayName: "Ada",
          body: "hello there",
          createdAt: "2026-08-28T15:14:10.000Z",
        },
        {
          eventId: "evt_bot",
          direction: "in",
          fromDisplayName: "Izzy",
          fromPersonUid: "bot_izzy",
          audience: "bot",
          body: "an automated ping",
          createdAt: "2026-08-28T15:14:15.000Z",
        },
      ],
      ...props,
    },
  });
  return host;
}

describe("ChannelConversation human-only mode", () => {
  it("flag off: renders the work-mesh row and both other messages", async () => {
    const root = mountWith({ humanOnly: false });
    await tick();
    expect(root.querySelector(".work-mesh-row")).not.toBeNull();
    expect(root.textContent).toContain("hello there");
    expect(root.textContent).toContain("an automated ping");
  });

  it("flag on: hides work-mesh and bot-audience rows, keeps human message", async () => {
    const root = mountWith({ humanOnly: true });
    await tick();
    expect(root.querySelector(".work-mesh-row")).toBeNull();
    expect(root.textContent).toContain("hello there");
    expect(root.textContent).not.toContain("an automated ping");
  });

  it("default-on: hides noted, started and completed rows and bot audience, keeps human and bot replies with audience both", async () => {
    const event = (kind: string, summary: string) =>
      JSON.stringify({
        v: 1,
        kind: "work-session-event",
        threadId: "work-desktop-dogfood:T-003",
        event: { kind, at: "2026-08-28T15:14:05.854Z", by: "Stefan Johnson", summary },
      });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        messages: [
          { eventId: "e_note", direction: "in", fromDisplayName: "Stefan Johnson", body: event("note", "noted-summary-xyz"), createdAt: "2026-08-28T15:14:01.000Z" },
          { eventId: "e_start", direction: "in", fromDisplayName: "Stefan Johnson", body: event("start", "started-summary-xyz"), createdAt: "2026-08-28T15:14:02.000Z" },
          { eventId: "e_done", direction: "in", fromDisplayName: "work-mesh", systemEvent: { v: 1, type: "run_complete", title: "completed-line-xyz" }, body: "", createdAt: "2026-08-28T15:14:03.000Z" },
          { eventId: "e_botaud", direction: "in", fromDisplayName: "Izzy", fromPersonUid: "bot_izzy", audience: "bot", body: "bot-audience-xyz", createdAt: "2026-08-28T15:14:04.000Z" },
          { eventId: "e_human", direction: "in", fromDisplayName: "Ada", audience: "human", body: "human-hello-xyz", createdAt: "2026-08-28T15:14:05.000Z" },
          { eventId: "e_both", direction: "in", fromDisplayName: "Izzy", fromPersonUid: "bot_izzy", audience: "both", body: "bot-reply-both-xyz", createdAt: "2026-08-28T15:14:06.000Z" },
        ],
      },
    });
    await tick();
    const text = host.textContent ?? "";
    expect(host.querySelector(".work-mesh-row")).toBeNull();
    expect(text).not.toContain("noted-summary-xyz");
    expect(text).not.toContain("started-summary-xyz");
    expect(text).not.toContain("completed-line-xyz");
    expect(text).not.toContain("bot-audience-xyz");
    expect(text).toContain("human-hello-xyz");
    expect(text).toContain("bot-reply-both-xyz");
  });

  it("default-on: a channel with only non-human rows shows the empty state", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        messages: [
          { eventId: "evt_mesh", direction: "in", fromDisplayName: "Stefan Johnson", body: MESH_BODY, createdAt: "2026-08-28T15:14:05.000Z" },
          { eventId: "e_sys", direction: "in", fromDisplayName: "work-mesh", systemEvent: { v: 1, type: "run_complete", title: "done" }, body: "", createdAt: "2026-08-28T15:14:06.000Z" },
        ],
      },
    });
    await tick();
    expect(host.querySelector('[data-testid="conversation-empty"]')).not.toBeNull();
    expect(host.querySelector(".work-mesh-row")).toBeNull();
  });

  it("default-on: hides person-attributed activity rows (isMeshEvent:true + wm: prefix) even when actor is a named human", async () => {
    // Regression: before the fix, activityTimelineMessages() did not stamp isMeshEvent:true.
    // A row like "Stefan Johnson noted - persona=marketer …" carried a real person uid and
    // a display name, so isHumanMessage fell through uid-prefix heuristics and kept it.
    const activityBody = JSON.stringify({
      kind: "work-session-event",
      threadId: "work-desktop-dogfood:T-010",
      eventId: "ev-note-abc",
      event: {
        kind: "note",
        by: "Stefan Johnson",
        byUid: "prs_01KRKKKZYQM2SS0TWMG7NRKY0Y",
        actorType: "human",
        at: "2026-09-04T10:00:00.000Z",
        summary: "persona=marketer outcome=finished_by_session minutes=49.5 stuck=session",
      },
      payload: { storyId: "T-010", storyTitle: "hq-onboarding-experience" },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        messages: [
          // Activity row: person uid, display name "Stefan Johnson", isMeshEvent:true, wm: prefix
          {
            eventId: "wm:ev-note-abc",
            direction: "in" as const,
            fromPersonUid: "prs_01KRKKKZYQM2SS0TWMG7NRKY0Y",
            fromDisplayName: "Stefan Johnson",
            body: activityBody,
            createdAt: "2026-09-04T10:00:00.000Z",
            isMeshEvent: true,
          },
          // Real typed message by the same person - must survive
          {
            eventId: "msg-stefan-typed",
            direction: "in" as const,
            fromPersonUid: "prs_01KRKKKZYQM2SS0TWMG7NRKY0Y",
            fromDisplayName: "Stefan Johnson",
            body: "stefan-typed-real-message-xyz",
            createdAt: "2026-09-04T10:01:00.000Z",
          },
        ],
      },
    });
    await tick();
    const text = host.textContent ?? "";
    expect(host.querySelector(".work-mesh-row")).toBeNull();
    expect(text).not.toContain("persona=marketer");
    expect(text).toContain("stefan-typed-real-message-xyz");
  });

  it("default-on: hides the four screenshot row shapes attributed to Stefan Johnson", async () => {
    // Wire shapes from the Indigo owner's screenshot (scrubbed).
    const personUid = "prs_01KRKKKZYQM2SS0TWMG7NRKY0Y";
    const makeActivityRow = (
      eventId: string,
      kind: string,
      summary: string,
      storyTitle: string,
      index: number,
    ) => ({
      eventId: `wm:${eventId}`,
      direction: "in" as const,
      fromPersonUid: personUid,
      fromDisplayName: "Stefan Johnson",
      isMeshEvent: true as const,
      createdAt: `2026-09-04T10:0${index}:00.000Z`,
      body: JSON.stringify({
        kind: "work-session-event",
        threadId: `work-desktop-dogfood:T-0${index + 10}`,
        eventId,
        event: { kind, by: "Stefan Johnson", byUid: personUid, actorType: "human", at: `2026-09-04T10:0${index}:00.000Z`, summary },
        payload: { storyTitle },
      }),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        messages: [
          makeActivityRow("ev-a", "note", "persona=marketer outcome=finished_by_session minutes=49.5 stuck=session", "hq-onboarding-experience", 0),
          makeActivityRow("ev-b", "progress", "All three wizards parse. (3 turns)", "hq-onboarding-experience", 1),
          makeActivityRow("ev-c", "progress", "worked on hq-onboarding-experience (1 turn)", "hq-onboarding-experience", 2),
          makeActivityRow("ev-d", "done", "completed", "New bot wizard crashes on Windows with a Svelte each_key_duplicate error", 3),
          // One real human message — must survive
          {
            eventId: "msg-human-real",
            direction: "in" as const,
            fromPersonUid: personUid,
            fromDisplayName: "Stefan Johnson",
            body: "stefan-real-typed-xyz",
            createdAt: "2026-09-04T10:05:00.000Z",
          },
        ],
      },
    });
    await tick();
    const text = host.textContent ?? "";
    expect(host.querySelectorAll(".work-mesh-row")).toHaveLength(0);
    expect(text).not.toContain("persona=marketer");
    expect(text).not.toContain("All three wizards parse");
    expect(text).not.toContain("worked on hq-onboarding-experience");
    expect(text).toContain("stefan-real-typed-xyz");
  });

  it("default-on: newest 55 mesh rows + older human rows renders humans without clicks (no empty pane)", async () => {
    // Owner report shape: newest window is all work-mesh, older messages are human.
    // Before the fix, windowing ran on RAW rows so the visible pane was empty and
    // showed "No activity yet" with a "Show 55 earlier messages" button.
    const mesh = Array.from({ length: 55 }, (_, i) => ({
      eventId: `evt_mesh_${i}`,
      direction: "in" as const,
      fromDisplayName: "work-mesh",
      body: MESH_BODY,
      createdAt: `2026-08-28T15:${String(20 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      isMeshEvent: true as const,
    }));
    const humans = [
      { eventId: "h1", direction: "in" as const, fromDisplayName: "Ada", body: "human-earlier-alpha-xyz", createdAt: "2026-08-28T15:10:00.000Z" },
      { eventId: "h2", direction: "in" as const, fromDisplayName: "Ada", body: "human-earlier-beta-xyz", createdAt: "2026-08-28T15:11:00.000Z" },
      { eventId: "h3", direction: "in" as const, fromDisplayName: "Ada", body: "human-earlier-gamma-xyz", createdAt: "2026-08-28T15:12:00.000Z" },
    ];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: { humanOnly: true, messages: [...humans, ...mesh] },
    });
    await tick();
    const text = host.textContent ?? "";
    expect(host.querySelector('[data-testid="conversation-empty"]')).toBeNull();
    expect(text).toContain("human-earlier-alpha-xyz");
    expect(text).toContain("human-earlier-beta-xyz");
    expect(text).toContain("human-earlier-gamma-xyz");
    // No "Show N earlier messages" button because nothing visible is hidden.
    expect(host.querySelector('[data-testid="conversation-load-earlier"]')).toBeNull();
  });

  it("default-on: 'Show N earlier' count is the visible count, not the raw count", async () => {
    // 25 visible human rows total; window is 20 (TIMELINE_WINDOW) so 5 are
    // hidden. Interleaved mesh rows must NOT be added into the count.
    const rows: unknown[] = [];
    for (let i = 0; i < 25; i += 1) {
      rows.push({
        eventId: `h_${i}`,
        direction: "in" as const,
        fromDisplayName: "Ada",
        body: `human-msg-${i}-xyz`,
        createdAt: `2026-08-28T14:${String(i).padStart(2, "0")}:00.000Z`,
      });
      rows.push({
        eventId: `m_${i}`,
        direction: "in" as const,
        fromDisplayName: "work-mesh",
        body: MESH_BODY,
        createdAt: `2026-08-28T14:${String(i).padStart(2, "0")}:30.000Z`,
        isMeshEvent: true as const,
      });
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: { humanOnly: true, messages: rows as never },
    });
    await tick();
    const btn = host.querySelector('[data-testid="conversation-load-earlier"]');
    expect(btn).not.toBeNull();
    expect(btn?.textContent ?? "").toContain("Show 5 earlier messages");
  });

  it("default-on: auto-fetches older pages when local window is empty but server has more", async () => {
    let calls = 0;
    const onloadearlier = async () => {
      calls += 1;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        hasEarlier: true,
        onloadearlier,
        messages: [
          { eventId: "evt_mesh_only", direction: "in" as const, fromDisplayName: "work-mesh", body: MESH_BODY, createdAt: "2026-08-28T15:14:05.000Z", isMeshEvent: true as const },
        ],
      },
    });
    await tick();
    await tick();
    await tick();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("default-on: auto-fetch is bounded even if every page is mesh-only", async () => {
    let calls = 0;
    const onloadearlier = async () => {
      calls += 1;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        hasEarlier: true,
        onloadearlier,
        messages: [
          { eventId: "evt_mesh_only_b", direction: "in" as const, fromDisplayName: "work-mesh", body: MESH_BODY, createdAt: "2026-08-28T15:14:05.000Z", isMeshEvent: true as const },
        ],
      },
    });
    // Give the effect several ticks to run through the cap.
    for (let i = 0; i < 20; i += 1) await tick();
    expect(calls).toBeLessThanOrEqual(5);
  });

  it("flag off: auto-fetch is NOT triggered by an empty local page", async () => {
    let calls = 0;
    const onloadearlier = async () => {
      calls += 1;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: false,
        hasEarlier: true,
        onloadearlier,
        messages: [],
      },
    });
    for (let i = 0; i < 5; i += 1) await tick();
    expect(calls).toBe(0);
  });

  it("default-on: keeps untagged agent replies and actionable lifecycle cards", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        messages: [
          { eventId: "e_agent", direction: "in", fromDisplayName: "Izzy", fromPersonUid: "agt_izzy", body: "agent-reply-untagged-xyz", createdAt: "2026-08-28T15:14:01.000Z" },
          {
            eventId: "e_card",
            direction: "in",
            fromDisplayName: "HQ",
            body: "",
            createdAt: "2026-08-28T15:14:02.000Z",
            systemEvent: {
              v: 1,
              type: "lifecycle_card",
              cardId: "card_create_1",
              kind: "create_company",
              companyUid: null,
              state: "open",
              title: "Name your company",
              fields: [{ id: "name", label: "Company name", control: "text", required: true, value: "" }],
              actions: [{ id: "submit", label: "Create", style: "primary" }],
              viewer: { canAct: true },
            },
          },
        ],
      },
    });
    await tick();
    expect(host.textContent).toContain("agent-reply-untagged-xyz");
    expect(host.querySelector('[data-testid="lifecycle-card"]')).not.toBeNull();
  });
});
