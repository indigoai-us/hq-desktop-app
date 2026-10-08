// @vitest-environment happy-dom

/** AUDIT-3c: a failed create never puts transport text in the sheet footer. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import NewProjectSheet from "./NewProjectSheet.svelte";
import { resetFormDrafts } from "../common/form-drafts.js";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  resetFormDrafts();
  vi.restoreAllMocks();
});

describe("NewProjectSheet raw error text", () => {
  it("shows plain copy when create fails and logs the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    component = mount(NewProjectSheet, {
      target: document.body,
      props: {
        company: "hpo",
        companies: ["hpo"],
        objectives: [],
        onclose: vi.fn(),
        oncreate: vi.fn(async () => { throw err; }),
      },
    });
    flushSync();
    const input = document.querySelector<HTMLInputElement>('[data-testid="new-project-name"]')!;
    input.value = "launch";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const create = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Create project"))!;
    create.click();
    for (let i = 0; i < 6; i++) { await tick(); await Promise.resolve(); }
    flushSync();
    const footer = document.querySelector(".sf")!;
    expect(footer.textContent).toContain("Could not create the project. Try again.");
    expect(document.body.innerHTML).not.toContain("HTTP 500");
    expect(warn).toHaveBeenCalledWith("[projects] new project failed", err);
  });
});
