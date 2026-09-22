// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { MentionTarget } from "../mentions";

/**
 * Regression: a mention picked from the @-picker and then deleted from the
 * draft must not be sent. The server invites every mentioned person to the
 * channel, so a stale pick invited people the sender had removed on purpose.
 */

let component: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const ada: MentionTarget = {
  participantUid: "prs_ada",
  participantType: "human",
  displayName: "Ada",
};
const bob: MentionTarget = {
  participantUid: "prs_bob",
  participantType: "human",
  displayName: "Bob",
};

function setup(onsend: (body: string, mentions: MentionTarget[]) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages: [], mentionCandidates: [ada, bob], onsend },
  });
}

const composer = () =>
  host!.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]')!;

async function type(text: string) {
  const el = composer();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

async function pickFirstMention() {
  const option = host!.querySelector<HTMLButtonElement>(
    '[data-testid="mention-picker"] button',
  );
  expect(option).not.toBeNull();
  option!.click();
  await tick();
}

describe("ChannelConversation mentions removed before send", () => {
  it("sends only the mentions still present in the body", async () => {
    const sent: Array<{ body: string; mentions: MentionTarget[] }> = [];
    setup((body, mentions) => sent.push({ body, mentions }));
    await tick();

    await type("hey @Ad");
    await pickFirstMention();
    expect(composer().value).toBe("hey @Ada ");
    await type("hey @Ada and @Bo");
    await pickFirstMention();
    expect(composer().value).toBe("hey @Ada and @Bob ");

    // Change of mind: delete Ada's mention, keep Bob's.
    await type("hey and @Bob ");
    host!.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe("hey and @Bob");
    expect(sent[0].mentions.map((m) => m.participantUid)).toEqual(["prs_bob"]);
  });

  it("sends no mentions when every picked mention was deleted", async () => {
    const sent: MentionTarget[][] = [];
    setup((_body, mentions) => sent.push(mentions));
    await tick();

    await type("@Ad");
    await pickFirstMention();
    await type("never mind");
    host!.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
    await tick();

    expect(sent).toEqual([[]]);
  });
});
