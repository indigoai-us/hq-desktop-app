import { describe, expect, it } from "vitest";
import {
  describeRecurrence,
  fallbackLabel,
  linkPreview,
  relabelRawUrlLinks,
} from "./linkPreview";

/** Intl may emit narrow no-break spaces before AM/PM; compare on plain spaces. */
const plain = (value: string | undefined) => value?.replace(/[  ]/g, " ");
const field = (href: string, label: string) =>
  plain(linkPreview(href)?.fields.find((f) => f.label === label)?.value);

describe("linkPreview: Google Calendar templates", () => {
  const href =
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    "&text=Izzy+%2F+Corey+weekly+sync" +
    "&dates=20261009T170000Z/20261009T173000Z" +
    "&ctz=America/Los_Angeles" +
    "&details=Agenda+in+the+doc" +
    "&location=Zoom" +
    "&recur=RRULE:FREQ%3DWEEKLY";

  it("titles the link with the event name and short date", () => {
    const preview = linkPreview(href);
    expect(preview?.provider).toBe("calendar");
    expect(preview?.title).toBe("Izzy / Corey weekly sync · Fri, Oct 9");
    expect(preview?.wantsPageTitle).toBe(false);
  });

  it("reads date, time in the event zone, zone, recurrence and location", () => {
    expect(field(href, "Date")).toBe("Fri, Oct 9, 2026");
    expect(field(href, "Time")).toBe("10:00 AM – 10:30 AM");
    expect(field(href, "Time zone")).toBe("America/Los Angeles");
    expect(field(href, "Repeats")).toBe("Weekly");
    expect(field(href, "Location")).toBe("Zoom");
  });

  it("keeps the date out of the card title, which the Date row already shows", () => {
    expect(linkPreview(href)?.cardTitle).toBe("Izzy / Corey weekly sync");
  });

  it("spells out BYDAY and a UTC UNTIL in the event zone", () => {
    const swim =
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Swim" +
      "&dates=20261027T223000Z/20261027T230000Z&ctz=America/Denver" +
      "&recur=RRULE:FREQ%3DWEEKLY;BYDAY%3DTU,TH;UNTIL%3D20261121T055959Z";
    // 05:59Z on Nov 21 is still Nov 20 in Denver.
    expect(field(swim, "Repeats")).toBe("Weekly on Tue, Thu until Nov 20");
  });

  it("offers Add to calendar pointing at the template", () => {
    expect(linkPreview(href)?.action).toEqual({ label: "Add to calendar", href });
  });

  it("treats date-only ranges as all-day", () => {
    const allDay =
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Offsite&dates=20261012/20261013";
    expect(field(allDay, "Date")).toBe("Mon, Oct 12, 2026");
    expect(field(allDay, "Time")).toBe("All day");
  });

  it("ignores an invalid time zone instead of throwing", () => {
    const bad =
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=X&dates=20261009T170000Z/20261009T173000Z&ctz=Not/AZone";
    expect(field(bad, "Time zone")).toBeUndefined();
    expect(field(bad, "Time")).toBe("5:00 PM – 5:30 PM");
  });

  it("labels non-template calendar links plainly", () => {
    expect(linkPreview("https://calendar.google.com/calendar/u/0/r")?.title).toBe(
      "Google Calendar",
    );
  });
});

describe("linkPreview: GitHub", () => {
  it("parses pull requests and issues as owner/repo#n", () => {
    const pr = linkPreview("https://github.com/indigoai-us/hq-desktop-app/pull/1512/files");
    expect(pr?.provider).toBe("github");
    expect(pr?.kind).toBe("Pull request");
    expect(pr?.title).toBe("indigoai-us/hq-desktop-app#1512");
    expect(pr?.fields).toContainEqual({ label: "View", value: "Files changed" });

    const issue = linkPreview("https://github.com/indigoai-us/hq/issues/42");
    expect(issue?.kind).toBe("Issue");
    expect(issue?.title).toBe("indigoai-us/hq#42");
  });

  it("parses commits, files with line ranges, and repos", () => {
    expect(
      linkPreview("https://github.com/acme/app/commit/bd955f0ac1234567890")?.title,
    ).toBe("acme/app@bd955f0");

    const file = linkPreview("https://github.com/acme/app/blob/main/src/lib/a.ts#L10-L20");
    expect(file?.title).toBe("app/src/lib/a.ts");
    expect(file?.fields).toContainEqual({ label: "Lines", value: "10–20" });
    expect(file?.fields).toContainEqual({ label: "Branch", value: "main" });

    expect(linkPreview("https://github.com/acme/app")?.title).toBe("acme/app");
    expect(linkPreview("https://github.com/acme/app/releases/tag/v1.2.0")?.title).toBe(
      "acme/app v1.2.0",
    );
  });
});

