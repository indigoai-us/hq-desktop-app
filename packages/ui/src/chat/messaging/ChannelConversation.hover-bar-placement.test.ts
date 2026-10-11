// @vitest-environment happy-dom
/**
 * The message hover bar and the open-thread highlight.
 *
 * 1. The bar floated at `top: -14px`, over the message ABOVE, and read as
 *    belonging to that one. It now opens 4px under the bubble's right edge,
 *    anchored to `.dm-msg-main` (bubble or card only, never the replies pill or
 *    the reaction row), with transparent 24px buttons and an invisible bridge
 *    across the 4px gap. The newest message flips it above the bubble so the
 *    scroller does not clip it (or grow its scroll height at rest).
 * 2. Run cards carry reactions but had no bar to add one. Lifecycle cards stay
 *    without it.
 * 3. The open thread tinted the whole message. Only its replies pill lights,
 *    and that pill toggles the thread shut.
 *
 * happy-dom does not compute scoped styles, so CSS is read from the stylesheet
 * the mounted conversation injects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const older = {
  eventId: "evt_old",
  direction: "in",
  fromPersonUid: "prs_ada",
  fromDisplayName: "Ada",
  body: "older message",
  createdAt: "2026-08-17T01:00:00.000Z",
  replyCount: 2,
};

const runCard = {
  eventId: "evt_run",
  direction: "in",
  fromPersonUid: "agt_izzy",
  fromDisplayName: "Izzy",
  body: "",
  createdAt: "2026-08-17T01:01:00.000Z",
  systemEvent: { v: 1, type: "run_complete", title: "run finished" },
};

const lifecycleCard = {
  eventId: "evt_card",
  direction: "in",
  fromDisplayName: "HQ",
  body: "",
  createdAt: "2026-08-17T01:02:00.000Z",
  systemEvent: {
    v: 1,
    type: "lifecycle_card",
    cardId: "card_create_1",
    kind: "create_company",
    companyUid: null,
    state: "open",
    title: "Name your company",
    fields: [
      { id: "name", label: "Company name", control: "text", required: true, value: "" },
    ],
    actions: [{ id: "submit", label: "Create", style: "primary" }],
    viewer: { canAct: true },
  },
};

const newest = {
  eventId: "evt_new",
  direction: "in",
  fromPersonUid: "prs_bob",
  fromDisplayName: "Bob",
  body: "newest message",
  createdAt: "2026-08-17T01:03:00.000Z",
  replyCount: 1,
};

async function render(props: Record<string, unknown> = {}): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [older, runCard, lifecycleCard, newest],
      humanOnly: false,
      mentionCandidates: [],
      allowHereMention: false,
      onsend: () => {},
      onreply: () => {},
      ...props,
    },
  });
  await tick();
  return host;
}

function css(): { selector: string; body: string }[] {
  const text = [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((t) => t.includes("dm-quick-react"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media\s*\(hover:\s*none\)\s*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");
  return [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap((m) =>
    m[1].split(",").map((selector) => ({
      selector: selector
        .replace(/:where\(\.svelte-[a-z0-9]+\)/g, "")
        .replace(/\.svelte-[a-z0-9]+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
      body: m[2],
    })),
  );
}

function decl(selector: string, prop: string): string | undefined {
  const bodies = css()
    .filter((r) => r.selector === selector)
    .map((r) => r.body);
  for (const body of bodies.reverse()) {
    const hit = body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
    if (hit) return hit[1].trim();
  }
  return undefined;
}

function row(root: HTMLElement, eventId: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-event-id="${eventId}"]`);
  if (!el) throw new Error(`no row ${eventId}`);
  return el;
}

describe("main timeline hover bar placement", () => {
  it("hangs off the bubble wrapper, not the pill or the reaction row", async () => {
    const root = await render();
    const message = row(root, "evt_old");
    const bar = message.querySelector(".dm-quick-react");
    expect(bar?.parentElement?.classList.contains("dm-msg-main")).toBe(true);
    const main = bar!.parentElement!;
    expect(main.querySelector(".dm-bubble")).not.toBeNull();
    expect(main.querySelector('[data-testid="message-replies"]')).toBeNull();
  });

  it("opens 4px under the message, right-aligned with its hover wash, instead of over the message above", async () => {
    await render();
    expect(decl(".dm-msg-main", "position")).toBe("relative");
    expect(decl(".dm-quick-react", "top")).toBe("100%");
    // The wash is the row; the bar's anchor sits inside the row's 8px end
    // padding, so it reaches back out by that much (owner review 2026-10-08).
    expect(decl(".dm-msg", "padding")).toBe("var(--msg-row-pad-y, 3px) 8px");
    expect(decl(".dm-quick-react", "right")).toBe("-8px");
    expect(decl(".dm-quick-react", "margin")).toBe("4px 0 0");
    expect(css().some((r) => /top:\s*-14px/.test(r.body) && r.selector === ".dm-quick-react")).toBe(false);
  });

  it("bridges the 4px gap so hover survives the trip to the bar", async () => {
    await render();
    expect(decl(".dm-quick-react::before", "content")).toBe('""');
    expect(decl(".dm-quick-react::before", "inset")).toBe("-6px -4px -4px");
  });

  it("flips above the bubble on the newest message only", async () => {
    const root = await render();
    expect(row(root, "evt_new").classList.contains("dm-msg-tail")).toBe(true);
    expect(row(root, "evt_old").classList.contains("dm-msg-tail")).toBe(false);
    expect(decl(".dm-msg-tail .dm-quick-react", "top")).toBe("auto");
    expect(decl(".dm-msg-tail .dm-quick-react", "bottom")).toBe("100%");
    expect(decl(".dm-msg-tail .dm-quick-react", "margin")).toBe("0 0 4px");
  });

  it("uses transparent 24px buttons", async () => {
    await render();
    expect(decl(".dm-quick-react-btn", "min-width")).toBe("24px");
    expect(decl(".dm-quick-react-btn", "height")).toBe("24px");
    expect(decl(".dm-quick-react-btn", "background")).toBe("transparent");
    expect(decl(".dm-quick-react-btn:hover", "background")).toBe("var(--hover)");
  });
});

describe("hover bar on cards", () => {
  it("renders on run cards, anchored to the card", async () => {
    const root = await render();
    const run = root.querySelector<HTMLElement>('[data-testid="run-complete-row"]');
    expect(run).not.toBeNull();
    const bar = run!.querySelector(".dm-quick-react");
    expect(bar).not.toBeNull();
    expect(bar?.parentElement?.classList.contains("dm-msg-main")).toBe(true);
    expect(bar?.querySelector('[aria-label^="React with"]')).not.toBeNull();
    expect(bar?.querySelector('[data-testid="message-react-more"]')).not.toBeNull();
    // No replies pill on a run card, so a thread started there could never be
    // found again: the card bar does not offer Reply.
    expect(bar?.querySelector('[data-testid="message-reply-quick"]')).toBeNull();
  });

  it("leaves lifecycle cards without a hover bar", async () => {
    const root = await render();
    const card = root.querySelector<HTMLElement>('[data-testid="lifecycle-card-row"]');
    expect(card).not.toBeNull();
    expect(card!.querySelector(".dm-quick-react")).toBeNull();
  });
});

describe("open thread highlight", () => {
  it("lights only the open thread's replies pill, not the whole message", async () => {
    const root = await render({ activeRootEventId: "evt_old" });
    const message = row(root, "evt_old");
    expect(message.classList.contains("dm-msg-reply-active")).toBe(true);
    const pill = message.querySelector('[data-testid="message-replies"]');
    expect(pill?.getAttribute("aria-expanded")).toBe("true");
    expect(
      row(root, "evt_new")
        .querySelector('[data-testid="message-replies"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");

    expect(decl(".dm-msg-reply-active", "background")).toBeUndefined();
    expect(decl(".dm-msg-reply-active .dm-replies-count", "background")).toBe(
      "var(--btn-bg)",
    );
    expect(decl(".dm-msg-reply-active .dm-replies-count", "border-color")).toBe(
      "var(--line2)",
    );
  });
});

describe("replies pill toggles its own thread", () => {
  it("closes the open thread when its own pill is clicked", async () => {
    const onreply = vi.fn();
    const onclosereply = vi.fn();
    const root = await render({ activeRootEventId: "evt_old", onreply, onclosereply });
    (
      row(root, "evt_old").querySelector('[data-testid="message-replies"]') as HTMLButtonElement
    ).click();
    expect(onclosereply).toHaveBeenCalledTimes(1);
    expect(onreply).not.toHaveBeenCalled();
  });

  it("opens a different thread from another message's pill", async () => {
    const onreply = vi.fn();
    const onclosereply = vi.fn();
    const root = await render({ activeRootEventId: "evt_old", onreply, onclosereply });
    (
      row(root, "evt_new").querySelector('[data-testid="message-replies"]') as HTMLButtonElement
    ).click();
    expect(onreply).toHaveBeenCalledWith("evt_new");
    expect(onclosereply).not.toHaveBeenCalled();
  });

  it("keeps the hover bar's Reply an opener, even on the open thread", async () => {
    const onreply = vi.fn();
    const onclosereply = vi.fn();
    const root = await render({ activeRootEventId: "evt_old", onreply, onclosereply });
    (
      row(root, "evt_old").querySelector('[data-testid="message-reply-quick"]') as HTMLButtonElement
    ).click();
    expect(onreply).toHaveBeenCalledWith("evt_old");
    expect(onclosereply).not.toHaveBeenCalled();
  });
});
