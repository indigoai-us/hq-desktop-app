// @vitest-environment happy-dom
//
// usage-only-pricing US-016: the account menu reaches Settings › Sync in one
// click on hosts that sync, and shows no Sync entry on hosts that don't.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import AccountMenu from "./AccountMenu.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.append(host);
  component = mount(AccountMenu, { target: host, props: { name: "Ada Lovelace", ...props } as never });
  flushSync();
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("AccountMenu Sync entry (US-016)", () => {
  it("opens Sync settings in one click", () => {
    const onsync = vi.fn();
    const onpage = vi.fn();
    render({ onsync, onpage });
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((el) => el.getAttribute("data-testid"));
    expect(items).toEqual(["account-identity", "account-settings", "account-sync", "account-sign-out"]);
    expect(q("account-sync")?.textContent).toContain("Sync");
    q("account-sync")!.click();
    expect(onsync).toHaveBeenCalledTimes(1);
    expect(onpage).not.toHaveBeenCalled();
  });

  it("has no Sync entry without a Sync section", () => {
    render({ onpage: vi.fn() });
    expect(q("account-sync")).toBeNull();
  });
});
