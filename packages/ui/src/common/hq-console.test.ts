import { describe, it, expect } from "vitest";

import {
  HQ_CONSOLE_BASE,
  companyConsoleUrl,
  companySettingsUrl,
  companyInviteUrl,
  companyIntegrationsUrl,
  agentSlackSettingsUrl,
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

  it("integrations link points to the company's HQ Integrations page", () => {
    expect(companyIntegrationsUrl("indigo")).toBe(
      `${HQ_CONSOLE_BASE}/companies/indigo/integrations`,
    );
    // A company uid works in the slug position.
    expect(companyIntegrationsUrl("cmp_01ABC")).toBe(
      `${HQ_CONSOLE_BASE}/companies/cmp_01ABC/integrations`,
    );
    expect(companyIntegrationsUrl("a b/c")).toBe(
      `${HQ_CONSOLE_BASE}/companies/a%20b%2Fc/integrations`,
    );
  });

  it("Slack setup link opens the bot's settings on the company's bots page", () => {
    expect(agentSlackSettingsUrl("cmp_01ABC", "agt_01XYZ")).toBe(
      `${HQ_CONSOLE_BASE}/companies/cmp_01ABC/agents?settings=agt_01XYZ`,
    );
    expect(agentSlackSettingsUrl("a b", "agt_x&y=1")).toBe(
      `${HQ_CONSOLE_BASE}/companies/a%20b/agents?settings=agt_x%26y%3D1`,
    );
  });

  it("non-company console links are unchanged", () => {
    expect(HQ_CONSOLE_INTEGRATIONS_URL).toBe(
      `${HQ_CONSOLE_BASE}/personal/integrations`,
    );
    expect(HQ_CONSOLE_CREATORS_URL).toBe(`${HQ_CONSOLE_BASE}/creators`);
    expect(creatorProfileUrl("jane")).toBe(`${HQ_CONSOLE_BASE}/creators/jane`);
  });
});
