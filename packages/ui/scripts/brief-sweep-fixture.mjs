#!/usr/bin/env node
// Trims a real brief sweep (brief-data.json) into the preview fixture.
// Usage: node scripts/brief-sweep-fixture.mjs <brief-data.json> [out]
// Drops DM previews and every non-company session title, so nothing private
// or from another company lands in the repo.
import { readFileSync, writeFileSync } from "node:fs";

const [src, out = new URL("../src/brief/fixtures/sweep-2026-10-08.json", import.meta.url).pathname] = process.argv.slice(2);
if (!src) {
  console.error("usage: brief-sweep-fixture.mjs <brief-data.json> [out]");
  process.exit(2);
}
const d = JSON.parse(readFileSync(src, "utf8"));
const fixture = {
  generated_at: d.generated_at,
  company: d.company,
  window: d.window,
  days: d.days,
  sessions: (d.sessions ?? []).map((s) => ({
    date: s.date,
    time: s.time,
    company: s.company,
    title: s.company === d.company ? s.title : null,
  })),
  meeting_signals: d.meeting_signals ?? [],
  dms: (d.dms ?? []).map((m) => ({ from: m.from, from_uid: m.from_uid, is_agent: m.is_agent, at: m.at })),
  fleet: d.fleet
    ? { total: d.fleet.total, by_status: d.fleet.by_status, by_setup_phase: d.fleet.by_setup_phase }
    : null,
  prs: (d.prs ?? []).map((p) => ({ repo: p.repo, number: p.number, title: p.title, state: p.state, created: p.created, closed: p.closed })),
  main_health: d.main_health ?? {},
  sources: d.sources ?? {},
};
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${out}`);
