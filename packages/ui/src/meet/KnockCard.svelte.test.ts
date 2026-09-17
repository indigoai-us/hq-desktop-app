// @vitest-environment happy-dom

/**
 * US-019 knock card: quiet and actionable. It announces politely rather than
 * ringing, every action is a real focusable button, the state and countdown
 * are words (never colour alone), and nothing on the card starts capture.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import KnockCard from "./KnockCard.svelte";
import { parseKnock, type Knock } from "./knocks.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const NOW = 1_000_000;

const KNOCK: Knock = parseKnock({
  knockId: "knk_1",
  companyUid: "cmp_a",
  roomId: "room_1",
  callId: "call_1",
  epoch: 3,
  from: "prs_knocker",
  target: "prs_self",
  note: "Two minutes on pricing?",
  state: "pending",
  createdAt: NOW - 1_000,
  updatedAt: NOW - 1_000,
  expiresAt: NOW + 42_000,
})!;

function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(KnockCard, {
    target: host,
    props: { knock: KNOCK, now: () => NOW, tickMs: 0, ...props } as never,
  });
  flushSync();
  return host;
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("KnockCard", () => {
  it("announces politely and is not a modal or a ring", () => {
    const root = render({});
    const card = testid(root, "knock-card-knk_1")!;
    expect(card.getAttribute("role")).toBe("status");
    expect(card.getAttribute("aria-live")).toBe("polite");
    expect(card.getAttribute("aria-modal")).toBeNull();
    expect(root.querySelector("audio")).toBeNull();
    expect(root.querySelector("video")).toBeNull();
  });

  it("writes the note, the countdown and the state as text", () => {
    const root = render({});
    expect(testid(root, "knock-note-knk_1")?.textContent).toContain(
      "Two minutes on pricing?",
    );
    expect(testid(root, "knock-countdown-knk_1")?.textContent).toContain("42s");
    expect(testid(root, "knock-state-knk_1")?.textContent).toContain(
      "Waiting for an answer",
    );
  });

  it("says what will be captured before anything is — camera never starts", () => {
    const root = render({});
    const intent = testid(root, "knock-join-intent-knk_1")!.textContent ?? "";
    expect(intent).toContain("muted");
    expect(intent).toContain("Camera stays off");
    const withMic = render({ joinIntent: { microphone: true, transcript: true } });
    const text = testid(withMic, "knock-join-intent-knk_1")!.textContent ?? "";
    expect(text).toContain("microphone on");
    expect(text).toContain("Camera stays off");
  });

  it("offers accept / reply / defer / dismiss as keyboard-operable buttons", () => {
    const root = render({});
    for (const action of ["accept", "reply", "defer", "dismiss"]) {
      const button = testid(root, `knock-${action}-knk_1`)!;
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("disabled")).toBeNull();
      expect((button.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("accepts through the host — the card itself opens nothing", () => {
    const onaccept = vi.fn();
    const root = render({ onaccept });
    testid(root, "knock-accept-knk_1")!.click();
    flushSync();
    expect(onaccept).toHaveBeenCalledWith(KNOCK);
  });

  it("sends a typed reply and leaves the door alone until it does", () => {
    const onreply = vi.fn();
    const root = render({ onreply, replySuggestion: "Give me ten minutes." });
    testid(root, "knock-reply-knk_1")!.click();
    flushSync();
    const field = testid(root, "knock-reply-text-knk_1") as HTMLTextAreaElement;
    expect(field.value).toBe("Give me ten minutes.");
    testid(root, "knock-reply-send-knk_1")!.click();
    flushSync();
    expect(onreply).toHaveBeenCalledWith(KNOCK, "Give me ten minutes.");
  });

  it("shows no door at all once the knock has expired", () => {
    const root = render({ now: () => NOW + 60_000 });
    expect(testid(root, "knock-accept-knk_1")).toBeNull();
    expect(testid(root, "knock-state-knk_1")?.textContent).toContain("expired");
  });

  it("keeps a decided state decided, even past the countdown", () => {
    const root = render({
      knock: { ...KNOCK, state: "accepted" as const },
      now: () => NOW + 60_000,
    });
    expect(testid(root, "knock-accept-knk_1")).toBeNull();
    expect(testid(root, "knock-state-knk_1")?.textContent).toContain(
      "Door opened",
    );
  });

  it("renders a sent knock as withdrawable, not answerable", () => {
    const oncancel = vi.fn();
    const root = render({ direction: "sent", oncancel });
    expect(testid(root, "knock-accept-knk_1")).toBeNull();
    testid(root, "knock-cancel-knk_1")!.click();
    flushSync();
    expect(oncancel).toHaveBeenCalled();
  });

  it("disables every action while an answer is in flight", () => {
    const root = render({ busy: true });
    for (const action of ["accept", "reply", "defer", "dismiss"]) {
      expect(testid(root, `knock-${action}-knk_1`)?.hasAttribute("disabled")).toBe(
        true,
      );
    }
  });
});
