// @vitest-environment happy-dom
import {afterEach, expect, it, vi} from "vitest";
import {mount, tick, unmount} from "svelte";
import {readFileSync} from "node:fs";
import BriefRunsPage from "./BriefRunsPage.svelte";
import {parseWelcome} from "./brief-welcome.js";
let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
function readableText(selector: string): string {
  const copy = target.querySelector(selector)!.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
  return copy.textContent?.trim() ?? "";
}
afterEach(() => {if(app) unmount(app); app=null; target?.remove(); localStorage.clear();});
it("keeps getting-started copy when welcome enrichment fails", () => {
  expect(parseWelcome({error: "Import unavailable", getting_started: "Begin with a personal task."})).toMatchObject({error: "Import unavailable", gettingStarted: "Begin with a personal task.", connectCompany: true});
});
it("opens the actual new-company sheet from the brief action", () => {
  const source = readFileSync("src/shell/DesktopApp.svelte", "utf8");
  expect(source).toContain("onconnectcompany={() => (newCompanyOpen = true)}");
});
async function renderPersonBrief(offRailFailure = false) {
  const run = "brief-20261017-090000";
  const companies = ["alpha", "beta", "gamma"].map(slug => ({uid:`cmp_${slug}`,slug,label:slug[0]!.toUpperCase()+slug.slice(1)}));
  const payload = {mode:"person", personal:{items:{}}, companies:{alpha:{company:"alpha",items:{decisions:[{id:"d1",title:"Approve launch",action:"go",company:"alpha",prompt:"Check the release and report the result."}]}},beta:{label:"Beta Research",error:"service unavailable"}}, not_included:[{company:"gamma",reason:"not included: open HQ in that company to include it"}],welcome:{error:"Import unavailable",getting_started:"Begin with a personal task."}};
  const files:Record<string,string> = {"workspace/brief/index.jsonl":JSON.stringify({run_id:run,created_at:"2026-10-17T16:00:00Z",state:"ready",counts:{}}),[`workspace/brief/${run}/brief.json`]:JSON.stringify(payload),[`workspace/brief/${run}/brief-data.json`]:JSON.stringify(payload)};
  const older = "brief-20261016-090000";
  files["workspace/brief/index.jsonl"] += "\n" + JSON.stringify({run_id:older,created_at:"2026-10-16T16:00:00Z",state:"ready",counts:{}});
  files[`workspace/brief/${older}/brief.json`] = JSON.stringify(payload);
  files[`workspace/brief/${older}/brief-data.json`] = JSON.stringify(payload);
  target=document.createElement("div"); document.body.appendChild(target);
  app=mount(BriefRunsPage,{target,props:{adapter:{},companies:offRailFailure?companies.filter(c=>c.slug!=="beta"):companies,onlaunch:async()=>null,actions:{destinations:{assistantName:null,claudeCode:true,codex:true},onassistant:async()=>null},source:{readHqFile:async p=>files[p]??null}}});
  await vi.waitFor(async()=>{await tick();expect(target.querySelector('[data-testid="brief-content"]')).not.toBeNull();});
}

it("renders getting-started content and one plain welcome error line", async () => {
  await renderPersonBrief();
  expect(target.textContent).toContain("Begin with a personal task.");
  const errors = target.querySelectorAll('[data-testid="brief-welcome-error"]');
  expect(errors).toHaveLength(1);
  expect(errors[0]!.textContent).toBe("Some of your welcome details could not be loaded this time.");
  expect(target.textContent).not.toContain("Import unavailable");
});

it("renders the failed company notice without an empty company section", async () => {
  await renderPersonBrief();
  expect(readableText('[data-testid="brief-company-failures"]')).toBe("Beta could not be included this time.");
  expect(target.querySelector('[data-company="cmp_beta"]')).toBeNull();
});

it("uses a failed company's recorded label when it is outside the rail roster", async () => {
  await renderPersonBrief(true);
  expect(readableText('[data-testid="brief-company-failures"]')).toBe("Beta Research could not be included this time.");
  expect(target.querySelector('[data-company="cmp_beta"]')).toBeNull();
});

it("renders the exact excluded company instruction", async () => {
  await renderPersonBrief();
  expect(readableText('[data-testid="brief-exclusions"]')).toBe("Gamma is not included. Open HQ in that company to include it.");
  expect(target.querySelector('[data-company="cmp_gamma"]')).toBeNull();
});

it("renders shared chrome once and action cards only in their company section", async () => {
  await renderPersonBrief();
  expect(target.querySelectorAll('[data-testid="brief-action-cards"]')).toHaveLength(1);
  expect(target.querySelector('[data-company="cmp_alpha"] [data-testid="brief-action-cards"]')).not.toBeNull();
  expect(target.querySelectorAll("h1")).toHaveLength(1);
  expect(target.querySelectorAll('[data-widget="sunrise"]')).toHaveLength(1);
  expect(target.querySelectorAll('[data-testid="brief-runbar"]')).toHaveLength(1);
});

it("updates the aggregate sunrise after launching a company action", async () => {
  await renderPersonBrief();
  const meter = () => target.querySelector('[aria-label="Decisions cleared today"]');
  expect(meter()?.getAttribute("aria-valuenow")).toBe("0");
  target.querySelector<HTMLButtonElement>('[data-company="cmp_alpha"] [data-testid="brief-action-codex"]')!.click();
  await vi.waitFor(async () => {
    await tick();
    expect(target.querySelector('[data-testid="brief-action-launched"]')).not.toBeNull();
    expect(meter()?.getAttribute("aria-valuenow")).toBe("1");
  });
  // The run bar's squares (main's design pass) replace the older-brief arrow.
  target.querySelector<HTMLButtonElement>('[data-testid="brief-run-cell"][data-run="brief-20261016-090000"]')!.click();
  await vi.waitFor(async () => {
    await tick();
    expect(target.querySelector('[data-testid="brief-viewing"]')).not.toBeNull();
    expect(meter()?.getAttribute("aria-valuenow")).toBe("0");
  });
});
