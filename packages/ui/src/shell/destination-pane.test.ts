import { describe, expect, it } from "vitest";

import { companyRowDestination } from "./company-pane.js";
import { entryCompanyUidForCommit, paneForEntry } from "./destination-pane.js";
import {
  createNavigationEntry,
  type NavigationDestination,
} from "./navigation-history.js";
import { railPlaceholderPage } from "./app-rail.js";

const COMPANY = "cmp_unicom";

function entry(destination: NavigationDestination, companyUid: string | null = COMPANY) {
  return createNavigationEntry(destination, { accountId: "prs_test", companyUid });
}

describe("paneForEntry (QA-047): every destination sets its own sidepane", () => {
  it("Meetings shows the Meetings pane even when entered from a company page", () => {
    expect(paneForEntry(entry({ kind: "meetings" }))).toEqual({ pane: "meetings" });
    expect(paneForEntry(entry({ kind: "meetings", meetingId: "m1" }))).toEqual({
      pane: "meetings",
    });
  });

  it("Messages shows the Home chat pane, never the company sections", () => {
    expect(paneForEntry(entry({ kind: "messages" }))).toEqual({
      pane: "home",
      companyKey: COMPANY,
    });
    expect(paneForEntry(entry({ kind: "messages" }, null))).toEqual({
      pane: "home",
      companyKey: null,
    });
  });

  it("every company section shows that company's pane", () => {
    for (const row of ["atlas", "projects", "team", "bots", "vault", "company-settings"]) {
      expect(paneForEntry(entry(companyRowDestination(row, COMPANY), null))).toEqual({
        pane: "company",
        companyKey: COMPANY,
      });
    }
  });

  it("a company section without a company key falls back to the entry scope", () => {
    expect(
      paneForEntry(entry({ kind: "extra", page: "company-page-bots" }, "cmp_other")),
    ).toEqual({ pane: "company", companyKey: "cmp_other" });
  });

  it("personal rail pages and full-page destinations close the company pane", () => {
    const closed: NavigationDestination[] = [
      { kind: "extra", page: railPlaceholderPage("deployments") },
      { kind: "settings", section: "profile" },
      { kind: "settings", section: "bots" },
      { kind: "library", tab: "marketplace" },
      { kind: "explorer" },
      { kind: "shared-files" },
      { kind: "projects", company: "unicom" },
    ];
    for (const destination of closed) {
      expect(paneForEntry(entry(destination))).toEqual({ pane: "none" });
    }
  });

  it("a conversation restores the scope it was recorded under", () => {
    expect(paneForEntry(entry({ kind: "dm", personUid: "prs_jacob" }, null))).toEqual({
      pane: "home",
      companyKey: null,
    });
    expect(paneForEntry(entry({ kind: "channel", channelId: "ch_1" }))).toEqual({
      pane: "home",
      companyKey: COMPANY,
    });
  });
});

describe("entryCompanyUidForCommit: Home looks the same however it is reached", () => {
  const bots = entry(companyRowDestination("bots", COMPANY));
  const homeScoped = entry({ kind: "messages" });
  const meetings = entry({ kind: "meetings" });

  it("a conversation opened from a company page lands in the cross-company list", () => {
    for (const destination of [
      { kind: "dm", personUid: "agt_deez" },
      { kind: "channel", channelId: "ch_1" },
      { kind: "notifications" },
      { kind: "dm-requests" },
    ] as NavigationDestination[]) {
      expect(entryCompanyUidForCommit(destination, COMPANY, bots)).toBeNull();
      expect(entryCompanyUidForCommit(destination, COMPANY, meetings)).toBeNull();
    }
  });

  it("a conversation opened on Home keeps the company the person picked", () => {
    expect(
      entryCompanyUidForCommit({ kind: "dm", personUid: "agt_deez" }, COMPANY, homeScoped),
    ).toBe(COMPANY);
    expect(
      entryCompanyUidForCommit({ kind: "channel", channelId: "ch_1" }, null, homeScoped),
    ).toBeNull();
  });

  it("an explicit scope pick (Messages) and company pages keep their scope", () => {
    expect(entryCompanyUidForCommit({ kind: "messages" }, COMPANY, bots)).toBe(COMPANY);
    expect(
      entryCompanyUidForCommit(companyRowDestination("team", COMPANY), COMPANY, bots),
    ).toBe(COMPANY);
  });

  it("with no entry to leave, the scope in force is kept", () => {
    expect(
      entryCompanyUidForCommit({ kind: "dm", personUid: "agt_deez" }, COMPANY, null),
    ).toBe(COMPANY);
  });
});
