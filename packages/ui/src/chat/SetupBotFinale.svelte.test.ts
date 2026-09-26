// @vitest-environment happy-dom

// SetupBotFinale is the finish card under the setup bot's last message.
// Contract: the "Open in …" buttons show only for coding tools installed on
// this Mac, and the console button opens the HQ console through the host.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import SetupBotFinale from "./SetupBotFinale.svelte";
import { SETUP_BOT_CONSOLE_URL } from "./setup-bot";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(props: Record<string, unknown> = {}) {
  const handlers = { onclaude: vi.fn(), oncodex: vi.fn(), onopenurl: vi.fn(), ondismiss: vi.fn() };
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupBotFinale, {
    target: host,
    props: { hasClaude: true, hasCodex: true, ...handlers, ...props } as never,
  });
  flushSync();
  return { host, ...handlers };
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

describe("SetupBotFinale", () => {
  it("offers both coding tools when both are installed, and launches the one clicked", () => {
    const { host, onclaude, oncodex } = render();
    q(host, "setup-bot-finale-claude")!.click();
    q(host, "setup-bot-finale-codex")!.click();
    expect(onclaude).toHaveBeenCalledOnce();
    expect(oncodex).toHaveBeenCalledOnce();
  });

  it("shows only the coding tools found on this Mac", () => {
    const { host } = render({ hasClaude: true, hasCodex: false });
    expect(q(host, "setup-bot-finale-claude")).not.toBeNull();
    expect(q(host, "setup-bot-finale-codex")).toBeNull();
  });

  it("drops the whole tools row when neither tool is installed, but keeps the console", () => {
    const { host } = render({ hasClaude: false, hasCodex: false });
    expect(q(host, "setup-bot-finale-claude")).toBeNull();
    expect(q(host, "setup-bot-finale-codex")).toBeNull();
    expect(host.textContent).not.toMatch(/coding tool/i);
    expect(q(host, "setup-bot-finale-console")).not.toBeNull();
  });

  it("offers the bot in Slack only when the bot offered it, and asks the bot when clicked", () => {
    const onslack = vi.fn();
    const { host } = render({ slackLabel: "Put Pickles in Slack", onslack });
    const slack = q(host, "setup-bot-finale-slack")!;
    expect(slack.textContent).toContain("Put Pickles in Slack");
    expect(host.textContent).toContain("Workforce plan");
    expect(host.textContent!.toLowerCase()).not.toContain("agent");
    slack.click();
    expect(onslack).toHaveBeenCalledOnce();
  });

  it("offers no Slack bot unless the bot did (someone who joined a company)", () => {
    const { host } = render();
    expect(q(host, "setup-bot-finale-slack")).toBeNull();
    expect(host.textContent).not.toMatch(/slack/i);
  });

  it("the console button opens hq.computer through the host", () => {
    const { host, onopenurl } = render();
    q(host, "setup-bot-finale-console")!.click();
    expect(onopenurl).toHaveBeenCalledWith(SETUP_BOT_CONSOLE_URL);
    expect(SETUP_BOT_CONSOLE_URL).toBe("https://hq.computer");
  });

  it("says bot, never agent", () => {
    const { host } = render();
    expect(host.textContent!.toLowerCase()).not.toContain("agent");
  });

  it("shows a launch failure in plain words", () => {
    const { host } = render({ launchError: "HQ folder is not ready yet." });
    expect(q(host, "setup-bot-finale-error" as never)?.textContent ?? host.textContent).toContain("HQ folder is not ready yet.");
  });

  it("can be put away: the conversation carries on after setup ends", () => {
    const { host, ondismiss } = render();
    const close = q(host, "setup-bot-finale-dismiss")!;
    expect(close.getAttribute("aria-label")).toBe("Dismiss");
    close.click();
    expect(ondismiss).toHaveBeenCalledOnce();
  });
});