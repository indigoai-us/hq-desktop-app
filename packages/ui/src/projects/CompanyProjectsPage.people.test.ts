// @vitest-environment happy-dom
// OWNER-R5: the Projects person filter shows one entry per person (name, email
// muted), bots after people, and no prs_/agt_ id reaches the DOM.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "./testing.js";
import CompanyProjectsPage from "./CompanyProjectsPage.svelte";
import { resetPeopleRosters } from "../common/people/people-roster.svelte.js";
import { RAW_PERSON_ID_IN_TEXT } from "../common/people/people.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
  resetPeopleRosters();
});

const ROOT = ["companies", "acme", "projects"].join("/");
const project = (id: string, creator: string) => ({
  id,
  name: id,
  company: "acme",
  description: "",
  status: "active",
  prdPath: `${ROOT}/${id}/prd.json`,
  storiesTotal: 2,
  storiesComplete: 1,
  provenance: { creator },
});

const ROSTER = [
  { personUid: "prs_01KQ2TZQMA8078CHPDWBAFPN0Z", displayName: "Corey Epstein", email: "corey@getindigo.ai" },
  { personUid: "prs_01KQ695MZHZBYFMVMPRTGFW34B", displayName: "Jacob Posel", email: "jacob@getindigo.ai" },
  { agentUid: "agt_686EVXD1DGG4B9XFB7WRAJYGD4", displayName: "Izzy", kind: "agent" },
];

function mountPage() {
  const ipc = async (command: string): Promise<unknown> => {
    if (command === "get_local_projects")
      return [
        project("p-id", "prs_01KQ2TZQMA8078CHPDWBAFPN0Z"),
        project("p-email", "corey@getindigo.ai"),
        project("p-handle", "corey"),
        project("p-name", "Corey Epstein"),
        project("p-jacob", "jacob-posel"),
        project("p-bot", "agt_686EVXD1DGG4B9XFB7WRAJYGD4"),
        project("p-gone", "prs_01ZZZZZZZZZZZZZZZZZZZZZZZZ"),
      ];
    if (command === "get_local_company_goals") return { objectives: [], initiatives: [] };
    return [];
  };
  const adapter = {
    projects: fakeProjectsApi(ipc),
    company: { listMembers: async () => ({ ok: true, value: ROSTER }) },
    messaging: { listContacts: async () => ({ ok: false, reason: "network", message: "x" }) },
  } as unknown as PlatformAdapter;
  host = document.createElement("div");
  document.body.append(host);
  component = mount(CompanyProjectsPage, { target: host, props: { adapter, slug: "acme" } });
  flushSync();
}

describe("Projects person filter (OWNER-R5)", () => {
  it("one entry per person with muted email; bots after people; no ids in the DOM", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mountPage();
    await expect.poll(() => host?.textContent ?? "").toContain("p-jacob");
    await expect.poll(() => host!.querySelector("button[data-testid=\"portfolio-owner-filter\"]")).not.toBeNull();
    const button = host!.querySelector<HTMLButtonElement>('[data-testid="portfolio-owner-filter"]')!;
    expect(button.tagName).toBe("BUTTON");
    button.click();
    flushSync();
    await expect.poll(() => host!.querySelectorAll('[role="option"]').length).toBe(5);
    const options = [...host!.querySelectorAll('[role="option"]')].map((o) => o.textContent?.replace("✓", "").replace(/\s+/g, " ").trim());
    expect(options).toEqual(["Anyone", "Corey Epstein corey@getindigo.ai", "Jacob Posel jacob@getindigo.ai", "Unknown person", "Izzy Bot"]);
    expect(host!.textContent ?? "").not.toMatch(RAW_PERSON_ID_IN_TEXT);
  });

  it("choosing a person matches every key of that person", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mountPage();
    await expect.poll(() => host?.textContent ?? "").toContain("p-jacob");
    await expect.poll(() => host!.querySelector('button[data-testid="portfolio-owner-filter"]')).not.toBeNull();
    host!.querySelector<HTMLButtonElement>('[data-testid="portfolio-owner-filter"]')!.click();
    flushSync();
    const corey = [...host!.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes("Corey"))!;
    corey.click();
    flushSync();
    const text = host!.textContent ?? "";
    for (const id of ["p-id", "p-email", "p-handle", "p-name"]) expect(text).toContain(id);
    for (const id of ["p-jacob", "p-bot", "p-gone"]) expect(text).not.toContain(id);
  });
});
