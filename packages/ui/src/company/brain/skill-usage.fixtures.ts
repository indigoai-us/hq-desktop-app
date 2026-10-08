// OWNER-R11 fixtures in the hq-pro company and /me telemetry shapes (fictional names).
const skills = (bySkill: { skill: string; count: number }[]) => ({ total: bySkill.reduce((n, s) => n + s.count, 0), bySkill });
export const COMPANY = {
  daily: [
    { date: "2026-10-01", skills: skills([{ skill: "/run-project", count: 2 }]) },
    { date: "2026-10-02", skills: skills([{ skill: "indigo:design-review", count: 1 }]) },
  ],
  perMember: [
    { personUid: "prs_a", totals: { skills: skills([{ skill: "/run-project", count: 5 }, { skill: "indigo:design-review", count: 1 }]) } },
    { personUid: "prs_b", totals: { skills: skills([{ skill: "run-project", count: 2 }]) } },
  ],
};
export const ME = { totals: { skills: { "run-project": 3, "hq:handoff": 1 } } };
