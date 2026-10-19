// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { BriefCreateRun } from "./brief-create.svelte.js";
import { briefJobMessage } from "./brief-runs.js";
import { parseBriefItems } from "./brief-run-files.js";
import { parseSamples } from "./brief-findings.js";
import { mergeMeetings, mergeShipped } from "./brief-data.js";
const roster = ["alpha", "beta", "gamma"].map(slug => ({ slug, uid: `cmp_${slug}`, label: slug }));
it("reads the core person-mode envelope and keeps section attribution authoritative", () => {
 const companies = Object.fromEntries(roster.map(c => [c.slug,{items:{decisions:[{id:c.slug,title:c.slug,company:"other"}]}}]));
 const parsed = parseBriefItems(JSON.stringify({mode:"person",personal:{items:{decisions:[{title:"Personal"}]}},companies}),roster)!;
 expect(parsed.decisions.map(d=>d.origin.companyUid)).toEqual([null,"cmp_alpha","cmp_beta","cmp_gamma"]);
});
it("does not fold equal meeting names or repo names across companies", () => {
 const meetings = roster.map(c => ({id:c.uid,title:"Standup",startTime:"2026-10-16T10:00:00Z",companyUid:c.uid,decisions:1,actions:0,risks:0,questions:0}));
 expect(mergeMeetings([meetings[0]!], meetings.slice(1))).toHaveLength(3);
 const ships = roster.map(c => ({id:c.uid,title:"App",status:"1 merged",note:"",origin:{companyUid:c.uid,repo:"app"},lines:[]}));
 expect(mergeShipped([ships[0]!],ships.slice(1))).toHaveLength(3);
});
function personRun(hasCompanies?: () => boolean | null) {
 const company = vi.fn(() => { throw new Error("must not read company"); });
 const dispatch = vi.fn(async (..._args: unknown[]) => null);
 const run = new BriefCreateRun({creator: {company, check: async () => ({ok:true, bot: {name:"bot",agentUid:"agt_1"} as never}), dispatch, fix:async()=>null, notify:()=>{}, ...(hasCompanies ? {hasCompanies} : {})}, read:async()=>null, storage:null, setTimer:()=>0, clearTimer:()=>{}});
 return {run, company, dispatch};
}
it("dispatches all companies without consulting the active company", async () => {
 const {run, company, dispatch} = personRun(() => true);
 await run.start();
 expect(company).not.toHaveBeenCalled();
 expect(dispatch.mock.calls[0]?.[1]).toMatch(/^\/daily-brief --all --run-id brief-\d{8}-\d{6}\n/);
 expect(run.phase.kind).toBe("waiting");
 run.stop();
});
it("keeps --all while the roster is still unknown", async () => {
 const {run, dispatch} = personRun(() => null);
 await run.start();
 expect(dispatch.mock.calls[0]?.[1]).toMatch(/^\/daily-brief --all --run-id /);
 run.stop();
});
// hq-core 16.0.30's daily-brief takes `--personal` for a person with no company.
it("dispatches --personal when the person has no company", async () => {
 const {run, company, dispatch} = personRun(() => false);
 await run.start({label: "welcome brief"});
 expect(company).not.toHaveBeenCalled();
 const body = String(dispatch.mock.calls[0]?.[1]);
 expect(body.split("\n")[0]).toMatch(/^\/daily-brief --personal --run-id brief-\d{8}-\d{6}$/);
 expect(body).toContain("Build a personal brief");
 expect(body).not.toContain("every company in the person's lock");
 run.stop();
});
// 16.0.30 makes the welcome edition automatic; the job never carries the flag.
it("never says --welcome in the job text, for either scope", async () => {
 for (const personal of [false, true]) {
  const body = briefJobMessage("brief-20261017-090000", {personal});
  expect(body).not.toMatch(/--welcome|welcome/i);
 }
 expect(briefJobMessage("brief-20261017-090000").split("\n")[0]).toBe("/daily-brief --all --run-id brief-20261017-090000");
 expect(briefJobMessage("brief-20261017-090000", {personal:true}).split("\n")[0]).toBe("/daily-brief --personal --run-id brief-20261017-090000");
 for (const personal of [false, true]) {
  const {run, dispatch} = personRun(() => !personal);
  await run.start({label: "welcome brief"});
  expect(String(dispatch.mock.calls[0]?.[1])).not.toContain("--welcome");
  run.stop();
 }
});
it("resolves each item across three companies and leaves unlabelled items personal", () => {
 const decisions = [...roster.map(c=>({title:c.slug,company:c.slug})),{title:"Personal"}];
 const parsed = parseBriefItems(JSON.stringify({items:{decisions}}), roster);
 expect(parsed?.decisions.map(d=>d.origin?.companyUid)).toEqual(["cmp_alpha","cmp_beta","cmp_gamma",null]);
});
it("keeps samples from every company for a person brief", () => {
 const samples = roster.map(c=>({title:c.slug,company:c.slug,kind:"decision"}));
 expect(parseSamples(samples,null).map(s=>s.company)).toEqual(["alpha","beta","gamma"]);
});
it("does not resume a run using the obsolete company storage key", () => {
 const src = readFileSync("src/brief/brief-create.svelte.ts","utf8");
 expect(src).not.toMatch(/getItem\(ACTIVE_RUN_COMPANY_KEY\)/);
});
it("the shell never asks for the welcome edition and has no add-company toast", () => {
 const src=readFileSync("src/shell/DesktopApp.svelte","utf8");
 expect(src).not.toContain("welcome: true");
 expect(src).not.toContain("--welcome");
 expect(readFileSync("src/brief/brief-runs.ts","utf8")).not.toContain("--welcome");
 expect(src).not.toContain('key: "brief-add-company"');
});
