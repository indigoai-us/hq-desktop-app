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

const DONE_SAMPLE =
  '{"v":1,"kind":"work-session-event","threadId":"work-desktop-dogfood:T-002","event":{"kind":"done","at":"2026-08-28T15:14:05.854Z","by":"Stefan Johnson","summary":"T-002 marked done on the board"}}';

const ACTOR_UID = "94b82448-c021-70e7-6816-1a087e93eb11";

const UID_SAMPLE = DONE_SAMPLE.replace("Stefan Johnson", ACTOR_UID);

function mountWith(
  body: string,
  extraProps: Record<string, unknown> = {},
): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [
        {
          eventId: "evt_work_1",
          direction: "in",
          fromDisplayName: "work-mesh",
          body,
          createdAt: "2026-08-28T15:14:05.854Z",
        },
      ],
      ...extraProps,
    },
  });
  return host;
}

function rowText(root: HTMLDivElement): string {
  return root.querySelector(".work-mesh-row .text")?.textContent ?? "";
}

describe("ChannelConversation work-mesh activity rows", () => {
  it("renders a compact activity row instead of a raw JSON bubble", async () => {
    const root = mountWith(DONE_SAMPLE);
    await tick();
    expect(root.querySelector(".work-mesh-row")).not.toBeNull();
    expect(root.querySelector("pre.dm-plain")).toBeNull();
    expect(root.querySelector(".work-mesh-row")?.textContent).toContain(
      "Stefan Johnson",
    );
    expect(root.querySelector(".work-mesh-row")?.textContent).toContain(
      "marked T-002 done",
    );
  });

  it("parses a json-fenced work-session-event the same way", async () => {
    const root = mountWith("```json\n" + DONE_SAMPLE + "\n```");
    await tick();
    expect(root.querySelector(".work-mesh-row")).not.toBeNull();
    expect(root.querySelector("pre.dm-plain")).toBeNull();
  });

  it("renders single spaces between actor, verb phrase, and em-dash title", async () => {
    const root = mountWith(DONE_SAMPLE);
    await tick();
    expect(rowText(root)).toBe(
      "Stefan Johnson marked T-002 done — T-002 marked done on the board",
    );
  });

  it("resolves a UID actor via the live roster map", async () => {
    const root = mountWith(UID_SAMPLE, {
      displayNameByUid: { [ACTOR_UID]: "Stefan Johnson" },
    });
    await tick();
    expect(rowText(root)).toContain("Stefan Johnson marked T-002 done");
    expect(rowText(root)).not.toContain(ACTOR_UID);
  });

  it("falls back to a compact label, never the raw UUID", async () => {
    const root = mountWith(UID_SAMPLE);
    await tick();
    expect(rowText(root)).toContain("A teammate marked T-002 done");
    expect(rowText(root)).not.toContain(ACTOR_UID);
  });
});
