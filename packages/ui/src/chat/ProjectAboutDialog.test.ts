// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import ProjectAboutDialog from "./ProjectAboutDialog.svelte";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ProjectAboutDialog.svelte"),
  "utf8",
);

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("ProjectAboutDialog", () => {
  it("shows the project description", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ProjectAboutDialog, {
      target: host,
      props: {
        title: "work-mesh-testing",
        description: "Live board for HQ Work mesh.",
      },
    });
    await tick();
    expect(host.querySelector("#project-about-title")?.textContent).toBe(
      "work-mesh-testing",
    );
    expect(
      host.querySelector("[data-testid='project-about-body']")?.textContent,
    ).toBe("Live board for HQ Work mesh.");
  });

  it("falls back when the project has no description", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ProjectAboutDialog, {
      target: host,
      props: { title: "empty", description: "   " },
    });
    await tick();
    expect(
      host.querySelector("[data-testid='project-about-body']")?.textContent,
    ).toBe("No description for this project.");
  });

  it("uses a solid surface so timeline text cannot bleed through", () => {
    expect(SRC).toContain("--v4-surface-solid");
    expect(SRC).not.toMatch(/background:\s*var\(--v4-ground/);
  });
});
