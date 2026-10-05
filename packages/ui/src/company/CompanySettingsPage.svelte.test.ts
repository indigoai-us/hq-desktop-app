// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import CompanySettingsPage from "./CompanySettingsPage.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

// OWNER-R24: each settings area is its own company panel pane; the seat
// card (formerly HQ Workforce) sits at the top of Billing.
const current = $state({ section: "general" });
function render(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  current.section = "general";
  const all = { companyLabel: "Unicom", ...props, get section() { return current.section; } };
  mounted.push(mount(CompanySettingsPage, { target, props: all as never }));
  flushSync();
  return target;
}

function openWorkforce(_target: HTMLElement): void {
  current.section = "billing";
  flushSync();
}

function text(target: HTMLElement, id: string): string {
  return target.querySelector(`[data-testid='${id}']`)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("CompanySettingsPage HQ Workforce seats (QA-046)", () => {
  it("counts seats from the Team roster, agents separately, and re-reads on revisit", async () => {
    let roster: unknown[] = [
      { personUid: "prs_ana", displayName: "Ana" },
      { personUid: "prs_bo", displayName: "Bo" },
      { personUid: "agt_scout", displayName: "Scout", kind: "agent" },
    ];
    const company = {
      getTeamTelemetry: vi.fn(async () => ({ ok: true as const, value: { perMember: [] } })),
      listMembers: vi.fn(async () => ({ ok: true as const, value: [] })),
    };
    const messaging = { listContacts: vi.fn(async () => ({ ok: true as const, value: roster })) };
    const target = render({ slug: "unicom-qa046", companyUid: "cmp_unicom", company, messaging });
    openWorkforce(target);
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "workforce-seats")).toMatch(/^2Seats used/);
    });
    expect(text(target, "workforce-seats")).not.toContain("0 of 10");
    expect(text(target, "workforce-agents")).toMatch(/^1Hosted agents/);
    expect(text(target, "workforce-limit-unavailable")).toContain("not available");
    expect(messaging.listContacts).toHaveBeenCalledWith({ companyUid: "cmp_unicom" });
    // Owner 2026-10-05: Billing shows the counts only, not a row per roster member.
    expect(target.querySelectorAll("[data-testid='company-settings'] .line")).toHaveLength(0);
    expect(target.textContent).not.toContain("Scout");

    roster = [...roster, { personUid: "prs_cy", displayName: "Cy" }];
    current.section = "general";
    flushSync();
    openWorkforce(target);
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "workforce-seats")).toMatch(/^3Seats used/);
    });
  });

  it("says the seat count is unavailable when the team read fails", async () => {
    const company = {
      getTeamTelemetry: vi.fn(async () => ({ ok: false as const, reason: "http", message: "HTTP 500" })),
      listMembers: vi.fn(async () => ({ ok: false as const, reason: "http", message: "HTTP 500" })),
    };
    const target = render({ slug: "unicom-fail", company });
    openWorkforce(target);
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "workforce-error")).toContain("Seat count unavailable");
    });
    expect(target.textContent).not.toContain("HTTP 500");
  });
});
