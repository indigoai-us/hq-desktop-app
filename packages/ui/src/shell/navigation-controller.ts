/**
 * Shared-shell navigation commit boundary (US-002).
 *
 * Semantic handlers call `navigate` → `resolveDestination` → `commitDestination`.
 * View state is applied only after a successful commit. A generation token
 * drops stale async completions so the latest successful commit wins.
 *
 * This is not `window.history` and not the pending-route bridge in
 * `embedded-navigation.ts` / `EmbeddedNavigationController`.
 */

import {
  canonicalizeDestination,
  createNavigationEntry,
  createNavigationHistory,
  entriesEqual,
  type NavigationDestination,
  type NavigationEntry,
  type NavigationHistory,
  type NavigationScope,
} from "./navigation-history.js";

export type NavigationMode = "push" | "replace";

export type NavigationAvailability = "available" | "unavailable";

export type NavigationResolveOutcome =
  | { status: "ready"; destination: NavigationDestination }
  | {
      status: "unavailable";
      destination: NavigationDestination;
      reason: string;
    }
  | { status: "transient-failure"; error: string }
  | { status: "rejected"; reason: string }
  | { status: "cancelled" }
  | { status: "account-changed"; accountId: string };

export type NavigationNavigateResult = NavigationResolveOutcome & {
  generation: number;
  committed: boolean;
};

export interface NavigationPending {
  generation: number;
  destination: NavigationDestination;
}

export interface AppliedNavigation {
  entry: NavigationEntry;
  availability: NavigationAvailability;
  reason?: string;
  mode: NavigationMode;
}

export interface NavigationResolveContext {
  generation: number;
  accountId: string;
  isStale: () => boolean;
}

export type NavigationResolver = (
  destination: NavigationDestination,
  context: NavigationResolveContext,
) => NavigationResolveOutcome | Promise<NavigationResolveOutcome>;

export interface NavigationControllerDeps {
  history?: NavigationHistory;
  getScope: () => NavigationScope;
  resolve?: NavigationResolver;
  apply: (applied: AppliedNavigation) => void;
  captureCurrent?: () => NavigationEntry | null;
  onPending?: (pending: NavigationPending | null) => void;
  onRejected?: (reason: string) => void;
}

export interface NavigationController {
  readonly history: NavigationHistory;
  generation(): number;
  pending(): NavigationPending | null;
  lastCommitted(): NavigationEntry | null;
  lastAvailability(): NavigationAvailability | null;
  navigate(
    destination: NavigationDestination,
    mode?: NavigationMode,
  ): NavigationNavigateResult | Promise<NavigationNavigateResult>;
  resolveDestination(
    destination: NavigationDestination,
    generation?: number,
  ): NavigationResolveOutcome | Promise<NavigationResolveOutcome>;
  commitDestination(
    outcome: Extract<NavigationResolveOutcome, { status: "ready" | "unavailable" }>,
    mode: NavigationMode,
    generation: number,
  ): boolean;
  back(): NavigationNavigateResult | Promise<NavigationNavigateResult>;
  forward(): NavigationNavigateResult | Promise<NavigationNavigateResult>;
  noteAccount(accountId: string): void;
}

function isThenable<T>(
  value: T | Promise<T>,
): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Navigation failed";
}

function defaultResolve(
  destination: NavigationDestination,
): NavigationResolveOutcome {
  return { status: "ready", destination };
}

