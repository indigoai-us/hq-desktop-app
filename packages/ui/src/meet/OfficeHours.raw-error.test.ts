// @vitest-environment happy-dom

/**
 * AUDIT-3: a failed office or knock call never puts the transport's own text
 * on screen. The page shows plain copy and Try again; the raw text is logged.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type Json } from "@hq/platform";

import OfficeHours from "./OfficeHours.svelte";
import { createOfficeStore } from "./office-store.svelte.js";
import { knockFailure } from "./knocks.js";

const RAW = '[invoke] office HTTP 502 Bad Gateway: {"message":"upstream"}';

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("Office Hours raw error text", () => {
  it("a failed office read shows plain copy and Try again, not the transport text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createOfficeStore({
      calls: {
        discoverOffice: (async () => failure("UPSTREAM_502", RAW)) as never,
        setOfficePreference: (async () => ok({} as Json)) as never,
        setOfficeConnectivity: (async () => ok({} as Json)) as never,
      },
      selfPersonUid: "prs_self",
      now: () => 1_000_000,
    });
    await store.load("cmp_a");
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(OfficeHours, {
      target: host,
      props: { store, selfPersonUid: "prs_self", tickMs: 0, onretry: () => {} } as never,
    });
    flushSync();

    const notice = host.querySelector('[data-testid="office-error"]');
    expect(notice).not.toBeNull();
    expect(host.textContent).not.toContain("HTTP 502");
    expect(host.textContent).not.toContain("[invoke]");
    expect(notice?.textContent).toContain("Try again");
    expect(warn).toHaveBeenCalledWith("[office] call failed", "UPSTREAM_502", RAW);
  });

  it("a knock refusal with an unknown code shows plain copy, not the transport text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = knockFailure(failure("UPSTREAM_502", RAW));
    expect(error.message).not.toContain("HTTP 502");
    expect(error.message).toBe("That knock was refused. Try again.");
    expect(warn).toHaveBeenCalledWith("[knocks] call failed", "UPSTREAM_502", RAW);
  });
});
