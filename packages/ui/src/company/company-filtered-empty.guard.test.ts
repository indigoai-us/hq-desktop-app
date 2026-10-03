import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listEmptyState } from "../common/list-empty-state.js";

/**
 * QA-058 guard: a company list that has a search box or filter tabs must not
 * say "No <items> yet" while its unfiltered source has rows. The shared
 * ListEmptyState decides that; these panes may not hand-roll it.
 */
const PANES = [
  "files-connect/FilesConnectPage.svelte",
  "brain/BrainPage.svelte",
  "../projects/ProjectListView.svelte",
  "../files/CompanyFileTree.svelte",
  "DeploymentsPanel.svelte",
  "SecretsPanel.svelte",
];

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("company filtered-empty guard (QA-058)", () => {
  it("never reports an empty source when the source total is non-zero", () => {
    for (const total of [1, 6, 133]) {
      for (const input of [{ query: "zz" }, { filtered: true }, { query: "zz", filtered: true }]) {
        const view = listEmptyState({ total, shown: 0, noun: ["secret", "secrets"], emptyCopy: "No secrets yet", ...input });
        expect(view?.kind).toBe("no-matches");
        expect(view?.title).not.toMatch(/yet/);
      }
    }
  });

  it.each(PANES)("%s routes its empty list through ListEmptyState", (rel) => {
    const text = source(rel);
    expect(text).toContain("ListEmptyState");
    // A query-or-filter ternary that falls back to "... yet" is the QA-058 bug shape.
    expect(text).not.toMatch(/\?\s*"No [^"]*"\s*:\s*"No [^"]* yet"/);
  });
});
