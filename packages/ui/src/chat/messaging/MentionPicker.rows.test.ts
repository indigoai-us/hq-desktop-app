// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";

import MentionPicker from "./MentionPicker.svelte";
import {
  collapseDuplicateMentionTargets,
  type MentionTarget,
} from "../mentions.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(hits: MentionTarget[]): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MentionPicker, {
    target: host,
    props: { hits, highlight: 0, onpick: () => {} },
  });
  return host;
}

interface RenderedRow {
  name: string;
  pill: string | null;
  sub: string;
  aria: string;
}

function rows(el: HTMLElement): RenderedRow[] {
  return [...el.querySelectorAll(".mention-row")].map((row) => {
    const pill = row.querySelector('[data-testid="mention-disambiguator"]');
    return {
      name: row.querySelector(".mention-name")?.firstChild?.textContent ?? "",
      pill: pill?.textContent?.trim() ?? null,
      sub: row.querySelector(".mention-sub")?.textContent?.trim() ?? "",
      aria: row.getAttribute("aria-label") ?? "",
    };
  });
}

describe("MentionPicker rows", () => {
  it("shows the company as the pill for an agent, never a uid fragment", () => {
    const el = render([
      {
        participantUid: "agt_5RPNSHMTP5PP3DDCD0ZF906VYS",
        participantType: "agent",
        displayName: "Izzy",
        companyUid: "cmp_indigo",
        companyName: "Indigo",
      },
    ]);
    expect(rows(el)).toEqual([
      { name: "Izzy", pill: "Indigo", sub: "Agent", aria: "Izzy" },
    ]);
    expect(el.textContent).not.toContain("906VYS");
  });

  it("renders no pill for an agent whose company never resolved", () => {
    const el = render([
      {
        participantUid: "agt_5RPNSHMTP5PP3DDCD0ZF906VYS",
        participantType: "agent",
        displayName: "Izzy",
      },
    ]);
    expect(rows(el)).toEqual([
      { name: "Izzy", pill: null, sub: "Agent", aria: "Izzy" },
    ]);
    expect(el.textContent).not.toContain("906VYS");
  });

  it("keeps a human's email as the subtitle", () => {
    const el = render([
      {
        participantUid: "prs_scouty",
        participantType: "human",
        displayName: "Scouty",
        email: "scouty@getindigo.ai",
      },
    ]);
    expect(rows(el)[0]?.sub).toBe("scouty@getindigo.ai");
  });

  it("keeps both same-named agents and labels each with its company", () => {
    const el = render(
      collapseDuplicateMentionTargets([
        {
          participantUid: "agt_izzy_lr",
          participantType: "agent",
          displayName: "Izzy",
          companyName: "LiveRecover",
        },
        {
          participantUid: "agt_izzy_indigo",
          participantType: "agent",
          displayName: "Izzy",
          companyName: "Indigo",
        },
      ]),
    );
    expect(rows(el).map((row) => row.pill)).toEqual(["Indigo", "LiveRecover"]);
  });
});
