/**
 * OWNER-R5: the roster the people resolver reads, per company. Uses the Team
 * cache when the Team page already loaded it, else the same roster read the
 * Team page uses (contacts by company uid, else members by slug). No new route.
 */
import type { CompanyApi, MessagingApi } from "@hq/platform";
import { readTeamCache } from "../../company/team-cache.js";
import {
  EMPTY_PEOPLE_INDEX,
  buildPeopleIndex,
  rosterEntriesFromRows,
  type PeopleIndex,
  type PeopleRosterEntry,
} from "./people.js";

interface RosterState {
  index: PeopleIndex;
  loading: boolean;
}

const states = new Map<string, RosterState>();
const inflight = new Map<string, Promise<void>>();
let version = $state(0);

function fromTeamCache(slug: string): PeopleRosterEntry[] | null {
  const hit = readTeamCache(slug);
  if (!hit) return null;
  return hit.view.members.map((m) => ({ id: m.id, kind: m.kind, displayName: m.displayName, email: m.email ?? null }));
}

/** Current index for a company; reactive. `loading` until the roster answers. */
export function peopleFor(slug: string): RosterState {
  void version;
  const state = states.get(slug);
  if (state) return state;
  const cached = fromTeamCache(slug);
  if (cached) return { index: buildPeopleIndex(cached), loading: false };
  return { index: EMPTY_PEOPLE_INDEX, loading: true };
}

/** Load the roster once per company; later calls reuse it. */
export function loadPeople(opts: {
  slug: string;
  companyUid?: string | null;
  company?: Pick<CompanyApi, "listMembers"> | null;
  messaging?: Pick<MessagingApi, "listContacts"> | null;
}): Promise<void> {
  const { slug, companyUid, company, messaging } = opts;
  if (!slug || states.has(slug)) return Promise.resolve();
  const cached = fromTeamCache(slug);
  if (cached) {
    states.set(slug, { index: buildPeopleIndex(cached), loading: false });
    version += 1;
    return Promise.resolve();
  }
  const running = inflight.get(slug);
  if (running) return running;
  const run = (async () => {
    let rows: unknown[] = [];
    try {
      if (messaging && companyUid) {
        const res = await messaging.listContacts({ companyUid });
        if (res.ok && Array.isArray(res.value)) rows = res.value;
        else if (!res.ok) console.warn("[people] contacts read failed", res.message ?? res.reason);
      }
      if (rows.length === 0 && company) {
        const res = await company.listMembers(slug);
        if (res.ok && Array.isArray(res.value)) rows = res.value;
        else if (!res.ok) console.warn("[people] members read failed", res.message ?? res.reason);
      }
    } catch (err) {
      console.warn("[people] roster read failed", err);
    }
    states.set(slug, { index: buildPeopleIndex(rosterEntriesFromRows(rows)), loading: false });
    inflight.delete(slug);
    version += 1;
  })();
  inflight.set(slug, run);
  return run;
}

/** Tests only. */
export function resetPeopleRosters(): void {
  states.clear();
  inflight.clear();
  version += 1;
}

let activeSlug = $state("");

/** The company whose roster shared displays (provenance lines) resolve against. */
export function setActivePeopleCompany(slug: string): void {
  activeSlug = slug;
}

/** Roster state for the active company; empty and not loading when none. */
export function activePeople(): RosterState {
  if (!activeSlug) return { index: EMPTY_PEOPLE_INDEX, loading: false };
  return peopleFor(activeSlug);
}
