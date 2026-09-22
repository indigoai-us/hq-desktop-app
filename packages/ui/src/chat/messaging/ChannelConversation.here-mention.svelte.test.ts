// @vitest-environment happy-dom
/**
 * `@here` in the real composer: offered in a channel, absent in a 1:1 DM,
 * keyboard-selectable, chipped, and sent as ONE broadcast token.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ChannelConversation from "./ChannelConversation.svelte";
import type { MentionTarget } from "../mentions";

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

function setup(opts: {
  allowHereMention: boolean;
  onsend?: (body: string, mentions: MentionTarget[]) => void;
}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [],
      mentionCandidates: [ada],
      allowHereMention: opts.allowHereMention,
      onsend: opts.onsend ?? (() => {}),
    },
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

const pickerRows = () => [
  ...host!.querySelectorAll<HTMLButtonElement>('[data-testid="mention-picker"] button'),
];

async function pressEnter() {
  composer().dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await tick();
}

describe("@here in a channel composer", () => {
  it("is the first picker row on a bare @", async () => {
    setup({ allowHereMention: true });
    await tick();
    await type("hey @");
    expect(pickerRows()[0]?.getAttribute("data-testid")).toBe("mention-row-here");
    expect(pickerRows()[0]?.textContent).toContain("@here");
    expect(pickerRows()[0]?.textContent).toContain(
      "Notify everyone in this conversation",
    );
  });

  it("is keyboard-selectable — Enter on the highlighted row inserts it", async () => {
    setup({ allowHereMention: true });
    await tick();
    await type("standup @h");
    const row = pickerRows()[0]!;
    expect(row.getAttribute("aria-selected")).toBe("true");
    await pressEnter();
    expect(composer().value).toBe("standup @here ");
  });

  it("marks the selected row, and the selected style is a background only", async () => {
    setup({ allowHereMention: true });
    await tick();
    await type("hey @");
    const row = pickerRows()[0]!;
    expect(row.className).toContain("selected");
    expect(row.getAttribute("aria-selected")).toBe("true");

    // Selection states are a background highlight, never a left accent bar.
    // happy-dom does not resolve scoped Svelte styles, so assert the rule at
    // its source instead of reading a computed value that is always empty.
    const css = readFileSync(
      join(process.cwd(), "src/chat/messaging/MentionPicker.svelte"),
      "utf8",
    );
    const rule = /\.mention-row\.selected[\s\S]*?\{([\s\S]*?)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("background:");
    expect(rule![1]).not.toMatch(/border-left|box-shadow|outline/);
  });

  it("renders the picked @here as a mention chip in the composer", async () => {
    setup({ allowHereMention: true });
    await tick();
    await type("standup @h");
    pickerRows()[0]!.click();
    await tick();
    const chips = [...host!.querySelectorAll(".composer-mention")].map(
      (n) => n.textContent,
    );
    expect(chips).toContain("@here");
  });

  it("sends ONE broadcast token", async () => {
    const sent: Array<{ body: string; mentions: MentionTarget[] }> = [];
    setup({ allowHereMention: true, onsend: (body, mentions) => sent.push({ body, mentions }) });
    await tick();

    await type("standup @h");
    pickerRows()[0]!.click();
    await tick();
    host!.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("standup @here");
    expect(sent[0]!.mentions).toEqual([
      { participantUid: "here", participantType: "broadcast", displayName: "" },
    ]);
  });

  it("@here plus an explicit @person sends both, each once", async () => {
    const sent: MentionTarget[][] = [];
    setup({ allowHereMention: true, onsend: (_b, mentions) => sent.push(mentions) });
    await tick();

    await type("@Ad");
    const adaRow = pickerRows().find(
      (r) => r.getAttribute("data-testid") !== "mention-row-here",
    )!;
    adaRow.click();
    await tick();
    await type("@Ada and @h");
    pickerRows()[0]!.click();
    await tick();
    host!.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((m) => m.participantUid)).toEqual(["prs_ada", "here"]);
  });

  it("@heretic and a code-spanned @here send nothing", async () => {
    const sent: MentionTarget[][] = [];
    setup({ allowHereMention: true, onsend: (_b, mentions) => sent.push(mentions) });
    await tick();

    await type("standup @h");
    pickerRows()[0]!.click();
    await tick();
    await type("@heretic says `@here` is loud");
    host!.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
    await tick();

    expect(sent).toEqual([[]]);
  });
});

describe("@here in a 1:1 DM", () => {
  it("is never offered", async () => {
    setup({ allowHereMention: false });
    await tick();
    await type("hey @");
    expect(
      pickerRows().map((r) => r.getAttribute("data-testid")),
    ).not.toContain("mention-row-here");
    await type("hey @h");
    expect(host!.querySelector('[data-testid="mention-picker"]')?.textContent).toContain(
      "No one matches",
    );
  });
});