describe("linkPreview: deploys", () => {
  it("parses hq.computer and indigo-hq.com app subdomains", () => {
    const app = linkPreview("https://investor-memo.hq.computer/");
    expect(app?.provider).toBe("deploy");
    expect(app?.kind).toBe("HQ deploy");
    expect(app?.title).toBe("investor-memo");
    expect(app?.fields).toContainEqual({ label: "Host", value: "investor-memo.hq.computer" });

    const page = linkPreview("https://demo.indigo-hq.com/docs/index.html");
    expect(page?.title).toBe("demo › docs/index.html");
    expect(page?.wantsPageTitle).toBe(true);
  });

  it("parses Vercel preview and dashboard links", () => {
    const branch = linkPreview("https://hq-console-git-fix-login-indigo.vercel.app/");
    expect(branch?.kind).toBe("Vercel deploy");
    expect(branch?.title).toBe("hq-console");
    expect(branch?.fields).toContainEqual({ label: "Branch preview", value: "fix-login-indigo" });

    const unique = linkPreview("https://hq-console-a1b2c3d4e-indigo.vercel.app");
    expect(unique?.title).toBe("hq-console");

    const dash = linkPreview("https://vercel.com/indigo/hq-console/deployments");
    expect(dash?.title).toBe("hq-console › deployments");
  });
});

describe("linkPreview: other providers", () => {
  it("names Linear issues, Google Docs, Slack and YouTube links", () => {
    expect(
      linkPreview("https://linear.app/indigo/issue/HQ-123/fix-link-wrapping")?.title,
    ).toBe("HQ-123 Fix link wrapping");
    expect(linkPreview("https://docs.google.com/spreadsheets/d/abc/edit")?.kind).toBe(
      "Google Sheet",
    );
    expect(
      linkPreview("https://indigo.slack.com/archives/C0AQY3RDHSL/p1791510000000")?.title,
    ).toBe("Slack message in indigo");
    expect(linkPreview("https://youtu.be/dQw4w9WgXcQ")?.provider).toBe("youtube");
  });
});

describe("linkPreview: fallback", () => {
  it("uses domain › last path segments and drops long ids", () => {
    expect(linkPreview("https://www.example.com/")?.title).toBe("example.com");
    expect(fallbackLabel(new URL("https://example.com/blog/2026/launch-notes"))).toBe(
      "example.com › 2026/launch-notes",
    );
    expect(
      fallbackLabel(new URL("https://example.com/a/0123456789abcdef0123/report")),
    ).toBe("example.com › a/report");
    const generic = linkPreview("https://example.com/x");
    expect(generic?.provider).toBe("generic");
    expect(generic?.wantsPageTitle).toBe(true);
  });

  it("truncates very long labels", () => {
    const label = linkPreview(`https://example.com/${"z".repeat(200)}`)?.title ?? "";
    expect(label.length).toBeLessThanOrEqual(72);
    expect(label.endsWith("…")).toBe(true);
  });

  it("returns null for non-http URLs", () => {
    expect(linkPreview("mailto:a@example.com")).toBeNull();
    expect(linkPreview("not a url")).toBeNull();
  });
});

