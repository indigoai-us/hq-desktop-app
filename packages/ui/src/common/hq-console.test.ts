import { describe, it, expect } from "vitest";

import {
  HQ_CONSOLE_BASE,
  companyConsoleUrl,
  companySettingsUrl,
  companyInviteUrl,
  companyIntegrationsUrl,
  companyAgentsUrl,
  consoleCompanySlug,
  HQ_CONSOLE_INTEGRATIONS_URL,
  HQ_CONSOLE_CREATORS_URL,
  creatorProfileUrl,
} from "./hq-console";

describe("hq-console URLs", () => {
  // Regression: company links must carry the `/companies/` path segment. The
  // console namespaces every company surface under `/companies/{slug}`; a link
  // to `${HQ_CONSOLE_BASE}/${slug}` 404s. (Settings button shipped broken.)
  it("company console home includes the /companies/ prefix", () => {
    expect(companyConsoleUrl("indigo")).toBe(
      `${HQ_CONSOLE_BASE}/companies/indigo`,
    );
  });

  it("company console home is NEVER the bare /{slug} form (the bug)", () => {
    expect(companyConsoleUrl("indigo")).not.toBe(`${HQ_CONSOLE_BASE}/indigo`);
    expect(companyConsoleUrl("indigo")).toContain("/companies/");
  });

  it("settings link points to the dedicated /companies/{slug}/settings page", () => {
    expect(companySettingsUrl("indigo")).toBe(
      `${HQ_CONSOLE_BASE}/companies/indigo/settings`,
    );
    expect(companySettingsUrl("indigo")).toContain("/companies/");
  });

  it("invite link points to the company Team → Invites surface", () => {
    expect(companyInviteUrl("indigo")).toBe(
      `${HQ_CONSOLE_BASE}/companies/indigo/team/invites`,
    );
    expect(companyInviteUrl("indigo")).toContain("/companies/");
  });

  it("encodes slugs that need escaping", () => {
    expect(companyConsoleUrl("a b/c")).toBe(
      `${HQ_CONSOLE_BASE}/companies/a%20b%2Fc`,
    );
    expect(companySettingsUrl("a b")).toBe(
      `${HQ_CONSOLE_BASE}/companies/a%20b/settings`,
    );
    expect(companyInviteUrl("a/b c")).toBe(
      `${HQ_CONSOLE_BASE}/companies/a%2Fb%20c/team/invites`,
    );
  });

  it("integrations link points to the company's HQ Integrations page, by slug", () => {
    expect(companyIntegrationsUrl("indigo")).toBe(
      `${HQ_CONSOLE_BASE}/companies/indigo/integrations`,
    );
    expect(companyIntegrationsUrl("a b/c")).toBe(
      `${HQ_CONSOLE_BASE}/companies/a%20b%2Fc/integrations`,
    );
  });

  it("bots page link points to the company's agents page, by slug", () => {
    expect(companyAgentsUrl("indigo")).toBe(
      `${HQ_CONSOLE_BASE}/companies/indigo/agents`,
    );
    expect(companyAgentsUrl(" indigo ")).toBe(
      `${HQ_CONSOLE_BASE}/companies/indigo/agents`,
    );
    expect(companyAgentsUrl("a b/c")).toBe(
      `${HQ_CONSOLE_BASE}/companies/a%20b%2Fc/agents`,
    );
  });

  // Regression: a company uid in the slug position sent a person to the wrong
  // page of the console. These links are built from a slug or not at all.
  it("never builds a company link from a uid: it falls back to the console's front page", () => {
    for (const notASlug of ["cmp_01ABC", " cmp_01ABC ", "CMP_01ABC", "", "   ", null, undefined]) {
      expect(consoleCompanySlug(notASlug)).toBeNull();
      expect(companyIntegrationsUrl(notASlug)).toBe(HQ_CONSOLE_BASE);
      expect(companyAgentsUrl(notASlug)).toBe(HQ_CONSOLE_BASE);
    }
    expect(companyIntegrationsUrl("cmp_01ABC")).not.toContain("cmp_");
    expect(companyAgentsUrl("cmp_01ABC")).not.toContain("cmp_");
    expect(consoleCompanySlug(" indigo ")).toBe("indigo");
    // A slug that only contains the letters is still a slug.
    expect(consoleCompanySlug("acmp_co")).toBe("acmp_co");
  });

  it("non-company console links are unchanged", () => {
    expect(HQ_CONSOLE_INTEGRATIONS_URL).toBe(
      `${HQ_CONSOLE_BASE}/personal/integrations`,
    );
    expect(HQ_CONSOLE_CREATORS_URL).toBe(`${HQ_CONSOLE_BASE}/creators`);
    expect(creatorProfileUrl("jane")).toBe(`${HQ_CONSOLE_BASE}/creators/jane`);
  });
});
