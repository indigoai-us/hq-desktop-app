/**
 * New-channel "In" scope: default, member filtering, pre-submit validation,
 * and safe retry after an unconfirmed create.
 *
 * Personal HQ companies (kind/slug/state `personal`, or a membership named
 * after the owner) are not company scopes for channel create. Personal
 * (`companyUid === ""`) is only for the owner and their own agents.
 */

import { isAgentUid } from "./agent-thinking.js";
import { humanizeChannelName } from "./channels.js";
import type { ChannelDirectoryFeed } from "./channel-directory-reconciler.js";
import type { ConversationRow, DmContactInput, ScopeCompany } from "./sidebar-model.js";
import type { Workspace } from "./workspaces.js";

export const PERSONAL_CHANNEL_SCOPE = "";

export interface ChannelCreateMember {
  personUid: string;
  label: string;
  companyUids: string[];
}

export interface ChannelScopeUnavailable {
  company: ScopeCompany;
  reason: string;
}

export interface ChannelCreateScopeInput {
  activeScope: string;
  companies: readonly ScopeCompany[];
  members: readonly ChannelCreateMember[];
  selfUid?: string | null;
}

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function isPersonalWorkspace(
  workspace: {
    kind?: string | null;
    slug?: string | null;
    state?: string | null;
    displayName?: string | null;
  },
  ownerLabel?: string | null,
): boolean {
  const kind = trimmed(workspace.kind).toLowerCase();
  const slug = trimmed(workspace.slug).toLowerCase();
  const state = trimmed(workspace.state).toLowerCase();
  if (kind === "personal" || state === "personal" || slug === "personal") {
    return true;
  }
  const owner = trimmed(ownerLabel).toLowerCase();
  const name = trimmed(workspace.displayName).toLowerCase();
  return Boolean(owner && name && owner === name);
}

export function companiesForChannelCreate(
  workspaces: ReadonlyArray<Workspace> | null | undefined,
  ownerLabel?: string | null,
): ScopeCompany[] {
  const out: ScopeCompany[] = [];
  const seen = new Set<string>();
  for (const workspace of workspaces ?? []) {
    if (isPersonalWorkspace(workspace, ownerLabel)) continue;
    const companyUid = trimmed(workspace.cloudUid);
    if (!companyUid || seen.has(companyUid)) continue;
    const status = trimmed(workspace.membershipStatus).toLowerCase() || "active";
    if (status !== "active") continue;
    seen.add(companyUid);
    out.push({
      companyUid,
      label: trimmed(workspace.displayName) || workspace.slug || "Company",
    });
  }
  return out;
}

export function isPersonalOnlyParticipant(
  member: Pick<ChannelCreateMember, "personUid">,
  selfUid?: string | null,
): boolean {
  const uid = trimmed(member.personUid);
  if (!uid) return false;
  if (selfUid && uid === trimmed(selfUid)) return true;
  return isAgentUid(uid);
}

export function personalScopeAllowed(
  members: readonly Pick<ChannelCreateMember, "personUid">[],
  selfUid?: string | null,
): boolean {
  return members.every((member) => isPersonalOnlyParticipant(member, selfUid));
}

export function companyUidsByPerson(
  rows: ReadonlyArray<
    Pick<ConversationRow, "kind" | "personUid" | "companyUid">
  >,
  contacts: ReadonlyArray<Pick<DmContactInput, "personUid" | "companyUid">> = [],
): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  const add = (
    personUid: string | null | undefined,
    companyUid: string | null | undefined,
  ) => {
    const uid = trimmed(personUid);
    const company = trimmed(companyUid);
    if (!uid || !company) return;
    let set = map.get(uid);
    if (!set) {
      set = new Set();
      map.set(uid, set);
    }
    set.add(company);
  };
  for (const row of rows) {
    if (row.kind === "dm") add(row.personUid, row.companyUid);
  }
  for (const contact of contacts) add(contact.personUid, contact.companyUid);
  return new Map([...map.entries()].map(([uid, set]) => [uid, [...set]]));
}

function knownCompaniesOf(
  member: ChannelCreateMember,
  selfUid?: string | null,
): string[] | null {
  if (isPersonalOnlyParticipant(member, selfUid)) return null;
  return member.companyUids.length > 0 ? member.companyUids : null;
}

export function availableCompanyUids(
  companies: readonly ScopeCompany[],
  members: readonly ChannelCreateMember[],
  selfUid?: string | null,
): string[] {
  const all = companies.map((company) => company.companyUid);
  if (members.length === 0) return all;
  return all.filter((companyUid) =>
    members.every((member) => {
      const known = knownCompaniesOf(member, selfUid);
      return known == null || known.includes(companyUid);
    }),
  );
}

export function unavailableChannelScopes(
  companies: readonly ScopeCompany[],
  members: readonly ChannelCreateMember[],
  selfUid?: string | null,
): ChannelScopeUnavailable[] {
  if (members.length === 0) return [];
  const out: ChannelScopeUnavailable[] = [];
  for (const company of companies) {
    const missing = members.find((member) => {
      const known = knownCompaniesOf(member, selfUid);
      return known != null && !known.includes(company.companyUid);
    });
    if (!missing) continue;
    out.push({
      company,
      reason: `${missing.label} isn't a member of ${company.label}`,
    });
  }
  return out;
}

