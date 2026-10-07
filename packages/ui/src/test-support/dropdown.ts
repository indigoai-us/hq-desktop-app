// OWNER-R6: test helpers for the shared styled Dropdown (common/Dropdown.svelte),
// which replaced native selects. The control loads on demand, so each helper
// waits for its button first.
import { flushSync } from "svelte";
import { vi } from "vitest";

type Root = ParentNode;

/** The dropdown button for `testid`, once it has loaded. */
export async function dropdownButton(root: Root, testid: string): Promise<HTMLButtonElement> {
  return vi.waitFor(() => {
    const el = root.querySelector<HTMLButtonElement>(`button[data-testid="${testid}"]`);
    if (!el) throw new Error(`dropdown ${testid} not rendered`);
    return el;
  });
}

/** The current value of a dropdown. */
export async function dropdownValue(root: Root, testid: string): Promise<string> {
  return (await dropdownButton(root, testid)).dataset.value ?? "";
}

/** Open the dropdown and return its options (value, label, disabled); closes it again. */
export async function dropdownOptions(
  root: Root,
  testid: string,
): Promise<Array<{ value: string; label: string; disabled: boolean; selected: boolean }>> {
  const button = await dropdownButton(root, testid);
  button.click();
  flushSync();
  const menu = await vi.waitFor(() => {
    const el = root.querySelector(`[data-testid="${testid}-menu"]`);
    if (!el) throw new Error(`dropdown ${testid} menu not open`);
    return el;
  });
  const out = [...menu.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => ({
    value: o.dataset.value ?? "",
    label: o.querySelector(".dd-label")?.textContent?.trim() ?? "",
    disabled: o.getAttribute("aria-disabled") === "true",
    selected: o.getAttribute("aria-selected") === "true",
  }));
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  return out;
}

/** Choose `value` in the dropdown, as a person would. */
export async function chooseDropdown(root: Root, testid: string, value: string): Promise<void> {
  const button = await dropdownButton(root, testid);
  button.click();
  flushSync();
  const option = await vi.waitFor(() => {
    const el = root.querySelector<HTMLElement>(`[data-testid="${testid}-menu"] [role="option"][data-value="${CSS.escape(value)}"]`);
    if (!el) throw new Error(`dropdown ${testid} has no option ${value}`);
    return el;
  });
  option.click();
  flushSync();
}
