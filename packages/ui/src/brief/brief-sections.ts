import type { BriefInput } from "./brief-types.js";
type Company = { uid: string; slug?: string | null; label: string };
export interface BriefSection { id: string; label: string; input: BriefInput }

/** Partition only explicit company attribution; names and repos are not identities. */
export function briefSections(input: BriefInput, companies: Company[]): BriefSection[] {
  if (!companies.length) return [];
  return [null, ...companies].map(company => {
    const personal = company === null;
    const matches = (uid: string | null | undefined) => company === null ? !uid : uid === company.uid || (!!company.slug && uid === company.slug);
    const origin = <T extends { origin?: {companyUid: string | null} }>(rows: T[] | undefined): T[] => (rows ?? []).filter(row => matches(row.origin?.companyUid));
    const decisions = origin(input.decisions), risks = origin(input.risks), carry = origin(input.carry), handoffs = origin(input.handoffs);
    const ids = new Set([...decisions, ...risks, ...carry, ...handoffs].map(row => row.id));
    return {
      id: company?.uid ?? "personal", label: company?.label ?? "Personal",
      input: {
        ...input,
        companies: company ? [company.uid, ...(company.slug ? [company.slug] : [])] : [],
        decisions, risks, carry, handoffs,
        actionItems: origin(input.actionItems), shipped: origin(input.shipped), waitingOn: origin(input.waitingOn),
        releases: origin(input.releases), recovered: origin(input.recovered),
        mainHealth: (input.mainHealth ?? []).filter(row => matches(row.companyUid)),
        meetingsYesterday: input.meetingsYesterday.filter(row => matches(row.companyUid)),
        sessions: input.sessions.filter(row => matches(row.company)),
        recentSessions: (input.recentSessions ?? []).filter(row => matches(row.company)),
        priorities: input.priorities?.filter(row => matches(row.companyUid) && row.itemId != null && ids.has(row.itemId)),
        calendarToday: personal ? input.calendarToday : [],
        team: input.team.filter(row => matches(row.companyUid)),
        reminders: (input.reminders ?? []).filter(row => matches(row.companyUid)),
        days: [], landedDays: [],
        fleetIncident: (input.fleetIncidents ?? (input.fleetIncident ? [input.fleetIncident] : [])).find(row => matches(row.companyUid)) ?? null,
        fleetIncidents: (input.fleetIncidents ?? []).filter(row => matches(row.companyUid)),
        // Aggregate totals cannot be relabelled as Personal or a company.
        merged: null, opened: null, prWindow: null, dmCount: 0,
        timeToClearMin: null, leadHint: null, previous: null,
      },
    };
  });
}
