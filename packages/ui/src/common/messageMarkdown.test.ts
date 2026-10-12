import { describe, expect, it } from "vitest";

import {
  autolinkMessageUrls,
  clipMessageBodyForDisplay,
  isHeavyMessageBody,
  MESSAGE_PLAIN_DISPLAY_CHARS,
  normalizeMessageMarkdown,
  renderMessageBodyMarkdown,
} from "./messageMarkdown.js";

describe("heavy message bodies", () => {
  it("keeps a long, clearly written Markdown reply as Markdown", () => {
    const body = [
      "All set — you're done. Here's where you landed.",
      "",
      "**Everything's working:**",
      "- All your tools are installed and healthy.",
      "- You're signed in to HQ Cloud.",
      "",
      "**Run these next:**",
      "1. `/startwork acme` — pick up work in your company.",
      "2. `/personal-interview` — fill in your profile.",
      "",
      "Some closing prose. ".repeat(80),
    ].join("\n");
    expect(body.length).toBeGreaterThan(1_200);
    expect(isHeavyMessageBody(body)).toBe(false);
    expect(renderMessageBodyMarkdown(body)).toMatch(/<strong>Everything(?:&#39;|')s working:<\/strong>/);
    // But not without limit: past the hard cap it renders plain.
    expect(isHeavyMessageBody(`${body}\n${"More prose. ".repeat(600)}`)).toBe(true);
    // And a long dump with no Markdown cues still renders plain.
    expect(isHeavyMessageBody("log line without cues\n".repeat(80))).toBe(true);
  });

  it("renders a long bot summary written in plain paragraphs as Markdown, not a plain dump", () => {
    // Live walkthrough 2026-10-12: the Agency Guide's 1,700-character wrap-up
    // (four paragraphs, no lists or headings) rendered as a scrolling monospace box.
    const body = "Fair enough, the button for it stays on the card below. That's setup done, for HQ and for the agency.\n\nRidgeline Growth now has a shared HQ that every bot and teammate you add starts from. In it today: your playbook with the rate card, scope rules, checklist, audit criteria, voice and your site's look (Files, under Knowledge, Agency Playbook); a home for Lumen Analytics, Harbor & Pine and Atlas Field Services, each with its contract, proposal, call notes, exports, contacts and open items filled in with sources (Files, under Clients); and Slack and Google Drive connected, with Drive marked as where agreements and transcripts live.\n\nTo use it, keep working in Claude Code, Codex or Cursor (the buttons below open it); ask me for an agent in Slack for the team whenever you want one; and other agents connect from the HQ console at hq.computer, under Agents, which is also where you manage your team and billing. When you bring on Jess, Dev or an account manager, I'll add them and share what you choose, Google Drive included. You can also message me and any other bots right here.\n\nNothing is left waiting on your side. The one thing I'd flag: Atlas has an acceptance email but no signed SOW, and your checklist says no work before one.\n\nWhere next? I can walk you through a client's workspace, or kick off onboarding on one. Harbor & Pine is the best first run: a tracking problem and five scope requests are already sitting in its notes. I'm here whenever you need me.";
    expect(body.length).toBeGreaterThan(1_200);
    expect(isHeavyMessageBody(body)).toBe(false);
    expect(renderMessageBodyMarkdown(body).startsWith('<pre class="dm-plain">')).toBe(false);
    // Log output of the same size is still a dump.
    expect(isHeavyMessageBody("2026-10-12T13:45:12Z info received 4956e9f3 (3 chars, dm) status=ok\n".repeat(25))).toBe(true);
  });

  it("renders a short message with one long sign-in link as Markdown, not a plain dump", () => {
    // Live walkthrough 2026-10-12: a bot's Slack sign-in message (a 580-character
    // link plus a few sentences) rendered as a scrolling monospace box.
    const link = `https://slack.com/oauth/v2/authorize?client_id=1&state=${"x".repeat(560)}`;
    const body = `Google Drive is connected. I read the three transcripts there.\n\nSlack next: a sign-in page should have opened. If it didn't, use this link:\n\n${link}\n\nOnly a workspace owner can connect it for now. If the page says HQ can't be installed, tell me.`.repeat(1) + " More plain words.".repeat(20);
    expect(body.length).toBeGreaterThan(1_200);
    expect(isHeavyMessageBody(body)).toBe(false);
    expect(renderMessageBodyMarkdown(body).startsWith('<pre class="dm-plain">')).toBe(false);
    // A real dump with a link in it is still a dump.
    expect(isHeavyMessageBody(`log line without cues ${link}\n`.repeat(80))).toBe(true);
  });

  it("treats large JSON dumps as heavy and renders them as a plain pre", () => {
    const body =
      `${JSON.stringify({ outcome: "doc-wrong", commandsRun: ["a"] })}\n`.repeat(
        40,
      );
    expect(body.length).toBeGreaterThan(400);
    expect(isHeavyMessageBody(body)).toBe(true);
    const started = Date.now();
    const html = renderMessageBodyMarkdown(body);
    expect(Date.now() - started).toBeLessThan(50);
    expect(html.startsWith('<pre class="dm-plain">')).toBe(true);
    expect(html).toContain("doc-wrong");
    expect(html).not.toContain("<p>");
  });

  it("clips huge dumps so the DOM does not receive the full log", () => {
    const body = `{"k":"${"x".repeat(12_000)}"}`;
    const html = renderMessageBodyMarkdown(body);
    expect(html.length).toBeLessThan(body.length);
    expect(html).toContain("…");
    expect(clipMessageBodyForDisplay(body).length).toBeLessThanOrEqual(
      MESSAGE_PLAIN_DISPLAY_CHARS + 2,
    );
  });

  it("keeps a window of long English docs cheap to render", () => {
    const bodies = Array.from(
      { length: 40 },
      (_, i) =>
        `You are testing HQ as a new team member ${i}\n\n${"paragraph ".repeat(200)}`,
    );
    const started = performance.now();
    const html = bodies.map((body) => renderMessageBodyMarkdown(body));
    expect(performance.now() - started).toBeLessThan(50);
    expect(html.every((row) => row.startsWith('<pre class="dm-plain">'))).toBe(
      true,
    );
    expect(Math.max(...html.map((row) => row.length))).toBeLessThan(800);
  });

  it("still renders short chat markdown", () => {
    const html = renderMessageBodyMarkdown("hello **Deacon**");
    expect(isHeavyMessageBody("hello **Deacon**")).toBe(false);
    expect(html).toContain("<strong>Deacon</strong>");
  });

  it("classifies multiline dumps by line count without misclassifying structured prose", () => {
    expect(isHeavyMessageBody("plain output\n".repeat(31))).toBe(true);
    expect(
      isHeavyMessageBody(
        [
          "# Summary",
          ...Array.from({ length: 29 }, () => "plain line"),
          "- Next step",
        ].join("\n"),
      ),
    ).toBe(false);
  });
});

describe("message Markdown normalization", () => {
  it("normalizes line endings and trims blank boundary lines", () => {
    expect(normalizeMessageMarkdown("\r\nhello\r\nworld\r\n")).toBe(
      "hello\nworld",
    );
    expect(normalizeMessageMarkdown(" \n\t\n")).toBe("");
  });

  it("dedents recognisable transport-framed prose but preserves deliberate code", () => {
    expect(
      normalizeMessageMarkdown(
        "    # Update\n\n    - first\n    - second",
      ),
    ).toBe("# Update\n\n- first\n- second");
    expect(
      normalizeMessageMarkdown("    const answer = 42;\n    return answer;"),
    ).toBe("    const answer = 42;\n    return answer;");
  });

  it("dedents a framed fenced block while leaving the fence intact", () => {
    expect(normalizeMessageMarkdown("\t```ts\n\tconst x = 1;\n\t```")).toBe(
      "```ts\nconst x = 1;\n```",
    );
  });
});

describe("message body URL autolinking", () => {
  it("autolinks bare http and https URLs with rel=noopener noreferrer and a readable label", () => {
    const http = renderMessageBodyMarkdown("see http://example.com/docs");
    expect(http).toContain(
      '<a href="http://example.com/docs" target="_blank" rel="noopener noreferrer" class="message-link" data-link-preview="auto" title="http://example.com/docs">example.com › docs</a>',
    );
    const https = renderMessageBodyMarkdown("see https://example.com/docs");
    expect(https).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer" class="message-link" data-link-preview="auto" title="https://example.com/docs">example.com › docs</a>',
    );
  });

  it("does not swallow a trailing period after a bare URL", () => {
    const html = renderMessageBodyMarkdown("See https://example.com.");
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="message-link" data-link-preview="auto" title="https://example.com">example.com</a>.',
    );
    expect(html).not.toContain('href="https://example.com."');
  });

  it("trims only unmatched closing parentheses from bare URLs", () => {
    expect(
      renderMessageBodyMarkdown("(https://example.com/path)."),
    ).toContain('href="https://example.com/path"');
    expect(renderMessageBodyMarkdown("https://example.com/a_(b)")).toContain(
      'href="https://example.com/a_(b)"',
    );
  });

  it("still renders markdown [label](https://…) links", () => {
    const html = renderMessageBodyMarkdown("see [docs](https://example.com/x)");
    expect(html).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer" class="message-link" data-link-preview="text">docs</a>',
    );
  });

  it("never turns javascript:alert(1) into a link as markdown or bare text", () => {
    const markdown = renderMessageBodyMarkdown("[x](javascript:alert(1))");
    expect(markdown).not.toMatch(/<a\b/);
    expect(markdown).not.toContain("javascript:");

    const bare = renderMessageBodyMarkdown("javascript:alert(1)");
    expect(bare).not.toMatch(/<a\b/);
    expect(bare).toContain("javascript:alert(1)");
  });

  it("does not autolink URLs inside fenced or inline code", () => {
    const fenced = renderMessageBodyMarkdown("```\nhttps://example.com\n```");
    expect(fenced).toContain("<pre><code>https://example.com</code></pre>");
    expect(fenced).not.toMatch(/<a\b/);

    const inline = renderMessageBodyMarkdown("use `https://example.com` here");
    expect(inline).toContain("<code>https://example.com</code>");
    expect(inline).not.toMatch(/<a\b/);
  });

  it("does not double-link text inside an existing markdown link", () => {
    const html = renderMessageBodyMarkdown(
      "[https://example.com](https://example.com/page)",
    );
    expect(html.match(/<a\b/g)?.length).toBe(1);
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain(">https://example.com</a>");
  });

  it("preserves escaped &amp; in a URL and does not decode it", () => {
    const html = renderMessageBodyMarkdown("https://example.com?a=1&b=2");
    expect(html).toContain(
      '<a href="https://example.com?a=1&amp;b=2" target="_blank" rel="noopener noreferrer" class="message-link" data-link-preview="auto" title="https://example.com?a=1&amp;b=2">example.com</a>',
    );
    expect(html).not.toContain('href="https://example.com?a=1&b=2"');
  });

  it("leaves malformed HTML tails inert while scanning for bare URLs", () => {
    expect(
      autolinkMessageUrls("before <broken https://example.com"),
    ).toBe("before <broken https://example.com");
  });
});

describe("chat soft-break handling (one line per idea)", () => {
  it("renders single newlines as <br /> so a per-line list keeps its breaks", () => {
    // Regression: the 2026-09-05 DM smoke saw `stat\ntable\n…` collapse to a
    // single space-joined line. Chat bodies must preserve single newlines.
    const html = renderMessageBodyMarkdown(
      "stat\ntable\nchart\nmarkdown\nbadge\nkeyValue\nprogress\ncallout",
    );
    expect(html).toContain("stat<br />table<br />chart");
    expect(html).not.toContain("stat table chart");
  });

  it("still separates blank-line-delimited paragraphs", () => {
    const html = renderMessageBodyMarkdown("first line\n\nsecond block");
    expect(html).toContain("<p>first line</p>");
    expect(html).toContain("<p>second block</p>");
  });
});
