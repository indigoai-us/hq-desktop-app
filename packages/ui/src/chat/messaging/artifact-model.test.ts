import { describe, expect, it } from "vitest";

import {
  ARTIFACT_PREVIEW_LINES,
  artifactBodyAfterTitle,
  artifactHasMore,
  artifactLooksLikeMarkdown,
  artifactPreview,
  artifactPreviewLines,
  artifactSummary,
  artifactSizeLabel,
  artifactTitle,
  chatArtifact,
} from "./artifact-model.js";

const LONG = [
  "Please update the legal page.",
  "The terms must state that these are a binding agreement between the",
  "customer and the company, effective on acceptance.",
  "line 4",
  "line 5",
  "line 6",
  "line 7 — only reachable in the side pane",
].join("\n");

describe("artifactTitle", () => {
  it("uses an explicit TITLE: line", () => {
    expect(artifactTitle("TITLE: Legal page change\nbody", "details")).toBe(
      "Legal page change",
    );
  });

  it("derives a first-line summary and strips markdown chrome", () => {
    expect(artifactTitle("## Update the legal page:\nbody", "prompt")).toBe(
      "Update the legal page",
    );
  });

  it("falls back to the kind label when there is no usable line", () => {
    expect(artifactTitle("   \n\n", "details")).toBe("Details");
  });

  it("truncates an overlong title", () => {
    const title = artifactTitle("x".repeat(200), "prompt");
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("artifactSizeLabel", () => {
  it("reports line count and character count", () => {
    expect(artifactSizeLabel("a\nb\nc")).toBe("3 lines · 5 chars");
    expect(artifactSizeLabel("a")).toBe("1 line · 1 chars");
  });

  it("abbreviates large counts", () => {
    expect(artifactSizeLabel("x".repeat(1800))).toContain("1.8k chars");
  });
});

describe("artifactPreview", () => {
  it("keeps whole lines and never appends an ellipsis marker", () => {
    const preview = artifactPreview(LONG);
    expect(artifactPreviewLines(LONG).length).toBe(ARTIFACT_PREVIEW_LINES);
    expect(preview.includes("…")).toBe(false);
    expect(preview.endsWith("…")).toBe(false);
  });

  it("does not cut mid-sentence: the last previewed line is complete", () => {
    const lines = artifactPreviewLines(LONG);
    for (const line of lines) expect(LONG.split("\n")).toContain(line);
  });

  it("reports when there is more content than the preview shows", () => {
    expect(artifactHasMore(LONG)).toBe(true);
    expect(artifactHasMore("one\ntwo")).toBe(false);
  });
});

describe("artifactLooksLikeMarkdown", () => {
  it("detects headings, lists, fences, quotes, tables, emphasis, code and links", () => {
    expect(artifactLooksLikeMarkdown("# Title\n\nbody")).toBe(true);
    expect(artifactLooksLikeMarkdown("intro\n- one\n- two")).toBe(true);
    expect(artifactLooksLikeMarkdown("steps\n1. first\n2. second")).toBe(true);
    expect(artifactLooksLikeMarkdown("```sh\nhq sync\n```")).toBe(true);
    expect(artifactLooksLikeMarkdown("> quoted line")).toBe(true);
    expect(artifactLooksLikeMarkdown("| a | b |\n| --- | --- |")).toBe(true);
    expect(artifactLooksLikeMarkdown("this is **bold** text")).toBe(true);
    expect(artifactLooksLikeMarkdown("run `hq dm` now")).toBe(true);
    expect(artifactLooksLikeMarkdown("see [docs](https://x.test/d)")).toBe(true);
  });

  it("leaves plain prose, logs and JSON as plain text", () => {
    expect(artifactLooksLikeMarkdown(LONG)).toBe(false);
    expect(artifactLooksLikeMarkdown("Read the handoff. Start with Gap 1.")).toBe(false);
    expect(artifactLooksLikeMarkdown('{"ok": true, "n": 3}')).toBe(false);
    expect(
      artifactLooksLikeMarkdown("12:01 worker started\n12:02 worker * idle"),
    ).toBe(false);
  });
});

describe("artifactBodyAfterTitle", () => {
  it("drops a leading heading the card already shows as its title", () => {
    const text = "# Handoff notes\n\nFirst real line.\nSecond line.";
    expect(artifactBodyAfterTitle(text, "details")).toBe(
      "First real line.\nSecond line.",
    );
  });

  it("drops a leading TITLE: label line", () => {
    expect(artifactBodyAfterTitle("Title: Legal page\nBody here", "prompt")).toBe(
      "Body here",
    );
  });

  it("keeps ordinary first lines — the title was only a summary of them", () => {
    expect(artifactBodyAfterTitle(LONG, "details")).toBe(LONG);
    expect(artifactBodyAfterTitle("Read the handoff.\nThen act.", "prompt")).toBe(
      "Read the handoff.\nThen act.",
    );
  });
});

describe("artifactSummary", () => {
  it("returns the first content line after the title, markdown stripped", () => {
    expect(
      artifactSummary("# Handoff\n\n- **hq-pro** is `quiet` now\n- more", "details"),
    ).toBe("hq-pro is quiet now");
    expect(artifactSummary(LONG, "details")).toMatch(/^The terms must state/);
  });

  it("skips fences, rules and table separators", () => {
    expect(
      artifactSummary("# T\n```sh\nhq sync\n```\n---\n| a | b |\n| --- | --- |\n| x | y |", "details"),
    ).toBe("a · b");
  });

  it("is empty for a title-only artifact and truncates long lines", () => {
    expect(artifactSummary("# Only", "prompt")).toBe("");
    const long = `Title line\n${"word ".repeat(80)}`;
    const out = artifactSummary(long, "prompt");
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("chatArtifact", () => {
  it("carries the FULL text plus card metadata", () => {
    const artifact = chatArtifact({
      text: LONG,
      eventId: "evt-1",
      kind: "details",
    });
    expect(artifact.id).toBe("evt-1:details");
    expect(artifact.kindLabel).toBe("Details");
    expect(artifact.title).toBe("Please update the legal page.");
    expect(artifact.text).toBe(LONG);
    expect(artifact.text).toContain("only reachable in the side pane");
    expect(artifact.lineCount).toBe(7);
    expect(artifact.sizeLabel).toContain("7 lines");
  });
});
