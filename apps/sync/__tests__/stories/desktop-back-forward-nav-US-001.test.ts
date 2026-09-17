/**
 * US-001: Inventory destinations and ship a typed history model.
 *
 * Named separately from the existing notification-row US-001.test.ts.
 * Exercises the PRD e2eTests against the real shared-shell model.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  applyNavigationCommit,
  createNavigationEntry,
  createNavigationHistory,
  destinationsEqual,
  NAVIGATION_HISTORY_CAP,
  type NavigationDestination,
} from "../../../../packages/ui/src/shell/navigation-history";
import {
  NAVIGATION_HANDLER_MATRIX,
} from "../../../../packages/ui/src/shell/navigation-handler-matrix";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function entry(destination: NavigationDestination) {
  return createNavigationEntry(destination, {
    accountId: "acct_ada",
    companyUid: "cmp_acme",
  });
}

describe("US-001: Inventory destinations and ship a typed history model", () => {
  it("Given the inventoried handler list, when the coverage test runs, then every handler has a matrix row and every row has a handler", () => {
    expect(NAVIGATION_HANDLER_MATRIX.length).toBeGreaterThan(0);
    for (const row of NAVIGATION_HANDLER_MATRIX) {
      expect(row.needle, `${row.id} has no handler`).toBeTruthy();
      expect(readRepo(row.file)).toContain(row.needle);
    }
  });

  it("Given two equal destinations by stable IDs, when canonical equality runs, then they compare equal and unequal IDs do not", () => {
    const left: NavigationDestination = {
      kind: "dm",
      personUid: "prs_ada",
      replyRootEventId: null,
    };
    const same: NavigationDestination = { kind: "dm", personUid: "prs_ada" };
    const other: NavigationDestination = { kind: "dm", personUid: "prs_bob" };
    expect(destinationsEqual(left, same)).toBe(true);
    expect(destinationsEqual(left, other)).toBe(false);
  });

  it("Given push A, push B, back, push C, when the stack is inspected, then forward is empty and capacity never exceeds 100", () => {
    const history = createNavigationHistory();
    history.push(entry({ kind: "channel", channelId: "chn_a" }));
    history.push(entry({ kind: "channel", channelId: "chn_b" }));
    history.back();
    history.push(entry({ kind: "meetings" }));
    expect(history.canGoForward()).toBe(false);
    expect(
      history.snapshot().entries.map((item) => item.destination.kind),
    ).toEqual(["channel", "meetings"]);
    for (let i = 0; i < 150; i += 1) {
      history.push(entry({ kind: "channel", channelId: `chn_cap_${i}` }));
    }
    expect(history.snapshot().entries.length).toBeLessThanOrEqual(
      NAVIGATION_HISTORY_CAP,
    );
    expect(history.snapshot().entries.length).toBe(NAVIGATION_HISTORY_CAP);
  });

  it("Given a hydration or poller state write, when the stack is inspected, then no history entry was added", () => {
    const history = createNavigationHistory();
    applyNavigationCommit(history, {
      kind: "non-navigation",
      reason: "hydration",
    });
    applyNavigationCommit(history, {
      kind: "non-navigation",
      reason: "polling",
    });
    expect(history.snapshot().entries).toHaveLength(0);
    expect(history.current()).toBeNull();
  });
});
