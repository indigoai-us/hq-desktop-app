import { expect, it } from "vitest";
import { briefSections } from "./brief-sections.js";
import type { BriefInput } from "./brief-types.js";
it("keeps identical titles and repos separate across three companies, with global data once", () => {
  const companies = ["alpha", "beta", "gamma"].map(slug => ({uid: `cmp_${slug}`, slug, label: slug}));
  const input: BriefInput = {now: "2026-10-17T12:00:00Z", userName: "Alex", companies: companies.map(c => c.uid), lastBriefAt: null, calendarToday: [{id: "calendar", title: "Personal meeting", start: "2026-10-17T12:00:00Z", kind: "team"}], meetingsYesterday: [], decisions: companies.map(c => ({id: c.uid, title: "Review the release", summary: c.slug, action: "go", origin: {companyUid: c.uid, repo: "same/repo"}})), actionItems: [], risks: [], shipped: [], waitingOn: [], team: [], sessions: companies.map(c => ({id: c.uid, title: "Same session", startedAt: "2026-10-17", workstream: "repo", company: c.slug}))};
  const sections = briefSections(input, companies);
  expect(sections.map(s => s.label)).toEqual(["Personal", "alpha", "beta", "gamma"]);
  expect(sections[0]!.input.calendarToday).toHaveLength(1);
  for (let i = 1; i < sections.length; i++) {
    expect(sections[i]!.input.decisions.map(d => d.origin.companyUid)).toEqual([companies[i - 1]!.uid]);
    expect(sections[i]!.input.sessions).toHaveLength(1);
    expect(sections[i]!.input.calendarToday).toEqual([]);
  }
  const aggregate = briefSections({...input, merged: 30, opened: 20, dmCount: 99, days: [{date: "2026-10-17", sessions: 2, meetings: 3, merged: 30, opened: 20}]}, companies);
  expect(aggregate.every(s => s.input.merged === null && s.input.opened === null && s.input.dmCount === 0 && s.input.days?.length === 0)).toBe(true);
});
