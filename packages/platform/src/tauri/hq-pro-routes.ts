/**
 * hq-pro routes the desktop sync adapter calls through `hqProJson`, as
 * `"METHOD /path"` byte-for-byte matching the `routeKey` hq-pro registers in
 * `infra/*.ts`.
 *
 * The sync adapter builds the request from these entries (`splitRoute`), so
 * the call site and this table cannot drift apart. `scripts/route-contract-check.mjs`
 * reads this file (regex over `name: "METHOD /path",`) and fails CI when an
 * entry has no hq-pro registration. Keep entries as plain string literals.
 *
 * Only a few calls live here so far (DEV-5255 added the first). Moving the
 * other `hqProJson` calls here is follow-up work.
 */
export const SYNC_HQ_PRO_ROUTES = {
  membershipInvite: "POST /membership/invite",
} as const;

export type SyncHqProRoute = (typeof SYNC_HQ_PRO_ROUTES)[keyof typeof SYNC_HQ_PRO_ROUTES];

/** `"POST /membership/invite"` -> `["POST", "/membership/invite"]`. */
export function splitRoute<M extends string>(route: `${M} /${string}`): [M, string] {
  const space = route.indexOf(" ");
  return [route.slice(0, space) as M, route.slice(space + 1)];
}
