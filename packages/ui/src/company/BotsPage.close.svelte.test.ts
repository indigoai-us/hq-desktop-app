// @vitest-environment happy-dom

// QA-093: Close profile and Escape dismiss the bot inspector. Before the fix
// the close handler cleared the selection and the first-row fallback put the
// same profile straight back.

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import BotsPage from "./BotsPage.svelte";
import { overlayDepth } from "../common/dismissable.js";
import type { LocalBotRow } from "@hq/platform";

let component: ReturnType<typeof mount> | null = null;

const localBots = [
  { agentUid: "agt_drlove", name: "dr-love", displayName: "dr-love", state: "idle", runtime: "claude" },
  { agentUid: "agt_other", name: "other", displayName: "other", state: "idle", runtime: "claude" },
] as unknown as LocalBotRow[];

async function until<T>(read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync();
  }
  throw new Error("timed out waiting for UI");
}

async function openPage(): Promise<void> {
  component = mount(BotsPage, { target: document.body, props: { companyUid: "cmp_gt", localBots } });
  flushSync();
  await tick();
}

const inspector = () => document.querySelector('[data-testid="bot-inspector"]');

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

describe("BotsPage inspector close (QA-093)", () => {
  it("Close profile removes the inspector and clears the row selection", async () => {
    await openPage();
    const close = await until(() => document.querySelector<HTMLButtonElement>('[data-testid="bot-profile-close"]'));
    close.click();
    flushSync();
    expect(inspector()).toBeNull();
    expect(document.querySelector('.bot-row.is-selected')).toBeNull();
    expect(overlayDepth()).toBe(0);
  });

  it("Escape removes the inspector through the shared overlay layer", async () => {
    await openPage();
    await until(() => document.querySelector('[data-testid="bot-profile-close"]'));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    flushSync();
    expect(inspector()).toBeNull();
  });

  it("picking a row after closing opens that bot's profile again", async () => {
    await openPage();
    (await until(() => document.querySelector<HTMLButtonElement>('[data-testid="bot-profile-close"]'))).click();
    flushSync();
    document.querySelectorAll<HTMLButtonElement>('[data-testid="bot-row"]')[1]!.click();
    flushSync();
    expect(inspector()).not.toBeNull();
    expect(document.querySelector('.bot-row.is-selected')?.textContent).toContain("other");
  });
});