function labelFor(
  companies: readonly ScopeCompany[],
  companyUid: string,
): string {
  return (
    companies.find((company) => company.companyUid === companyUid)?.label ??
    "Company"
  );
}

function firstRestrictingMember(
  members: readonly ChannelCreateMember[],
  selfUid?: string | null,
): ChannelCreateMember | null {
  return (
    members.find((member) => knownCompaniesOf(member, selfUid) != null) ??
    members.find((member) => !isPersonalOnlyParticipant(member, selfUid)) ??
    null
  );
}

function activeLooksPersonal(
  active: string,
  companies: readonly ScopeCompany[],
): boolean {
  if (!active || active === "all") return false;
  if (active === "personal") return true;
  return !companies.some((company) => company.companyUid === active);
}

export function defaultChannelCompanyUid(
  input: ChannelCreateScopeInput,
): string {
  const available = availableCompanyUids(
    input.companies,
    input.members,
    input.selfUid,
  );
  const personalOk = personalScopeAllowed(input.members, input.selfUid);
  const active = trimmed(input.activeScope);

  if (active && available.includes(active)) return active;

  if (input.members.length > 0 && available.length === 1) return available[0];

  if (activeLooksPersonal(active, input.companies) && personalOk) {
    return PERSONAL_CHANNEL_SCOPE;
  }

  if (input.members.length === 0) {
    return input.companies[0]?.companyUid ?? PERSONAL_CHANNEL_SCOPE;
  }

  if (available.length > 1) return available[0];
  if (personalOk) return PERSONAL_CHANNEL_SCOPE;
  return available[0] ?? PERSONAL_CHANNEL_SCOPE;
}

export function pickChannelCompanyUid(
  input: ChannelCreateScopeInput & { currentUid: string },
): string {
  const available = availableCompanyUids(
    input.companies,
    input.members,
    input.selfUid,
  );
  const personalOk = personalScopeAllowed(input.members, input.selfUid);
  const current = trimmed(input.currentUid);

  if (current && available.includes(current)) return current;
  if (!current && personalOk) return PERSONAL_CHANNEL_SCOPE;
  return defaultChannelCompanyUid(input);
}

export function channelCreateValidationMessage(
  input: ChannelCreateScopeInput & { companyUid: string },
): string | null {
  if (input.members.length === 0) return null;

  const companyUid = trimmed(input.companyUid);
  const available = availableCompanyUids(
    input.companies,
    input.members,
    input.selfUid,
  );
  const pickHint =
    available.length === 1
      ? ` — pick ${labelFor(input.companies, available[0])}`
      : available.length > 1
        ? " — pick a company they all belong to"
        : "";

  if (!companyUid) {
    if (personalScopeAllowed(input.members, input.selfUid)) return null;
    const outsider = firstRestrictingMember(input.members, input.selfUid);
    const scopeLabel = "Personal";
    if (!outsider) return `Pick a company${pickHint}`;
    return `${outsider.label} isn't a member of ${scopeLabel}${pickHint}`;
  }

  const companyLabel = labelFor(input.companies, companyUid);
  const missing = input.members.find((member) => {
    const known = knownCompaniesOf(member, input.selfUid);
    return known != null && !known.includes(companyUid);
  });
  if (!missing) return null;
  return `${missing.label} isn't a member of ${companyLabel}${pickHint}`;
}

export function formatChannelCreateFailure(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message.trim()
      : typeof err === "string"
        ? err.trim()
        : "";
  const stripped = raw.replace(/^\[[^\]]+\]\s*/, "").trim();
  return stripped || "Could not create the channel";
}

export function directoryRowsFromFeed(
  feed: ChannelDirectoryFeed | null | undefined,
): Array<{ name?: string | null }> {
  if (!feed) return [];
  return [...(feed.rows ?? []), ...(feed.changed ?? [])];
}

export function channelExistsWithName(
  name: string,
  ...lists: Array<
    | Iterable<{ name?: string | null } | null | undefined>
    | null
    | undefined
  >
): boolean {
  const needle = humanizeChannelName(name).toLowerCase();
  if (!needle) return false;
  for (const list of lists) {
    if (!list) continue;
    for (const row of list) {
      const candidate = humanizeChannelName(row?.name ?? "").toLowerCase();
      if (candidate && candidate === needle) return true;
    }
  }
  return false;
}

export function unconfirmedCreateMessage(args: {
  detail: string;
  name: string;
  exists: boolean;
}): string {
  if (args.exists) {
    return `Channel creation could not be confirmed: ${args.detail}. A channel named “${args.name}” is already in your list, so retry is disabled to avoid creating a duplicate.`;
  }
  return `Couldn't create the channel: ${args.detail}. Nothing named “${args.name}” showed up in your channel list, so you can try again.`;
}
