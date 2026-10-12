import { describe, expect, it } from "vitest";

import { deriveCategory } from "./integration-apps.js";

/**
 * Every keyword in the table on main before the note-taker change, with its
 * category. None has a dot, so each still matches anywhere in the domain or
 * the name. These cases fail if that changes.
 */
const KEYWORDS_BEFORE: ReadonlyArray<[string, string]> = [
  ["linear", "Work"],
  ["atlassian", "Work"],
  ["jira", "Work"],
  ["monday", "Work"],
  ["asana", "Work"],
  ["clickup", "Work"],
  ["posthog", "Analytics"],
  ["amplitude", "Analytics"],
  ["mixpanel", "Analytics"],
  ["sentry", "Analytics"],
  ["datadog", "Analytics"],
  ["notion", "Knowledge"],
  ["deepwiki", "Knowledge"],
  ["guru", "Knowledge"],
  ["confluence", "Knowledge"],
  ["figma", "Design"],
  ["canva", "Design"],
  ["miro", "Design"],
  ["gamma", "Design"],
  ["slack", "Comms"],
  ["intercom", "Comms"],
  ["hubspot", "Comms"],
  ["salesforce", "Comms"],
  ["zendesk", "Comms"],
  ["gmail", "Comms"],
  ["airtable", "Data"],
  ["snowflake", "Data"],
  ["bigquery", "Data"],
  ["supabase", "Data"],
  ["github", "Dev"],
  ["gitlab", "Dev"],
  ["vercel", "Dev"],
  ["netlify", "Dev"],
  ["fathom", "Meetings"],
  ["granola", "Meetings"],
  ["zoom", "Meetings"],
  ["loom", "Meetings"],
  ["stripe", "Payments"],
  ["paypal", "Payments"],
  ["quickbooks", "Payments"],
  ["intuit", "Payments"],
];

describe("deriveCategory", () => {
  it.each(KEYWORDS_BEFORE)("still files %s under %s by domain, by subdomain, inside a longer domain, and by name", (keyword, category) => {
    expect(deriveCategory(`${keyword}.com`, "")).toBe(category);
    expect(deriveCategory(`mcp.${keyword}.app`, "")).toBe(category);
    expect(deriveCategory(`app.my${keyword}hq.io`, "")).toBe(category);
    expect(deriveCategory("", `The ${keyword} app`)).toBe(category);
  });

  it("still files the catalog's own entries where they were", () => {
    expect(deriveCategory("monday.com", "monday.com")).toBe("Work");
    expect(deriveCategory("mcp.linear.app", "Linear")).toBe("Work");
    expect(deriveCategory("fathom.ai", "fathom.ai")).toBe("Meetings");
    expect(deriveCategory("granola.ai", "granola.ai")).toBe("Meetings");
    expect(deriveCategory("https://www.fathom.video/", "Fathom")).toBe("Meetings");
    expect(deriveCategory("example.com", "Example")).toBe("Other");
  });

  it.each([
    ["fireflies.ai", "Fireflies.ai"],
    ["", "Fireflies"],
    ["otter.ai", "otter.ai"],
    ["mcp.otter.ai", ""],
    ["https://www.otter.ai/", ""],
    ["read.ai", "read.ai"],
    ["app.read.ai", ""],
    ["tldv.io", "tl;dv"],
    ["", "tl;dv"],
    ["", "Otter"],
    ["", "Otter AI"],
    ["", "otter.ai"],
    ["", "Read AI"],
    ["", "read.ai"],
  ])("files the note taker %s %s under Meetings", (domain, name) => {
    expect(deriveCategory(domain, name)).toBe("Meetings");
  });

  it.each([
    ["spotter.ai", "Spotter"],
    ["spotter.io", "Spotter"],
    ["thread.ai", "Thread AI"],
    ["app.bread.ai", "Bread"],
    ["readwise.io", "Readwise"],
    ["enzoreader.com", "Enzo Reader"],
    ["otter.ai.example.org", ""],
    ["", "Hotter"],
    ["", "Otter Clone"],
    ["", "Thread AI"],
    ["", "Already AI"],
  ])("does not file the lookalike %s %s under Meetings", (domain, name) => {
    expect(deriveCategory(domain, name)).not.toBe("Meetings");
  });
});
