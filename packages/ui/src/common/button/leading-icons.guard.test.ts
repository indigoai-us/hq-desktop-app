/**
 * Owner feedback (2026-10-05): "please ensure every button has an icon in the
 * app". Pins the four buttons from the owner's screenshots and the shared
 * spacing rule for leading icons inside non-RailButton buttons.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

function buttonAround(src: string, label: string): string {
  const at = src.indexOf(label);
  expect(at, label).toBeGreaterThan(-1);
  const start = src.lastIndexOf("<button", at);
  return src.slice(start, src.indexOf("</button>", at));
}

describe("labelled buttons carry a leading icon", () => {
  it.each([
    ["projects/CompanyProjectsPage.svelte", '"New project"', "plus"],
    ["marketplace/SubmitPanel.svelte", '"Choose folder…"', "folder"],
    ["marketplace/SubmitPanel.svelte", "Submit for review", "send"],
    ["marketplace/ModerationPanel.svelte", "Refresh", "refresh"],
  ])("%s %s has the %s icon", (rel, label, icon) => {
    expect(buttonAround(read(rel), label)).toContain(`<RailIcon name="${icon}" />`);
  });

  it("spaces a leading icon 6px from the label and centres it", () => {
    const css = read("common/button/rail-type.css");
    expect(css).toMatch(/button:not\(\[data-rail-btn\]\) > svg\.rail-icon:first-child \{[^}]*margin-inline-end: 6px/u);
    expect(read("common/button/RailIcon.svelte")).toMatch(/import "\.\/rail-type\.css"/u);
  });
});

/**
 * Owner decision (2026-10-05): "Finish all of them". New icons drawn in the
 * same line style, every remaining action button has one, and the typed "+"
 * and "←" in labels are real icons.
 */
describe("remaining action buttons (second sweep)", () => {
  it("adds the new icons to the line set in the same 16px style", async () => {
    const { LINE_ICONS } = await import("./rail-icons.js");
    for (const name of ["archive", "ban", "check-circle", "bell", "door", "sliders"] as const) {
      expect(LINE_ICONS[name], name).toMatch(/^M[\d.\s,a-zA-Z-]+$/u);
      expect(LINE_ICONS[name]).not.toMatch(/fill/u);
    }
  });

  it.each([
    ["chat/ChatSidebar.svelte", '"Unarchive" : "Archive"', "archive"],
    ["marketplace/ModerationPanel.svelte", '"Reject"', "ban"],
    ["agents/FolderPicker.svelte", ">Choose<", "check-circle"],
    ["meet/OfficeHours.svelte", '"Mark me reachable"', "bell"],
    ["meet/KnockCard.svelte", "Open the door", "door"],
    ["meet/OfficeHours.svelte", "Manage your door", "sliders"],
  ])("%s %s has the %s icon", (rel, label, icon) => {
    expect(buttonAround(read(rel), label)).toContain(`<RailIcon name="${icon}" />`);
  });

  it("uses real icons instead of typed + and ← in labels", () => {
    const moderation = read("marketplace/ModerationPanel.svelte");
    expect(moderation).not.toContain("← Back to queue");
    expect(buttonAround(moderation, "Back to queue")).toContain('<RailIcon name="arrow-left" />');
    const thread = read("board/ThreadDetail.svelte");
    expect(thread).not.toContain("← Board");
    expect(thread).toContain('<RailIcon name="arrow-left" />Board');
    const create = read("chat/CreateModal.svelte");
    expect(create).not.toContain('<span class="create-glyph" aria-hidden="true">+</span>');
    expect(buttonAround(create, ">Create channel #{findResults.createSlug}")).toContain('<RailIcon name="plus" />');
    expect(buttonAround(create, "Invite {candidate.label}")).toContain('<RailIcon name="plus" />');
    expect(read("shell/MoreCompaniesPopover.svelte")).toContain(
      '<span class="mark" aria-hidden="true"><RailIcon name="plus" /></span>',
    );
    expect(read("chat/ChatSidebar.svelte")).not.toContain('<span class="chat-glyph" aria-hidden="true">+</span>');
    expect(read("marketplace/ProfilePanel.svelte")).not.toContain("+ Add link");
    expect(read("goals/NewGoalSheet.svelte")).not.toContain(">+ Link<");
  });
});
