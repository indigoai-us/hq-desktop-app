/**
 * Pure model for the unified create flow (the "+" modal).
 *
 * One search-first modal replaces the old plus-menu + two modals. What the user
 * types infers the lane: an existing person/agent opens a DM, an existing
 * channel opens it, an unmatched name creates a channel (which IS the project
 * shell — there is no separate "project" concept here).
 *
 * No Svelte / DOM / Tauri imports live in this file: everything here is a plain
 * function over data so the rules (slugify, collision, lane classification,
 * picker candidates, failure parsing, invite copy) are unit-testable and shared
 * between `CreateModal.svelte` and any future host.
 */

import { agentFallbackLabel, mentionTypeForUid } from "./mentions.js";
import { isSetupChannel } from "./setup-channel.js";
import type {
  ConversationRow,
  DmContactInput,
  ScopeCompany,
} from "./sidebar-model.js";

// ── Slug rules ───────────────────────────────────────────────────────────────

/**
 * Canonical channel slug. Byte-identical to hq-pro
 * `src/vault-service/lib/channels.ts` — any divergence would make the live
 * preview lie about the name the server actually reserves.
 *
 * Non-ASCII is a separator on purpose (`Café Q4!!` → `caf-q4`): the server does
 * no unicode folding, so neither do we.
 */
export function channelSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Slug normalization for LIVE typing. Same pipeline as `channelSlug` but a
 * single trailing `-` survives, so typing `q4-` then `board` isn't fought by
 * the field. `channelSlug` is still applied on blur and before submit.
 */
export function slugInputValue(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "");
}

/**
 * First `base`, `base-2`, `base-3`, … `base-99` not in `taken`.
 *
 * Only ever used to populate the "Use <slug>" button — auto-suffixing behind
 * the user's back is forbidden.
 */
