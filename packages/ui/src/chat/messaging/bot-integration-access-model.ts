/**
 * Per-bot integration control: the pure model.
 *
 * One function that gives a bot's state on one of the company's connections.
 * Everything is a function of its arguments: no Svelte, no requests, no clocks.
 *
 * See `companies/indigo/projects/desktop-new-bot-flow/per-bot-integrations-plan.md`
 * for the five states and the server contract. Live decision for the switch:
 * `dec-20261012191758-lvn1` (Option A, behind an off-by-default flag).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The five states a bot can be in on one of the company's connections. */
export type BotConnectionAccessState =
  | "on"
  | "on-everyone"
  | "on-admin"
  | "off"
  | "read-only";

/** One entry on a connection's ACL, as read from the server. */
export interface ConnectionAccessEntry {
  /** "person" | "company-wide" | "role" (and future types). */
  granteeType: string;
  /** The person uid, role name, or "" for company-wide. */
  granteeId: string;
  /** "read" | "write" | "" (and future values). */
  permission: string;
}

/**
 * `GET /v1/integrations/factory/access?companyUid=&connectionId=`, after parse.
 *
 * `canManage` here is the per-connection answer: the caller is the connection's
 * creator or a company owner/admin, and may change sharing on this connection.
 * This is NOT the viewer-wide `canManageIntegrations` on the connections list.
 */
export interface ConnectionAccess {
  /** "legacy-open" | "everyone" | "private" | "shared", or "" when unknown. */
  mode: string;
  /** The caller may change sharing on this connection. */
  canManage: boolean;
  /** The connection's explicit ACL entries, in server order. */
  entries: ConnectionAccessEntry[];
}

/**
 * Read the per-connection access envelope. Null for anything that is not an
 * envelope. Every field may be missing; `entries` is coerced to an array at
 * the parse boundary (per the `indigo-coerce-api-array-fields-at-parse-boundary`
 * rule) and non-record items are skipped. Entry fields are coerced to strings.
 */
export function readConnectionAccess(json: unknown): ConnectionAccess | null {
  if (!isRecord(json)) return null;
  const accessRaw = isRecord(json.access) ? json.access : null;
  const mode = accessRaw ? text(accessRaw.mode) : "";
  const canManage = json.canManage === true;
  const entries: ConnectionAccessEntry[] = [];
  for (const raw of Array.isArray(json.entries) ? json.entries : []) {
    if (!isRecord(raw)) continue;
    const granteeType = text(raw.granteeType);
    if (!granteeType) continue;
    entries.push({
      granteeType,
      granteeId: text(raw.granteeId),
      permission: text(raw.permission),
    });
  }
  return { mode, canManage, entries };
}

/** The arguments {@link botConnectionAccessState} answers for. */
export interface BotConnectionAccessInput {
  /** The bot's person uid (e.g., `agent_abc`). */
  botUid: string;
  /**
   * The bot's role on the company, lower case: an owner or admin bypasses
   * per-connection sharing (`on-admin`). "", "member", or any other value does
   * not. The caller supplies "" when the bot is not a company member.
   */
  botRole: string;
  /** The connection, read via {@link readCompanyConnections}. */
  mode: string;
  /** Per-connection access read, from {@link readConnectionAccess}. */
  access: ConnectionAccess;
}

/**
 * The bot's state on one connection, in precedence order:
 *
 * 1. `read-only`: the caller cannot manage this connection. The switch shows
 *    but does not act; the help text asks an admin or the connection's creator.
 *    This masks everything underneath, because the caller cannot flip the
 *    switch anyway.
 * 2. `on-admin`: the bot is a company owner or admin. The connection is open
 *    to that role implicitly, so the switch is on and locked with a reason.
 * 3. `on-everyone`: the connection is open to the whole company (`everyone`,
 *    or `legacy-open` for connections created before per-connection sharing).
 *    The switch is on and locked; the text links to company sharing.
 * 4. `on`: the ACL has an explicit `{ granteeType: "person", granteeId: botUid }`
 *    entry. The switch is on and can be flipped off.
 * 5. `off`: no explicit entry, not open to everyone, and the bot has no role
 *    bypass. The switch is off and can be flipped on.
 *
 * The caller resolves `access` from `GET /v1/integrations/factory/access`.
 * `mode` is read off the company's connections list (`access.mode` per
 * `readCompanyConnections`); it is passed in rather than off `access.mode`
 * because the list is the source of truth for the connection's sharing mode
 * (the two are kept in sync server-side).
 */
export function botConnectionAccessState(
  input: BotConnectionAccessInput,
): BotConnectionAccessState {
  if (!input.access.canManage) return "read-only";
  const role = input.botRole.toLowerCase();
  if (role === "owner" || role === "admin") return "on-admin";
  if (input.mode === "everyone" || input.mode === "legacy-open") {
    return "on-everyone";
  }
  const hasExplicit = input.access.entries.some(
    (e) => e.granteeType === "person" && e.granteeId === input.botUid,
  );
  return hasExplicit ? "on" : "off";
}

/**
 * Whether the switch is interactive (the caller can flip it from this device).
 * `on` and `off` are the only interactive states; the other three are locked.
 */
export function botConnectionIsInteractive(state: BotConnectionAccessState): boolean {
  return state === "on" || state === "off";
}

/**
 * Whether the switch reads as on (shown as on, regardless of whether the user
 * can flip it from here).
 */
export function botConnectionIsOn(state: BotConnectionAccessState): boolean {
  return state === "on" || state === "on-everyone" || state === "on-admin";
}
