/**
 * US-008 rendered-contract tests.
 *
 * The dropped-companies acceptance test in us-008.test.ts proves the
 * CompanyBoardScope DATA; these tests prove the rendered contract — the
 * actual DOM the board page ships: the `dropped-companies-banner` testid
 * (DroppedCompaniesBanner) appears exactly when a scope is realtimeDropped,
 * and names the dropped companies.
 *
 * Uses Svelte 5 server-side render (svelte/server) through the
 * @sveltejs/vite-plugin-svelte compile step in vitest.config.ts — a minimal
 * render harness (no jsdom, no client runtime) consistent with the repo's
 * plain-node vitest convention. The `company-realtime-degraded` section chip
 * lives in routes/(app)/board/+page.svelte markup, which needs the full
 * SvelteKit runtime to render; its data driver (scope.realtimeDropped) is
 * covered here and in the scope tests.
 */

import { describe, expect, it } from "vitest";
import { render } from "svelte/server";

import DroppedCompaniesBanner from "../../../../packages/ui/src/board/DroppedCompaniesBanner.svelte";
import { buildCompanyScopes } from "../../../../packages/ui/src/board/company-scopes";

describe("US-008 rendered contract: dropped-companies banner", () => {
  const workspaces = [
    { companyUid: "cmp_acme", displayName: "Acme" },
    { companyUid: "cmp_big", displayName: "Big Co" },
  ];

  it("renders the dropped-companies-banner testid naming the dropped company", () => {
    const scopes = buildCompanyScopes(workspaces, ["cmp_big"]);
    const { body } = render(DroppedCompaniesBanner, { props: { scopes } });
    expect(body).toContain('data-testid="dropped-companies-banner"');
    expect(body).toContain("Big Co");
    expect(body).toContain('role="status"');
  });

  it("renders no banner when no company was dropped", () => {
    const scopes = buildCompanyScopes(workspaces, []);
    const { body } = render(DroppedCompaniesBanner, { props: { scopes } });
    expect(body).not.toContain("dropped-companies-banner");
  });
});