describe("relabelRawUrlLinks", () => {
  const A = 'target="_blank" rel="noopener noreferrer"';

  it("replaces raw URL text with the readable label and keeps the href", () => {
    const html = `<p><a href="https://github.com/acme/app/pull/7" ${A}>https://github.com/acme/app/pull/7</a></p>`;
    expect(relabelRawUrlLinks(html)).toBe(
      `<p><a href="https://github.com/acme/app/pull/7" ${A} class="message-link" data-link-preview="auto" title="https://github.com/acme/app/pull/7">acme/app#7</a></p>`,
    );
  });

  it("keeps explicit Markdown link text", () => {
    const html = `<a href="https://example.com/x" ${A}>the docs</a>`;
    expect(relabelRawUrlLinks(html)).toBe(
      `<a href="https://example.com/x" ${A} class="message-link" data-link-preview="text">the docs</a>`,
    );
  });

  it("uses a fetched page title only for links that want one", () => {
    const generic = `<a href="https://example.com/x" ${A}>https://example.com/x</a>`;
    const titled = relabelRawUrlLinks(generic, () => 'Launch <notes> & "more"');
    expect(titled).toContain(">Launch &lt;notes&gt; &amp; &quot;more&quot;</a>");

    const github = `<a href="https://github.com/acme/app" ${A}>https://github.com/acme/app</a>`;
    expect(relabelRawUrlLinks(github, () => "GitHub page title")).toContain(">acme/app</a>");
  });

  it("decodes &amp; in the href for parsing but never in the output", () => {
    const href =
      "https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Standup&amp;dates=20261009/20261010";
    const out = relabelRawUrlLinks(`<a href="${href}" ${A}>${href}</a>`);
    expect(out).toContain(`href="${href}"`);
    expect(out).toContain(">Standup · Fri, Oct 9</a>");
  });

  it("leaves mailto links and nested markup alone", () => {
    const mail = `<a href="mailto:a@example.com" ${A}>a@example.com</a>`;
    expect(relabelRawUrlLinks(mail)).toBe(mail);
    const nested = `<a href="https://example.com" ${A}><strong>x</strong></a>`;
    expect(relabelRawUrlLinks(nested)).toBe(nested);
  });
});

describe("describeRecurrence", () => {
  it("handles daily, weekly and monthly rules", () => {
    expect(describeRecurrence("RRULE:FREQ=DAILY")).toBe("Daily");
    expect(describeRecurrence("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR")).toBe("Weekly on Mon, Wed, Fri");
    expect(describeRecurrence("RRULE:FREQ=MONTHLY;BYMONTHDAY=15")).toBe("Monthly on the 15th");
    expect(describeRecurrence("RRULE:FREQ=MONTHLY;BYDAY=2TU")).toBe("Monthly on the 2nd Tue");
    expect(describeRecurrence("RRULE:FREQ=MONTHLY;BYDAY=-1FR")).toBe("Monthly on the last Fri");
  });

  it("handles INTERVAL and COUNT", () => {
    expect(describeRecurrence("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU")).toBe(
      "Every 2 weeks on Tue",
    );
    expect(describeRecurrence("RRULE:FREQ=DAILY;COUNT=10")).toBe("Daily, 10 times");
    expect(describeRecurrence("RRULE:FREQ=DAILY;COUNT=1")).toBe("Daily, once");
  });

  it("reads UNTIL in the event zone when it is UTC, as-is when floating", () => {
    const rule = "RRULE:FREQ=WEEKLY;UNTIL=20261121T055959Z";
    expect(describeRecurrence(rule, "America/Denver")).toBe("Weekly until Nov 20");
    expect(describeRecurrence(rule, "Asia/Tokyo")).toBe("Weekly until Nov 21");
    expect(describeRecurrence("RRULE:FREQ=WEEKLY;UNTIL=20261120", "Asia/Tokyo")).toBe(
      "Weekly until Nov 20",
    );
  });

  it("falls back for empty or unknown rules", () => {
    expect(describeRecurrence(null)).toBeUndefined();
    expect(describeRecurrence("RRULE:FREQ=HOURLY")).toBe("Repeats");
    expect(describeRecurrence("garbage")).toBe("Repeats");
  });
});

describe("linkPreview: generic card title", () => {
  it("shows the path once in the card, since the header has the domain", () => {
    const preview = linkPreview("https://example.com/blog/2026/launch-notes");
    expect(preview?.title).toBe("example.com › 2026/launch-notes");
    expect(preview?.cardTitle).toBe("2026/launch-notes");
    expect(linkPreview("https://example.com/")?.cardTitle).toBe("");
  });

  it("uses the fragment path for hash-routed apps", () => {
    const href = "https://apps.daysmartrecreation.com/dash/x/#/online/berthoud/teams/7037";
    expect(linkPreview(href)?.title).toBe("apps.daysmartrecreation.com › berthoud/teams/7037");
    expect(linkPreview(href)?.cardTitle).toBe("berthoud/teams/7037");
    // A plain anchor is not a route.
    expect(fallbackLabel(new URL("https://example.com/docs/guide#install"))).toBe(
      "example.com › docs/guide",
    );
  });
});
