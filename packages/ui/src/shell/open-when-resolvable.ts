import type {
  NavigationNavigateResult,
  NavigationResolveOutcome,
} from "./navigation-controller.js";
import type { NavigationDestination } from "./navigation-history.js";

/**
 * Navigates only when the shell resolver accepts the destination. The
 * resolver is the one check every page registers with, so a page added later
 * (for example outpost-jobs) opens without a change here. An unknown page
 * returns false and never reaches the rejected-navigation error.
 */
export async function openWhenResolvable(
  destination: NavigationDestination,
  deps: {
    resolve: (
      destination: NavigationDestination,
    ) => NavigationResolveOutcome | Promise<NavigationResolveOutcome>;
    navigate: (
      destination: NavigationDestination,
    ) => NavigationNavigateResult | Promise<NavigationNavigateResult>;
  },
): Promise<boolean> {
  const outcome = await deps.resolve(destination);
  if (outcome.status !== "ready") return false;
  const result = await deps.navigate(destination);
  return result.committed;
}
