import { describe, expect, it } from "vitest";

import {
  ALLOWLISTED_DEAD_ROUTES,
  checkRoutes,
  collectAppRoutes,
  extractRegistryRoutes,
  extractRustRegistryRoutes,
  extractWebPathsCompanyRoutes,
  loadRegistry,
  normalizeRoute,
} from "./route-contract-check.mjs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("normalizeRoute", () => {
  it("collapses every placeholder spelling to {param}", () => {
    expect(normalizeRoute('POST /companies/{companyUid}/home-channel')).toBe(
      "POST /companies/{param}/home-channel",
    );
    expect(normalizeRoute("GET /v1/keys/files/{}")).toBe("GET /v1/keys/files/{param}");
    expect(normalizeRoute("DELETE /secrets/{companyUid}/name/{proxy+}")).toBe(
      "DELETE /secrets/{param}/name/{param}",
    );
  });
});

describe("the exact v0.10.327 miss", () => {
  it("fails: app calls POST /companies/{uid}/home-channel, registry only has /v1", () => {
    // This is exactly what crates/hq-desktop-core/src/desktop_alt.rs built
    // before it was wired to the routes.rs registry: no /v1 prefix.
    const appRoutes = [
      { name: "home_channel_url (pre-fix)", route: normalizeRoute("POST /companies/{uid}/home-channel") },
    ];
    const registryRoutes = new Set([
      normalizeRoute("POST /v1/companies/{companyUid}/home-channel"),
    ]);

    const result = checkRoutes(appRoutes, registryRoutes);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      { name: "home_channel_url (pre-fix)", route: "POST /companies/{param}/home-channel" },
    ]);
  });

  it("passes once the app route carries the registered /v1 prefix", () => {
    const appRoutes = [
      { name: "home_channel_url (fixed)", route: normalizeRoute("POST /v1/companies/{uid}/home-channel") },
    ];
    const registryRoutes = new Set([
      normalizeRoute("POST /v1/companies/{companyUid}/home-channel"),
    ]);

    expect(checkRoutes(appRoutes, registryRoutes).ok).toBe(true);
  });
});

describe("checkRoutes", () => {
  it("only skips routes explicitly in ALLOWLISTED_DEAD_ROUTES", () => {
    const registryRoutes = new Set<string>();
    const appRoutes = [
      { name: "known-dead", route: normalizeRoute(ALLOWLISTED_DEAD_ROUTES[0]) },
      { name: "unknown-dead", route: normalizeRoute("GET /v1/not/a/real/route") },
    ];

    const result = checkRoutes(appRoutes, registryRoutes);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.name)).toEqual(["unknown-dead"]);
  });
});

describe("extractRegistryRoutes", () => {
  it("extracts inline routeKey literals", () => {
    const src = `
      const route = {
        routeKey: "POST /v1/companies/{companyUid}/home-channel",
        handler: "x",
      };
    `;
    expect(extractRegistryRoutes(src)).toEqual(
      new Set(["POST /v1/companies/{param}/home-channel"]),
    );
  });

  it("extracts { key, name } array-entry literals", () => {
    const src = `
      const boardRoutes = [
        { key: "GET /companies/{companyUid}/board", name: "CompanyBoard" },
        { key: "PUT /companies/{companyUid}/board", name: "CompanyBoardWrite" },
      ];
      for (const route of boardRoutes) {
        api.route({ routeKey: route.key });
      }
    `;
    expect(extractRegistryRoutes(src)).toEqual(
      new Set([
        "GET /companies/{param}/board",
        "PUT /companies/{param}/board",
      ]),
    );
  });

  it("does not fabricate a route out of a runtime-only routeKey", () => {
    const src = `routeKey: route.key,`;
    expect(extractRegistryRoutes(src).size).toBe(0);
  });
});

describe("extractRustRegistryRoutes", () => {
  it("extracts pub const NAME: &str = \"METHOD /path\"; entries", () => {
    const src = `
      pub const BOARD: &str = "GET /companies/{companyUid}/board";
      pub const HOME_CHANNEL: &str = "POST /v1/companies/{companyUid}/home-channel";
    `;
    expect(extractRustRegistryRoutes(src)).toEqual([
      { name: "routes::BOARD", route: "GET /companies/{param}/board" },
      { name: "routes::HOME_CHANNEL", route: "POST /v1/companies/{param}/home-channel" },
    ]);
  });
});

describe("extractWebPathsCompanyRoutes", () => {
  it("pairs a WEB_PATHS.company* definition with its call-site verb", () => {
    const src = `
      export const WEB_PATHS = {
        companyBoard: (slug: string) => \`/companies/\${encodeURIComponent(slug)}/board\`,
      };
      class X {
        getBoard = (slug) => this.get(WEB_PATHS.companyBoard(slug));
      }
    `;
    expect(extractWebPathsCompanyRoutes(src)).toEqual([
      { name: "WEB_PATHS.companyBoard", route: "GET /companies/{param}/board" },
    ]);
  });

  it("does not pair a definition with no matching call site", () => {
    const src = `
      export const WEB_PATHS = {
        companySecrets: (slug: string) => \`/v1/companies/\${encodeURIComponent(slug)}/secrets\`,
      };
    `;
    expect(extractWebPathsCompanyRoutes(src)).toEqual([]);
  });
});

describe("loadRegistry", () => {
  it("throws when a registry source file is missing", () => {
    expect(() => loadRegistry(["/nonexistent/infra/vault-service.ts"])).toThrow(
      /registry source not found/,
    );
  });
});

describe("collectAppRoutes against a fixture repo layout", () => {
  it("reads routes.rs and web/index.ts from an app root", () => {
    const root = mkdtempSync(join(tmpdir(), "route-contract-fixture-"));
    mkdirSync(join(root, "crates/hq-desktop-core/src"), { recursive: true });
    mkdirSync(join(root, "packages/platform/src/web"), { recursive: true });
    writeFileSync(
      join(root, "crates/hq-desktop-core/src/routes.rs"),
      'pub const HOME_CHANNEL: &str = "POST /v1/companies/{companyUid}/home-channel";',
    );
    writeFileSync(
      join(root, "packages/platform/src/web/index.ts"),
      [
        "export const WEB_PATHS = {",
        "  companyBoard: (slug: string) => `/companies/${encodeURIComponent(slug)}/board`,",
        "};",
        "class X { getBoard = (slug) => this.get(WEB_PATHS.companyBoard(slug)); }",
      ].join("\n"),
    );

    const routes = collectAppRoutes(root);

    expect(routes).toEqual([
      { name: "routes::HOME_CHANNEL", route: "POST /v1/companies/{param}/home-channel" },
      { name: "WEB_PATHS.companyBoard", route: "GET /companies/{param}/board" },
    ]);
  });
});
