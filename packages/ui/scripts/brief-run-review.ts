#!/usr/bin/env tsx
// Reviews a real brief run the way the app renders it, without the app.
// Usage: tsx scripts/brief-run-review.ts <hq-root> <run_id> [company-slug] [company-uid]
// Reads workspace/brief/<run_id>/{brief-data.json,brief.json} through the
// same loader the Daily Brief page uses (gatherBriefInput with a file-only
// adapter), runs the picker, and prints the plan plus every row each card
// would show, so the cards can be checked against the owner rules.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherBriefInput } from "../src/brief/brief-data.js";
import { generateBrief } from "../src/brief/brief-generate.js";
import { buildContext, CATALOGUE } from "../src/brief/brief-catalogue.js";

const [root, runId, slug = "indigo", uid = `cmp_${slug}`] = process.argv.slice(2);
if (!root || !runId) {
  console.error("usage: brief-run-review.ts <hq-root> <run_id> [slug] [uid]");
  process.exit(2);
}
const source = {
  async readHqFile(rel: string) {
    try {
      return await readFile(join(root, rel), "utf8");
    } catch {
      return null;
    }
  },
};
const { input, failures } = await gatherBriefInput({}, { companies: [{ uid, slug, label: slug }], runId, sweep: source, log: () => {} });
const plan = generateBrief(input);
const ctx = buildContext(input);
const out = (label: string, v: unknown) => console.log(`\n## ${label}\n${JSON.stringify(v, null, 1)}`);
console.log(`run ${runId}  today ${input.today}  now ${input.now}  lead ${plan.lead} (${plan.reason})  template ${plan.template}  dayType ${plan.dayType}  density ${plan.density}`);
console.log(`failures: ${failures.join(", ") || "none"}`);
console.log(`\n## widgets`);
for (const w of plan.widgets) console.log(`- ${w.kind} [${w.size ?? ""}] ${w.reason}`);
console.log(`\n## dropped`);
for (const d of plan.dropped) console.log(`- ${d.kind}: ${d.why}`);
console.log(`\n## measured`);
for (const e of CATALOGUE) {
  const ev = e.measure(ctx);
  if (ev) console.log(`- ${e.id} n=${ev.n} value=${ev.value} items=${ev.items.join(",")} fact="${ev.fact}"`);
}
out("leadPriority", plan.leadPriority);
out("priorities", input.priorities);
out("decisions", input.decisions.map((d) => ({ id: d.id, title: d.title, action: d.action, source: d.source, blocks: d.blocks, peopleWaiting: d.peopleWaiting, unlocks: d.detail?.unlocks, age: d.ageHours, origin: d.origin })));
out("waiting", input.waitingOn);
out("risks", input.risks.map((r) => ({ id: r.id, sev: r.severity, title: r.title, summary: r.summary, ci: r.ci, measure: r.measure, origin: r.origin })));
out("shipped", input.shipped);
out("meetingsYesterday", input.meetingsYesterday.map((m) => ({ title: m.title, start: m.startTime, attended: m.attended, with: m.with, decided: m.decided, todo: m.todo })));
out("calendarToday", input.calendarToday);
out("team", input.team);
out("carry", input.carry);
out("handoffs", input.handoffs);
out("recovered", input.recovered);
out("releases", input.releases);
out("reminders", input.reminders);
out("days", input.days);
out("sessions(timeline)", { count: plan.sessions.count, byWorkstream: plan.sessions });
out("fleetIncident", input.fleetIncident);
out("mainHealth", input.mainHealth);
out("prefs", input.prefs);
