import { describe, expect, it } from "vitest";

import {
  ARTIFACT_PREVIEW_LINES,
  artifactHasMore,
  artifactPreview,
  artifactPreviewLines,
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