export function createNavigationController(
  deps: NavigationControllerDeps,
): NavigationController {
  const history = deps.history ?? createNavigationHistory();
  const resolveFn = deps.resolve ?? defaultResolve;
  let currentGeneration = 0;
  let pending: NavigationPending | null = null;
  let lastCommit: NavigationEntry | null = null;
  let lastAvailability: NavigationAvailability | null = null;
  let lastAccountId: string | null = null;

  const setPending = (next: NavigationPending | null) => {
    pending = next;
    deps.onPending?.(next);
  };

  const scopeNow = (): NavigationScope => deps.getScope();

  const makeContext = (
    generation: number,
    accountId: string,
  ): NavigationResolveContext => ({
    generation,
    accountId,
    isStale: () =>
      generation !== currentGeneration ||
      scopeNow().accountId !== accountId,
  });

  function seedCurrentIfNeeded(next: NavigationEntry): void {
    if (history.current()) return;
    const current = deps.captureCurrent?.() ?? null;
    if (!current) return;
    if (entriesEqual(current, next)) return;
    history.push(current);
  }

  function resolveDestination(
    destination: NavigationDestination,
    generation: number = currentGeneration,
  ): NavigationResolveOutcome | Promise<NavigationResolveOutcome> {
    const scope = scopeNow();
    const context = makeContext(generation, scope.accountId);
    if (context.isStale()) return { status: "cancelled" };
    let resolved: NavigationResolveOutcome | Promise<NavigationResolveOutcome>;
    try {
      resolved = resolveFn(canonicalizeDestination(destination), context);
    } catch (error) {
      return { status: "transient-failure", error: asErrorMessage(error) };
    }
    if (!isThenable(resolved)) {
      if (context.isStale()) return { status: "cancelled" };
      if (scopeNow().accountId !== scope.accountId) {
        return { status: "account-changed", accountId: scopeNow().accountId };
      }
      return resolved;
    }
    return resolved.then(
      (value) => {
        if (context.isStale()) return { status: "cancelled" as const };
        if (scopeNow().accountId !== scope.accountId) {
          return {
            status: "account-changed" as const,
            accountId: scopeNow().accountId,
          };
        }
        return value;
      },
      (error) => ({
        status: "transient-failure" as const,
        error: asErrorMessage(error),
      }),
    );
  }

  function commitDestination(
    outcome: Extract<
      NavigationResolveOutcome,
      { status: "ready" | "unavailable" }
    >,
    mode: NavigationMode,
    generation: number,
  ): boolean {
    if (generation !== currentGeneration) return false;
    const scope = scopeNow();
    const entry = createNavigationEntry(outcome.destination, scope);
    seedCurrentIfNeeded(entry);
    if (mode === "replace") history.replace(entry);
    else history.push(entry);
    lastCommit = history.current() ?? entry;
    lastAvailability =
      outcome.status === "unavailable" ? "unavailable" : "available";
    setPending(null);
    deps.apply({
      entry: lastCommit,
      availability: lastAvailability,
      reason:
        outcome.status === "unavailable" ? outcome.reason : undefined,
      mode,
    });
    return true;
  }

  function finishNavigate(
    resolved: NavigationResolveOutcome,
    mode: NavigationMode,
    generation: number,
  ): NavigationNavigateResult {
    if (generation !== currentGeneration) {
      return { status: "cancelled", generation, committed: false };
    }
    if (resolved.status === "cancelled") {
      return { ...resolved, generation, committed: false };
    }
    if (resolved.status === "account-changed") {
      currentGeneration += 1;
      history.clear();
      lastCommit = null;
      lastAvailability = null;
      setPending(null);
      return {
        ...resolved,
        generation: currentGeneration,
        committed: false,
      };
    }
    if (
      resolved.status === "transient-failure" ||
      resolved.status === "rejected"
    ) {
      if (pending?.generation === generation) setPending(null);
      if (resolved.status === "rejected") deps.onRejected?.(resolved.reason);
      return { ...resolved, generation, committed: false };
    }
    const committed = commitDestination(resolved, mode, generation);
    return { ...resolved, generation, committed };
  }

  function navigate(
    destination: NavigationDestination,
    mode: NavigationMode = "push",
  ): NavigationNavigateResult | Promise<NavigationNavigateResult> {
    const generation = ++currentGeneration;
    const canonical = canonicalizeDestination(destination);
    setPending({ generation, destination: canonical });
    const resolved = resolveDestination(canonical, generation);
    if (isThenable(resolved)) {
      return resolved.then((value) => finishNavigate(value, mode, generation));
    }
    return finishNavigate(resolved, mode, generation);
  }

  function traverse(
    direction: "back" | "forward",
  ): NavigationNavigateResult | Promise<NavigationNavigateResult> {
    const snap = history.snapshot();
    const targetIndex =
      direction === "back" ? snap.index - 1 : snap.index + 1;
    if (targetIndex < 0 || targetIndex >= snap.entries.length) {
      return {
        status: "rejected",
        reason: direction === "back" ? "no back" : "no forward",
        generation: currentGeneration,
        committed: false,
      };
    }
    const target = snap.entries[targetIndex]!;
    const generation = ++currentGeneration;
    setPending({ generation, destination: target.destination });
    const run = (resolved: NavigationResolveOutcome): NavigationNavigateResult => {
      if (generation !== currentGeneration) {
        return { status: "cancelled", generation, committed: false };
      }
      if (
        resolved.status === "transient-failure" ||
        resolved.status === "rejected" ||
        resolved.status === "cancelled"
      ) {
        if (pending?.generation === generation) setPending(null);
        if (resolved.status === "rejected") deps.onRejected?.(resolved.reason);
        return { ...resolved, generation, committed: false };
      }
      if (resolved.status === "account-changed") {
        return finishNavigate(resolved, "replace", generation);
      }
      if (direction === "back") history.back();
      else history.forward();
      lastCommit = history.current();
      lastAvailability =
        resolved.status === "unavailable" ? "unavailable" : "available";
      setPending(null);
      if (lastCommit) {
        deps.apply({
          entry: lastCommit,
          availability: lastAvailability,
          reason:
            resolved.status === "unavailable" ? resolved.reason : undefined,
          mode: "replace",
        });
      }
      return { ...resolved, generation, committed: true };
    };
    const resolved = resolveDestination(target.destination, generation);
    if (isThenable(resolved)) return resolved.then(run);
    return run(resolved);
  }

  function noteAccount(accountId: string): void {
    const next = accountId.trim();
    if (lastAccountId && lastAccountId !== next) {
      currentGeneration += 1;
      history.clear();
      lastCommit = null;
      lastAvailability = null;
      setPending(null);
    }
    lastAccountId = next || null;
  }

  return {
    history,
    generation: () => currentGeneration,
    pending: () => pending,
    lastCommitted: () => lastCommit,
    lastAvailability: () => lastAvailability,
    navigate,
    resolveDestination,
    commitDestination,
    back: () => traverse("back"),
    forward: () => traverse("forward"),
    noteAccount,
  };
}
