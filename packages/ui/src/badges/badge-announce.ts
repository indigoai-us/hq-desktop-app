/**
 * "You earned <Badge>" ("You were awarded <Badge>" for OG, Captain and
 * Patient Zero): the notice when a badge is earned, through the app's
 * one toast layer. Every tier carries a "Reveal card" action that opens the
 * card with its staged entrance, so the notice stays until it is used or
 * dismissed. The notice has the cards' holographic shimmer and the badge's
 * mark (its icon in a ring of the tier's colour).
 *
 * Several badges at once (all that came since your last visit) make one
 * notice: "You earned 4 badges", their marks in a row and "Reveal cards",
 * which shows the cards one after another.
 *
 * Nothing in the app calls this yet: there are no earning events. The design
 * harness triggers it (`?earn=<badge>` on the shell view) to demo the reveal.
 */

import { mount, unmount } from "svelte";
import BadgeCardModal from "./BadgeCardModal.svelte";
import BadgeNoticeMarks from "./BadgeNoticeMarks.svelte";
import { TIER_NAME, isAwarded, resolveEarned, type EarnedBadge, type ResolvedBadge } from "./badge-catalog.js";
import { pushToast } from "../shell/toast-stack.svelte.js";

/**
 * Open a badge's card with the reveal. Returns a function that closes it.
 * `onclosed` runs when the person closes the card (not when the returned
 * function does).
 */
export function revealBadgeCard(badge: ResolvedBadge, onclosed?: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  let instance: ReturnType<typeof mount> | null = null;
  const close = () => {
    const current = instance;
    instance = null;
    if (current) void unmount(current);
  };
  instance = mount(BadgeCardModal, {
    target: document.body,
    props: {
      open: true,
      badge,
      reveal: true,
      onclose: () => {
        close();
        onclosed?.();
      },
    },
  });
  return close;
}

/**
 * Reveal several cards one after another: closing one opens the next.
 * Returns a function that closes the one showing and stops the rest.
 */
export function revealBadgeCards(badges: readonly ResolvedBadge[]): () => void {
  let stopped = false;
  let closeCurrent: () => void = () => {};
  const show = (i: number) => {
    if (stopped || i >= badges.length) return;
    closeCurrent = revealBadgeCard(badges[i], () => show(i + 1));
  };
  show(0);
  return () => {
    stopped = true;
    closeCurrent();
  };
}

/** "OG", "OG and Captain", "OG, Captain and Liftoff". */
function nameList(badges: readonly ResolvedBadge[]): string {
  const names = badges.map((b) => b.def.name);
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
    // Given, not earned (owner review 2026-10-12).
    title: isAwarded(badge.def) ? `You were awarded ${badge.def.name}` : `You earned ${badge.def.name}`,
    detail: `${TIER_NAME[badge.tier]} · ${badge.def.crit}.`,
    testId: "badge-earned-toast",
    look: "holo",
    lead: { component: BadgeNoticeMarks, props: { badges: [badge] } },
    actions: [{ label: "Reveal card", primary: true, testId: "badge-earned-reveal", onAction: () => void revealBadgeCard(badge) }],
  });
}

/**
 * Tell the person about every badge that came since their last visit: one
 * badge gets its own notice; several get one notice that names them all.
 * Returns the toast id, or null when none of them is in the catalog.
 */
export function announceBadgesEarned(earned: readonly EarnedBadge[]): string | null {
  const seen = new Set<string>();
  const badges = resolveEarned(earned).filter((b) => !seen.has(b.def.id) && seen.add(b.def.id));
  if (badges.length === 0) return null;
  if (badges.length === 1) return announceBadgeEarned(earned.find((e) => e.id === badges[0].def.id)!);
  // Given, not earned, when every one of them was given (owner review 2026-10-12).
  const verb = badges.every((b) => isAwarded(b.def)) ? "You were awarded" : "You earned";
  return pushToast({
    key: "badges-earned",
    kind: "sticky",
    tone: "neutral",
    title: `${verb} ${badges.length} badges`,
    detail: `${nameList(badges)}.`,
    testId: "badges-earned-toast",
    look: "holo",
    lead: { component: BadgeNoticeMarks, props: { badges } },
    actions: [{ label: "Reveal cards", primary: true, testId: "badges-earned-reveal", onAction: () => void revealBadgeCards(badges) }],
  });
}
