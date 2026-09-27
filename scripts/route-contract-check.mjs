#!/usr/bin/env node

/**
 * Route contract check — fails the build when the desktop app calls a
 * server route that hq-pro (or hq-pro-agents) does not register.
 *
 * v0.10.327 shipped `home_channel_url` missing the `/v1` prefix
 * (`crates/hq-desktop-core/src/desktop_alt.rs`): the URL it built,
 * `POST /companies/{uid}/home-channel`, does not exist in hq-pro's API
 * Gateway — only `POST /v1/companies/{uid}/home-channel` does — so every
 * call 404'd. Nothing in CI caught it because nothing compared the app's
 * URL builders against the server's route registry.
 *
 * This script does that comparison directly:
 *
 *   1. Parse the SERVER registry — hq-pro's `infra/*.ts` (144 unique
 *      `routeKey: "METHOD /path"` registrations, either inline or via a
 *      `{ key: "...", name: "..." }` table an adjacent `for (const route of
 *      ...)` loop feeds into `routeKey: route.key`) and hq-pro-agents'
 *      `infra/notify-dm-routes.ts` (the notify/channel routes).
 *   2. Parse the APP routes:
 *        - EXACT: `crates/hq-desktop-core/src/routes.rs` — the desktop_alt
 *          vault-call registry the Rust URL builders import their paths
 *          from (`path_for(ROUTES::X, ...)`). Every entry here is checked.
 *        - EXACT: the `WEB_PATHS.company*` family in
 *          `packages/platform/src/web/index.ts` paired with the HTTP verb
 *          each is called with in the adjacent `WebPlatformAdapter` methods
 *          — the browser/PWA path for the same company-scoped routes the
 *          Rust registry covers, and where the same /v1 bug class was found
 *          live in `companyBoard`/`companyActivity` while building this
 *          check.
 *      Everything else the app calls (100+ notify/agent/work-mesh routes
 *      across `packages/platform`) is NOT yet migrated to an exact
 *      registry. Migrating it is future work; regex-extracting all of it
 *      here would produce a check that is only as trustworthy as the
 *      regex, for a surface an order of magnitude bigger than the bug this
 *      check exists to catch. ALLOWLISTED_DEAD_ROUTES below documents the
 *      one route in the exact set that intentionally has no server match
 *      (hq-pro has no handler for it) so removing or fixing it is a
 *      deliberate, visible decision — not a check silently going quiet.
 *
 *   3. Normalize placeholders (`{uid}`, `{}`, `{companyUid}`, `{slug}`, ...)
 *      to `{param}` on both sides and require METHOD + path to match.
 *
 * Usage:
 *   node scripts/route-contract-check.mjs \
 *     --app-root . \
 *     --hq-pro path/to/hq-pro \
 *     --hq-pro-agents path/to/hq-pro-agents
 *
 * Exits 1 and prints every unmatched app route on failure.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** hq-pro has no handler for this route — see WEB_PATHS.companySummary's
 * doc comment in packages/platform/src/web/index.ts. Documented here so a
 * newly-added, genuinely-broken route can't hide behind it: this is the
 * only entry the check is allowed to skip, and it must shrink to zero. */
export const ALLOWLISTED_DEAD_ROUTES = [
  "GET /v1/companies/{param}/summary",
  "GET /v1/companies/{param}/deployments",
  "GET /v1/companies/{param}/telemetry",
  "POST /v1/companies/{param}/claim-invite",
  "POST /v1/companies/{param}/connect",
];

/** Turns any of hq-pro's placeholder spellings into one canonical form so
 * `{companyUid}`, `{uid}`, `{slug}`, `{}`, and `{proxy+}` all compare equal. */
export function normalizeRoute(route) {
  return route
    .trim()
    .replace(/\{[^}]*\}/g, "{param}")
    .replace(/\s+/g, " ");
}

/** Parses hq-pro/hq-pro-agents `infra/*.ts` registrations into normalized
 * `"METHOD /path"` route keys. Handles both the inline
 * `routeKey: "METHOD /path"` form and the `{ key: "METHOD /path", name }`
 * array-entry form that a nearby `for (const route of ...)` loop turns into
 * `routeKey: route.key` — string literals only; a route key built from a
 * runtime value (a template with an interpolated variable, or a value read
 * off another object) is invisible to this script by construction and is
 * not silently treated as covered. */
export function extractRegistryRoutes(sourceText) {
  const routes = new Set();
  const literalRouteKey = /routeKey:\s*"([A-Z]+\s+\/[^"]*)"/g;
  const literalKeyEntry = /\bkey:\s*"([A-Z]+\s+\/[^"]*)"/g;
  for (const re of [literalRouteKey, literalKeyEntry]) {
    for (const match of sourceText.matchAll(re)) {
      routes.add(normalizeRoute(match[1]));
    }
  }
  return routes;
}

