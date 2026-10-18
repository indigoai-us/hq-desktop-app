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
it("dispatches all companies without consulting the active company, including zero companies", async () => {
 const company = vi.fn(() => { throw new Error("must not read company"); });
 const dispatch = vi.fn(async (..._args: unknown[]) => null);
 const run = new BriefCreateRun({creator: {company, check: async () => ({ok:true, bot: {name:"bot",agentUid:"agt_1"} as never}), dispatch, fix:async()=>null, notify:()=>{}}, read:async()=>null, storage:null, setTimer:()=>0, clearTimer:()=>{}});
 await run.start();
 expect(company).not.toHaveBeenCalled();
 expect(dispatch.mock.calls[0]?.[1]).toMatch(/^\/daily-brief --all --run-id /);
 expect(run.phase.kind).toBe("waiting");
 run.stop();
});
it("always invokes person mode and explicitly marks the welcome edition", () => {
 expect(briefJobMessage("brief-20261017-090000").split("\n")[0]).toBe("/daily-brief --all --run-id brief-20261017-090000");
 expect(briefJobMessage("brief-20261017-090000", {welcome:true}).split("\n")[0]).toBe("/daily-brief --all --run-id brief-20261017-090000 --welcome");
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
it("the shell sends the welcome edition explicitly and has no add-company toast", () => {
 const src=readFileSync("src/shell/DesktopApp.svelte","utf8");
 expect(src).toContain("run.start({ welcome: true })");
 expect(src).not.toContain('key: "brief-add-company"');
});