export function suggestFreeSlug(
  base: string,
  taken: ReadonlySet<string>,
): string {
  if (!base) return "";
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-99`;
}

// ── Collision detection ──────────────────────────────────────────────────────

/**
 * A channel we know about locally. Callers pass ONLY channel-kind rows — this
 * module cannot tell a DM row from a channel row, and a DM titled like a
 * channel must never register as a collision.
 */
export interface KnownChannel {
  channelId: string;
  /** `ConversationRow.title` — the HUMANIZED display name, not the server slug. */
  title: string;
  companyUid: string | null;
  channelScope?: string;
  /** Reliable handle for auto-provisioned project channels (see `checkSlug`). */
  projectId?: string | null;
  /**
   * US-021 browse-only row: a company project channel the caller is NOT in.
   * It still OWNS the slug server-side, so it is a real collision — but the
   * copy must not claim membership the caller does not have.
   */
  browseOnly?: boolean;
  /** Caller's membership when the directory carried one (`joined` by default). */
  membership?: string | null;
}

/** Is the caller actually IN this channel (vs. merely able to see it)? */
function isJoined(row: KnownChannel): boolean {
  if (row.browseOnly === true) return false;
  const membership = row.membership?.trim();
  return !membership || membership === "joined";
}

export type SlugTarget = {
  scope: "personal" | "company";
  companyUid: string | null;
};

/**
 * Three verdicts, and the third is `unknown` — never "free"/"available".
 *
 * The client only holds the caller's OWN joined channels, so for company scope
 * we can find a collision but can never prove its absence. Saying "available"
 * would be a lie we cannot back.
 */
export type SlugVerdict =
  | { status: "empty" }
  | {
      status: "taken";
      source: "local" | "server";
      channelId: string | null;
      title: string | null;
      /**
       * True only when the caller is a MEMBER of the colliding channel. A
       * browse-only company project collides just as hard, but "you're already
       * in #x" would be a lie and "Open it" would dead-end.
       */
      joined: boolean;
    }
  | { status: "unknown" };

/** Server-side uniqueness key: `company#<uid>` or `person#<selfUid>`. */
export function channelScopeKey(
  target: SlugTarget,
  selfPersonUid: string | null,
): string {
  return target.scope === "company"
    ? `company#${target.companyUid ?? ""}`
    : `person#${selfPersonUid ?? "self"}`;
}

function inScope(
  target: SlugTarget,
  known: readonly KnownChannel[],
): KnownChannel[] {
  if (target.scope === "company") {
    return known.filter((row) => row.companyUid === target.companyUid);
  }
  return known.filter(
    (row) => row.companyUid == null && row.channelScope !== "company",
  );
}

/** Slugs already used by channels we can see inside `target`. */
export function knownSlugsInScope(
  target: SlugTarget,
  known: readonly KnownChannel[],
): Set<string> {
  const slugs = new Set<string>();
  for (const row of inScope(target, known)) {
    const fromTitle = channelSlug(row.title);
    if (fromTitle) slugs.add(fromTitle);
    const projectId = row.projectId?.trim();
    if (projectId) slugs.add(projectId);
  }
  return slugs;
}

/**
 * Local + learned-server collision check.
 *
 * A row matches when its humanized title slugifies to `slug` OR its `projectId`
 * equals it — `humanizeChannelName` strips a leading `Project ` and a trailing
 * hex hash, so an auto-provisioned project channel's display title does not
 * slugify back to the server's slug.
 *
 * `serverTaken` holds `${scopeKey}#${slug}` keys learned from 409 responses:
 * the only way this client ever hears about a channel it cannot see.
 */
export function checkSlug(
  slug: string,
  target: SlugTarget,
  known: readonly KnownChannel[],
  serverTaken: ReadonlySet<string>,
  selfPersonUid: string | null = null,
): SlugVerdict {
  if (!slug) return { status: "empty" };
  for (const row of inScope(target, known)) {
    if (channelSlug(row.title) === slug || row.projectId?.trim() === slug) {
      return {
        status: "taken",
        source: "local",
        channelId: row.channelId,
        title: row.title,
        joined: isJoined(row),
      };
    }
  }
  if (serverTaken.has(`${channelScopeKey(target, selfPersonUid)}#${slug}`)) {
    return {
      status: "taken",
      source: "server",
      channelId: null,
      title: null,
      joined: false,
    };
  }
  return { status: "unknown" };
}

// ── Query classification ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export type FindQueryKind = "empty" | "email" | "text";

/**
 * What the find-step input currently means. An email never yields a create
 * slug — a slug derived from an address is garbage.
 */
export function classifyFindQuery(query: string): {
  kind: FindQueryKind;
  slug: string;
  email: string | null;
} {
  const q = query.trim();
  if (!q) return { kind: "empty", slug: "", email: null };
  if (isValidEmail(q)) return { kind: "email", slug: "", email: q };
  return { kind: "text", slug: channelSlug(q), email: null };
}

// ── Find-step results ────────────────────────────────────────────────────────

export type FindRowKind = "channel" | "person" | "agent";

export interface FindRow {
  key: string;
  kind: FindRowKind;
  row: ConversationRow;
  label: string;
  sublabel: string;
  /** True when this row's slugified title is exactly the typed slug. */
  exact: boolean;
}

export interface FindResults {
  rows: FindRow[];
  /** Slug the create row would reserve, or null when create is not offered. */
  createSlug: string | null;
}

const EMPTY_QUERY_LIMIT = 8;
const GROUP_LIMIT = 5;
const RESULT_LIMIT = 16;

function isAgentUid(uid: string | null | undefined): boolean {
  return Boolean(uid) && mentionTypeForUid(uid as string) === "agent";
}

function findRowKind(row: ConversationRow): FindRowKind {
  if (row.kind === "dm") return isAgentUid(row.personUid) ? "agent" : "person";
  return "channel";
}

function findRowLabel(row: ConversationRow): string {
  const title = row.title?.trim();
  if (title) return title;
  if (row.kind === "dm" && isAgentUid(row.personUid)) {
    return agentFallbackLabel(row.personUid as string);
  }
  return row.email?.trim() || "Untitled";
}

/** Resolve a workspace label for a row's `companyUid` (`null` = personal). */
export type CompanyLabelResolver = (companyUid: string | null) => string;

const NO_COMPANY_LABEL: CompanyLabelResolver = () => "";

/**
 * Group DMs are titled by their roster join, so two groups with the same
 * people read identically. Show the roster (first 3, then +N) when it adds
 * information; fall back to the member count. Mirrors the sidebar switcher's
 * `groupSwitcherSecondary` so both surfaces disambiguate the same way.
 */
function groupRoster(row: ConversationRow): string {
  const names = (row.members ?? [])
    .map((member) => member.displayName?.trim())
    .filter((name): name is string => Boolean(name));
  if (names.length > 0) {
    const shown = names.slice(0, 3);
    const extra = names.length - shown.length;
    return extra > 0 ? `${shown.join(", ")} +${extra}` : shown.join(", ");
  }
  const count = row.memberCount ?? 0;
  return count > 0 ? `Group · ${count}` : "";
}

function findRowSublabel(
  row: ConversationRow,
  kind: FindRowKind,
  label: string,
  companyLabel: CompanyLabelResolver,
): string {
  if (kind === "agent") return "Agent";
  // The email is the one disambiguator two same-named people cannot share.
  if (kind === "person") return row.email?.trim() ?? "";
  if (row.kind === "group") {
    // An unnamed group's title IS the roster join — never stutter it.
    const roster = groupRoster(row);
    if (roster && roster.trim() !== label.trim()) return roster;
  }
  // Opening this modal loads EVERY company's project channels, so two
  // identically named channels are indistinguishable without the workspace.
  return companyLabel(row.companyUid ?? null);
}

function toFindRow(
  row: ConversationRow,
  slug: string,
  companyLabel: CompanyLabelResolver,
): FindRow {
  const kind = findRowKind(row);
  const label = findRowLabel(row);
  return {
    key: row.id,
    kind,
    row,
    label,
    sublabel: findRowSublabel(row, kind, label, companyLabel),
    exact: Boolean(slug) && channelSlug(label) === slug,
  };
}

function matchesQuery(row: ConversationRow, needle: string): boolean {
  if (!needle) return true;
  const label = findRowLabel(row).toLowerCase();
  if (label.includes(needle)) return true;
  const email = row.email?.trim().toLowerCase() ?? "";
  return Boolean(email) && email.includes(needle);
}

/**
 * The one result list behind the find step. No tabs, no lane picker: groups in
 * a fixed order (Channels, People, Agents) then the create row last, with an
 * exact slug match hoisted to the very top so the user opens the channel they
 * already have instead of creating a duplicate.
 */
export function buildFindResults(args: {
  rows: readonly ConversationRow[];
  query: string;
  canCreate: boolean;
  target: SlugTarget;
  selfPersonUid?: string | null;
  /** Workspace label for channel rows — omit and channel rows carry none. */
  companyLabel?: CompanyLabelResolver;
}): FindResults {
  const { rows, query, canCreate, target } = args;
  const selfUid = args.selfPersonUid?.trim() || null;
  const companyLabel = args.companyLabel ?? NO_COMPANY_LABEL;
  // Never offer yourself as a DM target, and never offer the synthetic
  // #setup support row: it is injected client-side and pinned first, so with
  // an empty query it would be the default first result (and a fast
  // type-then-Enter would land in support instead of the intended channel).
  // It is not a real channel either, so it must not reserve the slug.
  const visible = rows.filter(
    (row) =>
      !(selfUid && row.kind === "dm" && row.personUid === selfUid) &&
      !(row.kind !== "dm" && isSetupChannel(row.channelId)),
  );
  const classified = classifyFindQuery(query);

  if (classified.kind === "empty") {
    return {
      rows: visible
        .slice(0, EMPTY_QUERY_LIMIT)
        .map((row) => toFindRow(row, "", companyLabel)),
      createSlug: null,
    };
  }

  // An address can neither name a channel nor be matched into one. The UI says
  // "no match" and points at the members picker instead of guessing.
  if (classified.kind === "email") {
    return { rows: [], createSlug: null };
  }

  const slug = classified.slug;
  const needle = query.trim().replace(/^#+/, "").trim().toLowerCase();
  const matched = visible.filter((row) => matchesQuery(row, needle));

  const groups: Record<FindRowKind, FindRow[]> = {
    channel: [],
    person: [],
    agent: [],
  };
  const exact: FindRow[] = [];
  for (const row of matched) {
    const found = toFindRow(row, slug, companyLabel);
    if (found.exact) {
      exact.push(found);
      continue;
    }
    groups[found.kind].push(found);
  }

  const ordered = [
    ...exact,
    ...groups.channel.slice(0, GROUP_LIMIT),
    ...groups.person.slice(0, GROUP_LIMIT),
    ...groups.agent.slice(0, GROUP_LIMIT),
  ].slice(0, RESULT_LIMIT);

  // Suppress create when a channel we can see in THIS workspace already owns
  // the slug — that row is hoisted to index 0 and the user should open it.
  const takenLocally = knownSlugsInScope(
    target,
    visible
      .filter((row) => row.kind !== "dm" && row.channelId)
      .map((row) => ({
        channelId: row.channelId as string,
        title: row.title,
        companyUid: row.companyUid,
        ...(row.channelScope ? { channelScope: row.channelScope } : {}),
        projectId: row.projectId ?? null,
      })),
  );

  const createSlug =
    canCreate && slug && !takenLocally.has(slug) ? slug : null;

  return { rows: ordered, createSlug };
}

// ── Member picker ────────────────────────────────────────────────────────────

export type CandidateType = "person" | "agent" | "email";

export interface PickerCandidate {
  key: string;
  type: CandidateType;
  personUid: string | null;
  email: string | null;
  label: string;
  sublabel: string;
  companyUid: string | null;
}

const PICKER_GROUP_LIMIT = 6;

interface CandidateDraft {
  personUid: string;
  label: string;
  email: string | null;
  companyUid: string | null;
}

/**
 * People AND agents the user can add — sourced from the full directory (which
 * includes company teammates and agents you have never messaged) plus the
 * contacts roster, NOT from "people you already DM'd".
 *
 * When `allowEmail` and nothing matches a well-formed address, one `email`
 * candidate is appended: that person goes through the existing DM
 * connection-request flow after the channel exists.
 */
export function buildPickerCandidates(args: {
  rows: readonly ConversationRow[];
  contacts: readonly DmContactInput[];
  query: string;
  picked: readonly string[];
  selfPersonUid?: string | null;
  allowEmail: boolean;
  limitPerGroup?: number;
}): PickerCandidate[] {
  const limit = args.limitPerGroup ?? PICKER_GROUP_LIMIT;
  const selfUid = args.selfPersonUid?.trim() || null;
  const pickedKeys = new Set(args.picked.map((value) => value.toLowerCase()));

  const drafts = new Map<string, CandidateDraft>();
  const remember = (draft: CandidateDraft): void => {
    const existing = drafts.get(draft.personUid);
    if (!existing) {
      drafts.set(draft.personUid, draft);
      return;
    }
    drafts.set(draft.personUid, {
      personUid: draft.personUid,
      label: existing.label || draft.label,
      email: existing.email ?? draft.email,
      companyUid: existing.companyUid ?? draft.companyUid,
    });
  };

  for (const row of args.rows) {
    const uid = row.personUid?.trim();
    if (row.kind !== "dm" || !uid) continue;
    remember({
      personUid: uid,
      label: findRowLabel(row),
      email: row.email?.trim() || null,
      companyUid: row.companyUid ?? null,
    });
  }
  for (const contact of args.contacts) {
    const uid = contact.personUid?.trim();
    if (!uid) continue;
    const email = contact.email?.trim() || null;
    const label =
      contact.displayName?.trim() ||
      email ||
      (isAgentUid(uid) ? agentFallbackLabel(uid) : "");
    if (!label) continue;
    remember({ personUid: uid, label, email, companyUid: contact.companyUid ?? null });
  }

  const needle = args.query.trim().toLowerCase();
  const people: PickerCandidate[] = [];
  const agents: PickerCandidate[] = [];
  for (const draft of drafts.values()) {
    if (selfUid && draft.personUid === selfUid) continue;
    if (pickedKeys.has(draft.personUid.toLowerCase())) continue;
    if (
      needle &&
      !draft.label.toLowerCase().includes(needle) &&
      !(draft.email ?? "").toLowerCase().includes(needle)
    ) {
      continue;
    }
    const agent = isAgentUid(draft.personUid);
    const candidate: PickerCandidate = {
      key: `${agent ? "agent" : "person"}:${draft.personUid}`,
      type: agent ? "agent" : "person",
      personUid: draft.personUid,
      email: draft.email,
      label: draft.label,
      sublabel: agent ? "Agent" : (draft.email ?? ""),
      companyUid: draft.companyUid,
    };
    (agent ? agents : people).push(candidate);
  }

  const out = [...people.slice(0, limit), ...agents.slice(0, limit)];
  const typed = args.query.trim();
  if (
    args.allowEmail &&
    out.length === 0 &&
    isValidEmail(typed) &&
    !pickedKeys.has(typed.toLowerCase())
  ) {
    out.push({
      key: `email:${typed.toLowerCase()}`,
      type: "email",
      personUid: null,
      email: typed,
      label: typed,
      sublabel: "Not on HQ — we'll send a request to connect.",
      companyUid: null,
    });
  }
  return out;
}

// ── Cross-company relation ───────────────────────────────────────────────────

export type CompanyRelation = "inside" | "outside" | "unknown";

/**
 * The workspace roster D7 actually needs: every person the server lists as a
 * member of ONE company (`GET /v1/notify/contacts?companyUid=…`, the desktop
 * `list_company_members` command).
 *
 * This is the authoritative source. `GET /v1/notify/contacts` (unscoped) does
 * NOT carry `companyUid` per row, so without a roster the relation below can
 * only ever answer `unknown` in production and the confirmation never fires.
 */
export interface CompanyRoster {
  companyUid: string;
  personUids: ReadonlySet<string>;
}

/** Build a roster from a `list_company_members` response. */
export function rosterFromMembers(
  companyUid: string,
  members: readonly { personUid?: string | null }[],
): CompanyRoster {
  const personUids = new Set<string>();
  for (const member of members) {
    const uid = member.personUid?.trim();
    if (uid) personUids.add(uid);
  }
  return { companyUid, personUids };
}

/**
 * Is this person listed inside the target workspace?
 *
 * With a `roster` for the SAME company the answer is definitive: in the roster
 * is `inside`, absent from it is `outside` (D7 confirms, it never blocks).
 *
 * Without one we fall back to the contacts heuristic, whose honest default is
 * `unknown`: an unscoped contact row carries at most one `companyUid` — in
 * practice none — while people hold many memberships. Only a positive
 * `outside` triggers confirmation; nagging on `unknown` would fire on every
 * teammate and train the user to click through.
 */
export function companyRelation(
  personUid: string,
  targetCompanyUid: string,
  contacts: readonly DmContactInput[],
  roster?: CompanyRoster | null,
): CompanyRelation {
  if (
    roster &&
    roster.companyUid === targetCompanyUid &&
    roster.personUids.size > 0
  ) {
    return roster.personUids.has(personUid) ? "inside" : "outside";
  }
  const known = new Set(
    contacts
      .filter((contact) => contact.personUid === personUid)
      .map((contact) => contact.companyUid?.trim() ?? "")
      .filter(Boolean),
  );
  if (known.size === 0) return "unknown";
  return known.has(targetCompanyUid) ? "inside" : "outside";
}

// ── Failure parsing ──────────────────────────────────────────────────────────

const RAW_UID = /\b(?:prs_|cmp_|chn_|agt_)[A-Za-z0-9_-]+\b/g;

/** Remove raw prs_/cmp_/chn_/agt_ tokens — never render one at a user. */
export function stripRawUids(text: string): string {
  return text
    .replace(RAW_UID, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export type CreateChannelFailure = {
  code: "slug-taken" | "not-company-member" | "name-too-long" | "unknown";
  message: string;
};

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message ?? "";
  if (typeof err === "string") return err;
  if (err == null) return "";
  return String(err);
}

/**
 * Map a create-channel rejection onto a message we are willing to show.
 *
 * The Rust `post_json` seam keeps only `body.error`, dropping the HTTP status
 * and the structured `code`/`scopeKey`/`slug` — so the duplicate case arrives
 * as a sentence containing a raw `company#cmp_…` key. We match on shape and
 * substitute our own copy rather than echoing it.
 */
export function parseCreateChannelError(
  err: unknown,
  name?: string,
): CreateChannelFailure {
  const raw = errorText(err);
  if (/already taken/i.test(raw)) {
    const label = name?.trim();
    return {
      code: "slug-taken",
      message: label
        ? `“${label}” is already taken here. Pick a different name.`
        : "That name is already taken here. Pick a different name.",
    };
  }
  if (/not an active member of this company/i.test(raw) || /NOT_COMPANY_MEMBER/.test(raw)) {
    return {
      code: "not-company-member",
      message: "You're not an active member of that workspace.",
    };
  }
  if (/exceeds 200 characters/i.test(raw)) {
    return {
      code: "name-too-long",
      message: "That name is too long — 200 characters max.",
    };
  }
  const cleaned = stripRawUids(raw);
  return {
    code: "unknown",
    message:
      cleaned && cleaned === raw.trim()
        ? cleaned
        : "Could not create the channel.",
  };
}

export type MemberFailureReason =
  | "unreachable"
  | "not-owner"
  | "agent-scope"
  | "other";

/**
 * Why an `addChannelMember` call failed, in terms the summary can act on.
 *
 * An unreachable AGENT is `agent-scope`: agent DMs are gated purely by company
 * overlap and there is no connection-request flow to or from an agent, so we
 * must never offer "send a request instead" for one.
 */
export function memberFailureReason(
  err: unknown,
  personUid: string,
): MemberFailureReason {
  const raw = errorText(err);
  if (/CHANNEL_NOT_OWNER/i.test(raw) || /not the (channel )?owner/i.test(raw)) {
    return "not-owner";
  }
  if (/RECIPIENT_NOT_FOUND|INVITEE_NOT_FOUND|not found/i.test(raw)) {
    return isAgentUid(personUid) ? "agent-scope" : "unreachable";
  }
  return "other";
}

// ── Invite copy ──────────────────────────────────────────────────────────────

/**
 * Body of the DM connection request sent to someone we cannot add directly.
 * The channel is always named so the recipient knows what they are accepting.
 */
export function inviteRequestBody(args: {
  slug: string;
  companyLabel: string | null;
  inviterLabel: string | null;
}): string {
  const workspace = args.companyLabel?.trim();
  const inviter = args.inviterLabel?.trim();
  const where = workspace ? ` on HQ (${workspace})` : " on HQ";
  const sign = inviter ? ` — ${inviter}` : "";
  return `Hi — I'd like to add you to #${args.slug}${where}. Accept this request and I'll add you to the channel.${sign}`;
}
