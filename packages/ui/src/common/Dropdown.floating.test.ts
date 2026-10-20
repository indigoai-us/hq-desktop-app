// @vitest-environment happy-dom

// `floating` portals the list to the app shell so a clipping container can't
// cut it off. Without it the list stays inline, as every other picker expects.

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import Dropdown from "./Dropdown.svelte";

let shell: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  shell?.remove();
});

const options = [
  { value: "", label: "Personal" },
  { value: "a", label: "Indigo" },
  { value: "b", label: "Holler" },
];

async function open(floating: boolean) {
  shell = document.createElement("div");
  shell.className = "desktop-shell";
  const clip = document.createElement("div");
  clip.style.overflow = "hidden";
  clip.style.height = "40px";
  shell.appendChild(clip);
  document.body.appendChild(shell);
  component = mount(Dropdown, {
    target: clip,
    props: { value: "", options, label: "Record as", testid: "pick", floating },
  });
  const button = clip.querySelector<HTMLButtonElement>('[data-testid="pick"]')!;
  button.click();
  await tick();
  await tick();
  return { clip, button, menu: document.querySelector<HTMLElement>('[data-testid="pick-menu"]')! };
}

describe("Dropdown floating", () => {
  it("portals the list to the shell, fixed below the button", async () => {
    const { clip, menu } = await open(true);
    expect(clip.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(shell);
    expect(menu.style.position).toBe("fixed");
    expect(menu.classList.contains("floating")).toBe(true);
    expect(menu.querySelectorAll('[role="option"]')).toHaveLength(3);
  });

  it("removes the portaled list when it closes", async () => {
    const { button } = await open(true);
    button.click();
    await tick();
    expect(document.querySelector('[data-testid="pick-menu"]')).toBeNull();
  });

  it("keeps the list inline when floating is off", async () => {
    const { clip, menu } = await open(false);
    expect(clip.contains(menu)).toBe(true);
    expect(menu.style.position).toBe("");
  });
});
