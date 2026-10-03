// The bundled brand marks: real logos for the apps most likely to be on a
// card, keyed by domain, with the favicon chain for everything else.

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
    // google.com itself is not one app, so it has no mark.
    expect(brandMarkFor("google.com")).toBeNull();
  });

  it("has no mark for the apps the icon set does not carry, and for anything unknown", () => {
    // These take the favicon chain: simple-icons has no Salesforce or Microsoft marks.
    expect(brandMarkFor("salesforce.com")).toBeNull();
    expect(brandMarkFor("teams.microsoft.com")).toBeNull();
    expect(brandMarkFor("outlook.com")).toBeNull();
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