export function loadRegistry(files) {
  const routes = new Set();
  for (const file of files) {
    if (!existsSync(file)) {
      throw new Error(`registry source not found: ${file}`);
    }
    const text = readFileSync(file, "utf8");
    for (const route of extractRegistryRoutes(text)) routes.add(route);
  }
  return routes;
}

/** Parses `crates/hq-desktop-core/src/routes.rs` — `pub const NAME: &str =
 * "METHOD /path";` entries, exactly what the Rust URL builders format
 * their request URL from (see `path_for`). */
export function extractRustRegistryRoutes(sourceText) {
  const routes = [];
  const re = /pub const (\w+): &str = "([A-Z]+\s+\/[^"]*)";/g;
  for (const match of sourceText.matchAll(re)) {
    routes.push({ name: `routes::${match[1]}`, route: normalizeRoute(match[2]) });
  }
  return routes;
}

/** Parses the `WEB_PATHS.company*` family out of
 * `packages/platform/src/web/index.ts` and pairs each with the HTTP verb
 * its `WebPlatformAdapter` call site uses (`this.get(...)` -> GET,
 * `this.post(...)` -> POST, ...). Both halves are read from the same file
 * so a rename on either side breaks extraction loudly instead of silently
 * matching the wrong thing. */
export function extractWebPathsCompanyRoutes(sourceText) {
  const pathDefs = new Map();
  const defRe =
    /(\w+):\s*\(([^)]*)\)\s*=>\s*`([^`]*)`/g;
  for (const match of sourceText.matchAll(defRe)) {
    const [, name, , template] = match;
    if (!name.startsWith("company")) continue;
    const path = template.replace(/\$\{[^}]*\}/g, "{param}");
    pathDefs.set(name, path);
  }

  const verbByMethod = { get: "GET", post: "POST", put: "PUT", del: "DELETE", patch: "PATCH" };
  const callRe = /this\.(get|post|put|del|patch)\(WEB_PATHS\.(\w+)\(/g;
  const routes = [];
  for (const match of sourceText.matchAll(callRe)) {
    const [, verb, name] = match;
    if (!pathDefs.has(name)) continue;
    routes.push({
      name: `WEB_PATHS.${name}`,
      route: normalizeRoute(`${verbByMethod[verb]} ${pathDefs.get(name)}`),
    });
  }
  return routes;
}

export function collectAppRoutes(appRoot) {
  const routesRs = readFileSync(
    join(appRoot, "crates/hq-desktop-core/src/routes.rs"),
    "utf8",
  );
  const webIndexTs = readFileSync(
    join(appRoot, "packages/platform/src/web/index.ts"),
    "utf8",
  );
  return [
    ...extractRustRegistryRoutes(routesRs),
    ...extractWebPathsCompanyRoutes(webIndexTs),
  ];
}

/** Core check: every app route must be in the registry, unless explicitly
 * allowlisted as a known-dead route. Returns `{ ok, failures }`. */
export function checkRoutes(appRoutes, registryRoutes) {
  const allowlisted = new Set(ALLOWLISTED_DEAD_ROUTES.map(normalizeRoute));
  const failures = [];
  for (const { name, route } of appRoutes) {
    if (registryRoutes.has(route)) continue;
    if (allowlisted.has(route)) continue;
    failures.push({ name, route });
  }
  return { ok: failures.length === 0, failures };
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx === -1 ? fallback : args[idx + 1];
  };

  const appRoot = getArg("--app-root", ".");
  const hqProRoot = getArg("--hq-pro");
  const hqProAgentsRoot = getArg("--hq-pro-agents");

  if (!hqProRoot || !hqProAgentsRoot) {
    console.error(
      "usage: route-contract-check.mjs --hq-pro <path> --hq-pro-agents <path> [--app-root <path>]",
    );
    process.exit(2);
  }

  const registryFiles = [
    ...["api-keys-routes.ts", "desktop-onboarding.ts", "notify-routes.ts", "vault-service.ts"].map(
      (f) => join(hqProRoot, "infra", f),
    ),
    join(hqProAgentsRoot, "infra", "notify-dm-routes.ts"),
  ].filter((f) => existsSync(f));

  const registryRoutes = loadRegistry(registryFiles);
  const appRoutes = collectAppRoutes(appRoot);
  const { ok, failures } = checkRoutes(appRoutes, registryRoutes);

  console.log(
    `route-contract-check: ${appRoutes.length} app route(s) checked against ${registryRoutes.size} registered route(s) from ${registryFiles.length} file(s)`,
  );

  if (!ok) {
    console.error(`\nroute-contract-check FAILED — ${failures.length} route(s) have no matching hq-pro registration:\n`);
    for (const { name, route } of failures) {
      console.error(`  ${name}: ${route}`);
    }
    console.error(
      "\nEither the route is genuinely wrong (fix the URL builder), or hq-pro registers it under a\ndifferent method/path (fix this script's extraction), or it is dead code (add it to\nALLOWLISTED_DEAD_ROUTES in scripts/route-contract-check.mjs with a reason).",
    );
    process.exitCode = 1;
    return;
  }

  console.log("route-contract-check PASSED");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
