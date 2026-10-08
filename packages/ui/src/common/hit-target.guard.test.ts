// AUDIT-2-10..13: every control on the audited surfaces has a clickable box of
// at least 28x28 px while keeping its drawn size. Two sanctioned ways:
//   1. the class sits in the file's hit-area rule, whose ::after pad is
//      `inset: min(0px, calc(50% - 14px))` (grows only axes under 28 px);
//   2. the class grows by padding that a matching negative margin takes back
//      out of layout (used where an ellipsis clips pseudo-elements).
// Walked surfaces: the files that render the thirteen measured controls. In the
// whole-surface files every <button>/<a> is walked; the three large shell
// files are walked for the measured control only.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

const WHOLE_SURFACE = [
  "meetings/MeetingsSidepane.svelte",
  "projects/TaskViewPane.svelte",
  "projects/ProjectRow.svelte",
  "personal/PersonalRailPage.svelte",
  "company/TeamPage.svelte",
];

const MEASURED_IN_LARGE_FILES: Array<[string, string]> = [
  ["chat/ChatSidebar.svelte", "chat-pin-btn"],
  ["shell/DesktopApp.svelte", "edit-profile-btn"],
  ["chat/messaging/ChannelConversation.svelte", "dm-msg-author-btn"],
];

function styleOf(file: string): string {
  const s = readFileSync(join(src, file), "utf8");
  return s.slice(s.lastIndexOf("<style"));
}

function hitClasses(style: string): Set<string> {
  const out = new Set<string>();
  const rule = /([^{}]+)\{[^}]*inset:\s*min\(0px,\s*calc\(50%\s*-\s*14px\)\)[^}]*\}/g;
  for (const m of style.matchAll(rule)) {
    for (const sel of m[1].split(",")) {
      const c = /\.([\w-]+)::after\s*$/.exec(sel.trim());
      if (c) out.add(c[1]);
    }
  }
  const pad = /([^{}]+)\{[^}]*padding:\s*(\d+)px 0;[^}]*margin-block:\s*-(\d+)px;[^}]*\}/g;
  for (const m of style.matchAll(pad)) {
    if (m[2] !== m[3]) continue;
    const c = /\.([\w-]+)\s*$/.exec(m[1].trim());
    if (c) out.add(c[1]);
  }
  return out;
}

function interactiveClasses(file: string): Array<{ tag: string; cls: string | null }> {
  const s = readFileSync(join(src, file), "utf8");
  const markup = s.slice(0, s.lastIndexOf("<style"));
  return [...markup.matchAll(/<(button|a)\b([^>]*)>/gs)].map((m) => {
    const c = /class="([^"]*)"/.exec(m[2]);
    return { tag: m[1], cls: c ? c[1] : null };
  });
}

describe("28px hit-target guard (AUDIT-2-10..13)", () => {
  for (const file of WHOLE_SURFACE) {
    it(`${file}: every button and link carries a 28px hit area`, () => {
      const hits = hitClasses(styleOf(file));
      const missing = interactiveClasses(file)
        .filter(({ cls }) => !cls || !cls.split(/\s+/).some((c) => hits.has(c)))
        .map(({ tag, cls }) => `<${tag} class="${cls ?? ""}">`);
      expect(missing).toEqual([]);
    });
  }
  for (const [file, cls] of MEASURED_IN_LARGE_FILES) {
    it(`${file}: .${cls} carries a 28px hit area`, () => {
      expect(hitClasses(styleOf(file)).has(cls)).toBe(true);
    });
  }
  it("the hit area is a pad, not a resize: no width or height in the pad rule", () => {
    for (const file of [...WHOLE_SURFACE, ...MEASURED_IN_LARGE_FILES.map(([f]) => f)]) {
      const style = styleOf(file);
      for (const m of style.matchAll(/\{([^}]*inset:\s*min\(0px[^}]*)\}/g)) {
        expect(m[1], file).not.toMatch(/(^|[\s;])(width|height|min-width|min-height):/);
        expect(m[1], file).toMatch(/position:\s*absolute/);
      }
    }
  });
});
