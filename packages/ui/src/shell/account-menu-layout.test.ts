/**
 * Account menu rows (owner review 2026-10-08): Sign out has its icon like
 * Settings, and the divider under the name block sits apart from it, with
 * the same gaps as the divider above Sign out, so a hovered row never
 * touches a line.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "AccountMenu.svelte"), "utf8");
const rule = (sel: string) => src.match(new RegExp(`\\n  ${sel.replace(".", "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("account menu layout", () => {
  it("Sign out has an icon", () => {
    expect(src).toMatch(/data-testid="account-sign-out"[^>]*>\s*<span class="row-ico" aria-hidden="true"><RailIcon name="logout"/);
    expect(src).not.toContain("indent");
  });

  it("the name block's divider is apart from the hovered row, like the one above Sign out", () => {
    expect(rule(".who")).not.toContain("border-bottom");
    expect(rule(".head")).toContain("border-bottom: 1px solid var(--v4-rowline);");
    expect(rule(".head")).toContain("padding-bottom: 4px;");
    expect(rule(".foot")).toContain("margin-top: 4px;");
  });
});
