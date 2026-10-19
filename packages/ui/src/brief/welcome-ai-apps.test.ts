/**
 * Which company the welcome report connects apps in: the tenant, else the
 * most recent company, else the only company, else the first in the roster.
 * Only no companies at all leaves it empty, so the new-company step shows.
 */
import { describe, expect, it } from "vitest";

import { welcomeAppsCompanyFor } from "./welcome-ai-apps.js";

const ACME = { uid: "cmp_acme", name: "Acme" };
const BETA = { uid: "cmp_beta", name: "Beta" };
const GAMMA = { uid: "cmp_gamma", name: "Gamma" };

describe("welcomeAppsCompanyFor", () => {
  it("picks the tenant company first", () => {
    expect(welcomeAppsCompanyFor([ACME, BETA, GAMMA], "cmp_gamma", ["cmp_beta"])).toBe(GAMMA);
  });

  it("picks the most recent company when there is no tenant", () => {
    expect(welcomeAppsCompanyFor([ACME, BETA, GAMMA], null, ["cmp_beta", "cmp_gamma"])).toBe(BETA);
  });

  it("skips a recent id that is no longer in the roster", () => {
    expect(welcomeAppsCompanyFor([ACME, BETA], null, ["cmp_gone", "cmp_beta"])).toBe(BETA);
  });

  it("falls back from a tenant id that is not in the roster", () => {
    expect(welcomeAppsCompanyFor([ACME, BETA], "cmp_gone", ["cmp_beta"])).toBe(BETA);
  });

  it("picks the only company", () => {
    expect(welcomeAppsCompanyFor([ACME], null, [])).toBe(ACME);
  });

  it("picks the first roster company when there is no tenant or recent company", () => {
    expect(welcomeAppsCompanyFor([BETA, ACME], null, [])).toBe(BETA);
  });

  it("is empty only when there are no companies", () => {
    expect(welcomeAppsCompanyFor([], "cmp_acme", ["cmp_acme"])).toBeNull();
  });
});
