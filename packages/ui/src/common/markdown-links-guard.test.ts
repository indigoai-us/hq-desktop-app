// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * QA-104: links in a rendered Markdown preview must go through the shared
 * link handler (common/markdown-links.ts). QA-094 wired it into the project
 * Files preview only, and the Vault, project README and library previews kept
 * dead links. Every component that renders a Markdown document has to attach
 * the handler, and every FilePreviewPane mount has to give it a way to open
 * the linked file.
 *
 * Chat message Markdown has its own link rules and is allow-listed.
 */
const ROOT = new URL("..", import.meta.url).pathname;

const CHAT_ALLOW_LIST = new Set(["chat/messaging/ArtifactPanel.svelte"]);

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, out);
    else if (entry.endsWith(".svelte")) out.push(full);
  }
  return out;
}

const files = svelteFiles(ROOT).map((full) => ({ rel: relative(ROOT, full), src: readFileSync(full, "utf8") }));

describe("Markdown link handler coverage", () => {
  it("attaches the shared link handler wherever a Markdown document renders", () => {
    const renderers = files.filter(({ src }) => /\brenderMarkdown(?:Document)?\(/.test(src));
    expect(renderers.length).toBeGreaterThan(0);
    const offenders = renderers
      .filter(({ rel }) => !CHAT_ALLOW_LIST.has(rel))
      .filter(({ src }) => !/\buse:markdownLinks\b|\bhandleMarkdownLinkClick\(/.test(src))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("gives every FilePreviewPane mount a way to open a linked file", () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      for (const match of src.matchAll(/<FilePreviewPane\b[^>]*?\/>/gs)) {
        if (!/\bonopenpath=/.test(match[0])) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
