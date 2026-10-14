// @vitest-environment happy-dom

// A company bot that runs on this Mac (computeMode "local", for example buddy)
// is in the local bot list and on the cloud roster with the same uid. The page
// concatenated both lists and the keyed row list threw each_key_duplicate, so
// the Bots page showed "Something went wrong". It must list the bot once.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BotsPage from "./BotsPage.svelte";
import type { LocalBotRow } from "@hq/platform";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const buddy = {
  name: "buddy",
  agentUid: "agt_buddy",
  ownerUid: "prs_owner",
  runtime: "claude",
  state: "running",
  pid: 42,
  processAlive: true,
  hosting: "local",
  promotionHold: null,
  online: true,
  lastHeartbeatAt: null,
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/tmp/buddy",
  kind: "company",
  companies: ["indigo"],
} as unknown as LocalBotRow;

describe("BotsPage local and cloud dedupe", () => {
  it("lists a company bot running on this Mac once and does not throw", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const okEmpty = async () => ({ ok: true, value: [] });
    const api = (own: Record<string, unknown>) =>
      new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : okEmpty) });
    const adapter = new Proxy({
      agents: api({
        listMobileRoster: async () => ({
          ok: true,
          value: {
            agents: [
              { agentUid: "agt_buddy", displayName: "Buddy", companyUid: "cmp_indigo", computeMode: "local", setupPhase: "ready" },
              { agentUid: "agt_scout", displayName: "Scout", companyUid: "cmp_indigo", setupPhase: "ready" },
            ],
          },
        }),
      }),
    } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : k === "isAvailable" ? () => false : api({})) });
    const companies = [{ slug: "indigo", displayName: "Indigo", kind: "company", cloudUid: "cmp_indigo" }];
    component = mount(BotsPage, {
      target: document.body,
      props: { companyUid: "cmp_indigo", adapter, localBots: [buddy], companies } as never,
    });
    flushSync();
    await expect.poll(() => document.querySelector("[data-testid='bots-loader']")).toBeNull();
    const rows = [...document.querySelectorAll("[data-testid='bot-row']")].map((el) => el.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows.filter((text) => /buddy/i.test(text))).toHaveLength(1);
    expect(rows.some((text) => text.includes("Scout"))).toBe(true);
    const keyErrors = errors.mock.calls.filter((call) => String(call[0]).includes("each_key_duplicate"));
    expect(keyErrors).toHaveLength(0);
  });
});
