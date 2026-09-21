// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import { isHeavyMessageBody } from "../../common/messageMarkdown.js";
import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function line(prefix: string, length: number): string {
  if (prefix.length > length) throw new Error("fixture line prefix is too long");
  return `${prefix}${"detail ".repeat(length)}`.slice(0, length);
}

function buildLongChannelPost(): string {
  const lines = [
    line("@Corey @Jacob Posel @george @sheister", 40),
    "",
    line("Programme readout - in progress: ", 170),
    "",
    line("• First status point: ", 433),
    line("• Second status point: ", 350),
    line("• Third status point: ", 340),
    line("• Fourth status point: ", 330),
    line("• Fifth status point: ", 320),
    line("• Sixth status point: ", 310),
    "",
    line("Next: verify the live path. ", 130),
    line("Next: report the result. ", 130),
    "",
  ];
  const beforeNeed = lines.join("\n");
  const needLength = 2_617 - beforeNeed.length - 1;
  return `${beforeNeed}\n${line("Need from you: confirm the result. ", needLength)}`;
}

const LONG_CHANNEL_POST = buildLongChannelPost();

describe("ChannelConversation long prose", () => {
  it("keeps a 2,617-character HQ status post with Unicode bullets as wrapped prose", async () => {
    expect(LONG_CHANNEL_POST).toHaveLength(2_617);
    expect(
      Math.max(...LONG_CHANNEL_POST.split("\n").map((row) => row.length)),
    ).toBe(433);
    expect(isHeavyMessageBody(LONG_CHANNEL_POST)).toBe(false);

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [
          {
            eventId: "evt_long_status",
            direction: "in",
            fromPersonUid: "prs_stefan",
            fromDisplayName: "Stefan Johnson",
            body: LONG_CHANNEL_POST,
            mentions: [
              {
                participantUid: "prs_corey",
                participantType: "human",
                displayName: "Corey Epstein",
              },
            ],
            createdAt: "2026-09-21T18:00:00.000Z",
          },
        ],
      },
    });
    await tick();

    const body = host.querySelector(".dm-bubble-body");
    expect(body?.querySelector("pre")).toBeNull();
    expect(body?.querySelector('[data-testid="plain-body-toggle"]')).toBeNull();
    expect(body?.textContent).toContain("Need from you: confirm the result.");
  });
});
