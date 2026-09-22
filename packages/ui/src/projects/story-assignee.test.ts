// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import StoryCard from "./StoryCard.svelte";
import StoryPanel from "../home/StoryPanel.svelte";
import type { Story, StoryIdentity } from "./projects-model.js";

const person: StoryIdentity = {
  uid: "prs_ada",
  kind: "person",
  displayName: "Ada Lovelace",
  avatarRef: { base64: "abc" },
};

const agent: StoryIdentity = {
  uid: "agt_runner",
  kind: "agent",
  displayName: "Runner",
  avatarRef: null,
};

const broken: StoryIdentity = {
  uid: "prs_pat",
  kind: "person",
  displayName: "Pat",
  avatarRef: { url: "http://not-allowed.example/a.png" },
};

function story(assignee: StoryIdentity | null, lastActor: StoryIdentity | null = null): Story {
  return {
    id: "US-013",
    title: "Show the assignee",
    description: "Detail",
    acceptanceCriteria: ["visible"],
    passes: false,
    labels: [],
    dependsOn: [],
    assignee,
    lastActor,
  };
}

let host: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (host) await unmount(host);
  host = null;
  document.body.replaceChildren();
});

async function reset(): Promise<void> {
  if (host) await unmount(host);
  host = null;
  document.body.replaceChildren();
}

function cardText(item: Story): string {
  host = mount(StoryCard, { target: document.body, props: { story: item } });
  flushSync();
  return document.querySelector("[data-testid='story-assignee']")?.textContent ?? "";
}

function panelText(item: Story): { assignee: string; actor: string; mark: string } {
  host = mount(StoryPanel, {
    target: document.body,
    props: {
      story: item,
      project: null,
      prdPath: "",
      onclose: () => {},
    },
  });
  flushSync();
  return {
    assignee: document.querySelector("[data-testid='story-assignee']")?.textContent ?? "",
    actor: document.querySelector("[data-testid='story-last-actor']")?.textContent ?? "",
    mark: document.querySelector("[data-testid='story-assignee'] .identity")?.getAttribute("data-kind") ?? "",
  };
}

describe("story assignee on the card and in the detail", () => {
  it("shows a person on the card and the last actor in the detail", async () => {
    expect(cardText(story(person, agent))).toContain("Ada Lovelace");
    expect(document.querySelector("[data-testid='story-assignee'] img")).toBeTruthy();
    await reset();
    const detail = panelText(story(person, agent));
    expect(detail.assignee).toContain("Ada Lovelace");
    expect(detail.actor).toContain("Runner");
    expect(detail.mark).toBe("person");
  });

  it("uses the generated agent mark when the agent has no photo", async () => {
    expect(cardText(story(agent))).toContain("Runner");
    expect(document.querySelector("[data-testid='story-assignee'] img")?.getAttribute("src")).toBeTruthy();
    await reset();
    const detail = panelText(story(agent, agent));
    expect(detail.mark).toBe("agent");
    expect(detail.actor).toContain("Runner");
  });

  it("falls back to initials when the avatar cannot be painted", async () => {
    expect(cardText(story(broken))).toContain("Pat");
    expect(document.querySelector("[data-testid='story-assignee'] img")).toBeNull();
    expect(document.querySelector("[data-testid='story-assignee'] .monogram")?.textContent).toBe("PA");
    await reset();
    const detail = panelText(story(broken, null));
    expect(detail.assignee).toContain("Pat");
    expect(detail.actor).toContain("Not recorded");
  });

  it("says Unassigned when the hydrated assignee is null", async () => {
    expect(cardText(story(null))).toContain("Unassigned");
    await reset();
    const detail = panelText(story(null, null));
    expect(detail.assignee).toContain("Unassigned");
    expect(detail.actor).toContain("Not recorded");
  });
});
