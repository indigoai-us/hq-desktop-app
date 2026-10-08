/**
 * "You earned <Badge>": the notice when a badge is earned, through the app's
 * one toast layer. Every tier carries a "Reveal card" action that opens the
 * card with its staged entrance, so the notice stays until it is used or
 * dismissed.
 *
 * Nothing in the app calls this yet: there are no earning events. The design
 * harness triggers it (`?earn=<badge>` on the shell view) to demo the reveal.
 */

import { mount, unmount } from "svelte";
import BadgeCardModal from "./BadgeCardModal.svelte";
import { TIER_NAME, resolveEarned, type EarnedBadge, type ResolvedBadge } from "./badge-catalog.js";
import { pushToast } from "../shell/toast-stack.svelte.js";

/** Open a badge's card with the reveal. Returns a function that closes it. */
export function revealBadgeCard(badge: ResolvedBadge): () => void {
  if (typeof document === "undefined") return () => {};
  let instance: ReturnType<typeof mount> | null = null;
  const close = () => {
    const current = instance;
    instance = null;
    if (current) void unmount(current);
  };
  instance = mount(BadgeCardModal, {
    target: document.body,
    props: { open: true, badge, reveal: true, onclose: close },
  });
  return close;
}

/**
 * Tell the person they earned a badge. Returns the toast id, or null for a
 * badge the catalog does not know.
 */
export function announceBadgeEarned(earned: EarnedBadge): string | null {
  const badge = resolveEarned([earned])[0];
  if (!badge) return null;
  return pushToast({
    key: `badge-earned:${badge.def.id}`,
    // A notice with an action stays until it is used or dismissed.
    kind: "sticky",
    tone: "neutral",
    title: `You earned ${badge.def.name}`,
    detail: `${TIER_NAME[badge.tier]} · ${badge.def.crit}.`,
    testId: "badge-earned-toast",
    actions: [{ label: "Reveal card", primary: true, testId: "badge-earned-reveal", onAction: () => void revealBadgeCard(badge) }],
  });
}
