// QA-079: the shell feeds the palette the same project list the Projects page
// loads, refreshes it on open, and opens the project on select.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("./DesktopApp.svelte", import.meta.url), "utf8");

describe("DesktopApp palette projects (QA-079)", () => {
  it("indexes the Projects page list and opens the project on select", () => {
    const body = shell.slice(shell.indexOf("const paletteCommands = $derived.by("));
    expect(body).toContain("paletteProjectItems(");
    // Company projects open on the company's own Projects page.
    expect(body).toContain("void navigate(paletteProjectDestination(item));");
    expect(body).not.toMatch(/navigate\(\{\s*kind: "projects",\s*company: item\.companySlug/);
    expect(shell).toContain("paletteProjects = await loadLocalProjects()");
    expect(shell).toContain("if (paletteOpen) untrack(() => void refreshPaletteProjects());");
  });

  it("sends the Projects command to the selected company's Projects page", () => {
    const start = shell.indexOf('id: "command-go-projects"');
    expect(start).toBeGreaterThan(0);
    const command = shell.slice(start, shell.indexOf("});", start));
    expect(command).toContain("void navigate(paletteProjectsCommandDestination(tenantCompanyId));");
  });
});
