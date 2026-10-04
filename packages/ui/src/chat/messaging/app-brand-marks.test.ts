// The bundled brand marks: real logos for the apps most likely to be on a
// card, keyed by domain, with the generic glyph for everything else.

import { describe, expect, it } from "vitest";
import { siGithub, siGmail, siGoogledrive, siIntercom, siLinear, siNotion } from "simple-icons";

import { BRAND_MARK_DOMAINS, SLACK_MARK, brandMarkFor, markTile } from "./app-brand-marks.js";

describe("brandMarkFor", () => {
  it("has a mark for the apps the cards are most likely to show", () => {
    for (const domain of [
      "slack.com",
      "gmail.com",
      "drive.google.com",
      "calendar.google.com",
      "notion.so",
      "github.com",
      "linear.app",
      "hubspot.com",
      "figma.com",
      "atlassian.com",
      "asana.com",
      "zoom.us",
      "dropbox.com",
      "stripe.com",
      "trello.com",
      "airtable.com",
      "intercom.com",
      "zendesk.com",
    ]) {
      expect(brandMarkFor(domain), domain).not.toBeNull();
    }
  });

  it("returns the icon set's own path and colour, so the mark is the real one", () => {
    expect(brandMarkFor("github.com")).toEqual({ title: siGithub.title, hex: siGithub.hex, path: siGithub.path });
    expect(brandMarkFor("linear.app")).toEqual({ title: siLinear.title, hex: siLinear.hex, path: siLinear.path });
    expect(brandMarkFor("gmail.com")).toEqual({ title: siGmail.title, hex: siGmail.hex, path: siGmail.path });
    expect(brandMarkFor("drive.google.com")?.title).toBe(siGoogledrive.title);
    expect(brandMarkFor("notion.com")?.title).toBe(siNotion.title);
  });

  it("draws Slack's mark in Slack's colour", () => {
    expect(brandMarkFor("slack.com")).toBe(SLACK_MARK);
    expect(SLACK_MARK.hex).toBe("4A154B");
    expect(SLACK_MARK.title).toBe("Slack");
    // Eight shapes, two per arm: the path has eight subpaths.
    expect(SLACK_MARK.path.match(/M/g)).toHaveLength(8);
  });

  it("falls back from an unlisted subdomain to its registrable domain, and keeps listed subdomains apart", () => {
    expect(brandMarkFor("api.slack.com")).toBe(SLACK_MARK);
    expect(brandMarkFor("app.hubspot.com")?.title).toBe("HubSpot");
    expect(brandMarkFor("drive.google.com")?.title).toBe("Google Drive");
    expect(brandMarkFor("calendar.google.com")?.title).toBe("Google Calendar");
    expect(brandMarkFor("mail.google.com")?.title).toBe("Gmail");
    // google.com itself, and a Google product with no mark of its own, draw the G.
    expect(brandMarkFor("google.com")?.title).toBe("Google");
    expect(brandMarkFor("chat.google.com")?.title).toBe("Google");
  });

  it("has a mark for the apps a bot names most, so they keep a real logo with no image request", () => {
    const expected: Record<string, string> = {
      "sentry.io": "Sentry",
      "calendly.com": "Calendly",
      "mixpanel.com": "Mixpanel",
      "shopify.com": "Shopify",
      "posthog.com": "PostHog",
      "supabase.com": "Supabase",
      "vercel.com": "Vercel",
      "gitlab.com": "GitLab",
      "clickup.com": "ClickUp",
      "datadoghq.com": "Datadog",
      "pagerduty.com": "PagerDuty",
      "cloudflare.com": "Cloudflare",
      "zapier.com": "Zapier",
      "quickbooks.intuit.com": "QuickBooks",
      "analytics.google.com": "Google Analytics",
      "x.com": "X",
      "twitter.com": "X",
    };
    for (const [domain, title] of Object.entries(expected)) expect(brandMarkFor(domain)?.title, domain).toBe(title);
  });

  it("carries a real path and a six-digit colour for every mark", () => {
    for (const domain of BRAND_MARK_DOMAINS) {
      const mark = brandMarkFor(domain)!;
      expect(mark.hex, domain).toMatch(/^[0-9A-Fa-f]{6}$/);
      expect(mark.path.length, domain).toBeGreaterThan(20);
      expect(mark.title, domain).not.toBe("");
    }
  });

  it("has no mark for the apps the icon set does not carry, and for anything unknown", () => {
    // These show the generic glyph: simple-icons has no Salesforce, Microsoft or Firecrawl marks.
    expect(brandMarkFor("salesforce.com")).toBeNull();
    expect(brandMarkFor("teams.microsoft.com")).toBeNull();
    expect(brandMarkFor("outlook.com")).toBeNull();
    expect(brandMarkFor("firecrawl.dev")).toBeNull();
    expect(brandMarkFor("example.com")).toBeNull();
    expect(brandMarkFor("")).toBeNull();
    expect(brandMarkFor(null)).toBeNull();
    expect(brandMarkFor(undefined)).toBeNull();
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(brandMarkFor("  GitHub.com ")?.title).toBe("GitHub");
  });

  it("lists every domain it knows", () => {
    expect(BRAND_MARK_DOMAINS).toContain("slack.com");
    expect(BRAND_MARK_DOMAINS.length).toBeGreaterThanOrEqual(20);
    for (const domain of BRAND_MARK_DOMAINS) expect(brandMarkFor(domain)).not.toBeNull();
  });
});

describe("markTile", () => {
  it("puts a dark mark on a light tile and a light mark on a dark tile", () => {
    expect(markTile(siNotion.hex)).toBe("light");
    expect(markTile(siGithub.hex)).toBe("light");
    expect(markTile(SLACK_MARK.hex)).toBe("light");
    expect(markTile(siLinear.hex)).toBe("light");
    expect(markTile(siIntercom.hex)).toBe("dark");
    expect(markTile("FFFFFF")).toBe("dark");
    expect(markTile("#ffffff")).toBe("dark");
  });

  it("treats a colour it cannot read as dark, so the mark goes on the light tile", () => {
    expect(markTile("nope")).toBe("light");
  });
});
