import { describe, expect, it, vi } from "vitest";

import { outpostJobsDestination, OUTPOST_JOBS_ROUTE } from "../company-outpost/company-outpost-model.js";
import { createNavigationController, type NavigationResolver } from "./navigation-controller.js";
import { openWhenResolvable } from "./open-when-resolvable.js";

// Mirrors the shell resolver: an extra page resolves only when the app
// registers it, and anything else is rejected as an unknown destination.
function shellLikeResolver(registered: ReadonlySet<string>): NavigationResolver {
  return (destination) => {
    if (destination.kind === "extra" && !registered.has(destination.page)) {
      return { status: "rejected", reason: `Unknown destination: ${destination.page}` };
    }
    return { status: "ready", destination };
  };
}

function controller(registered: ReadonlySet<string>) {
  const apply = vi.fn();
  const onRejected = vi.fn();
  const navigation = createNavigationController({
    getScope: () => ({ accountId: "acct_1", companyUid: "cmp_1" }),
    resolve: shellLikeResolver(registered),
    apply,
    onRejected,
  });
  const open = (destination: Parameters<typeof navigation.navigate>[0]) =>
    openWhenResolvable(destination, {
      resolve: (next) => navigation.resolveDestination(next),
      navigate: (next) => navigation.navigate(next),
    });
  return { navigation, apply, onRejected, open };
}

describe("openWhenResolvable", () => {
  it("navigates a job link once the outpost-jobs page is registered", async () => {
    const { navigation, apply, onRejected, open } = controller(new Set([OUTPOST_JOBS_ROUTE]));
    const destination = outpostJobsDestination("cmp_1", "demo-4");
    expect(await open(destination)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(navigation.lastCommitted()?.destination).toMatchObject({ kind: "extra", page: OUTPOST_JOBS_ROUTE });
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("returns false without a navigation error while the page is not registered", async () => {
    const { navigation, apply, onRejected, open } = controller(new Set());
    expect(await open(outpostJobsDestination("cmp_1", "demo-4"))).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
    expect(navigation.lastCommitted()).toBeNull();
  });
});
