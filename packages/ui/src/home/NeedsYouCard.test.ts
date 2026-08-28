// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

// desktop-alt port: the vitest config resolves the "browser" condition, so
// plain `svelte` already loads the client runtime — no manual mock needed.

import { mount, unmount } from "svelte";
import NeedsYouCard from "./NeedsYouCard.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("NeedsYouCard action recovery", () => {
  it("keeps a rejected action visible and retryable", async () => {
    const onaction = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("native handoff failed"))
      .mockResolvedValueOnce();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NeedsYouCard, {
      target: host,
      props: {
        card: {
          title: "Core changed",
          sub: "Review the local edits",
          tone: "neutral",
          actions: [{ id: "view", label: "View", kind: "secondary" }],
        },
        onaction,
      },
    });

    host.querySelector<HTMLButtonElement>(".v4-card-action")?.click();
    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "That action didn’t complete.",
      );
    });

    host.querySelector<HTMLButtonElement>(".v4-card-error button")?.click();
    await vi.waitFor(() => {
      expect(onaction).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });
  });
});
