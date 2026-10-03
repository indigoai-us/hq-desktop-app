// @vitest-environment happy-dom
/**
 * OWNER-R12: the worker pane shows details, skills, a file explorer and
 * policies from the worker's own folder. Fixtures follow real worker.yaml
 * shapes with placeholder names.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, unavailable } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";
import WorkerDetailPane from "./WorkerDetailPane.svelte";
import { workerRowFromLibrary, type WorkerRow } from "./brain-model.js";
import { parseWorkerYaml, workerYamlDetail } from "./worker-detail.js";

const DIR = "companies/acme/workers/delivery";

const MANY_SKILLS_YAML = `worker:
  id: delivery
  name: "Delivery Manager - Acme"
  type: OpsWorker
  version: "1.0"
  status: active
  company: acme
  team: ops-team
  description: "Runs the delivery lifecycle."

description: |
  Delivery operator.
    0. onboard — set up a client

execution:
  mode: scheduled
  model: opus
  schedule: "0 7 * * 1-5"        # 07:00 local, Mon-Fri
  timezone: "America/New_York"
  max_runtime: 30m
  human_checkpoints:
    - id: final
      when: "merging to production"
      rule: "Do not merge until the owner approves."

context:
  base:
    - companies/acme/SUMMARY.md
    - companies/acme/policies/acme-portal.md
  exclude:
    - ".env*"

knowledge:
  - companies/acme/projects/delivery/README.md

skills:
  - name: onboard
    description: "Onboard a brand-new client end to end."
    args:
      - client_slug: "client slug"
  - name: build-deck
    description: "Build a standalone client deck."
  - name: invoicing
    description: "Bill a signed client."
    file: skills/billing/SKILL.md

verification:
  post_execute:
    - check: grounded
      description: "Every fact traces to a source."
  approval_required: true
`;

const NO_SKILLS_YAML = `worker:
  id: quiet
  name: "Quiet Worker"
  type: CodeWorker
  team: dev-team

execution:
  mode: on_demand
  max_runtime: 30m
`;

const PARKED_YAML = `worker:
  id: monitor
  name: "Request Monitor"
  type: GtmWorker
  status: parked
  description: "Parked monitor."

execution:
  mode: manual
  schedule: null
  runtime: hq-agent-jobs
  max_runtime: 20m
`;

function row(over: Partial<WorkerRow> = {}): WorkerRow {
  return {
    id: "delivery",
    name: "Delivery Manager - Acme",
    description: "Runs the delivery lifecycle.",
    path: `${DIR}/`,
    scope: "company",
    status: "active",
    tools: [],
    skills: [],
    parked: false,
    mine: true,
    scheduled: false,
    live: false,
    lastRun: "",
    ...over,
  };
}

type Tree = Record<string, Array<{ name: string; path: string; isDir: boolean; hasChildren?: boolean }>>;

function filesFor(yaml: string | null, tree: Tree, content: Record<string, string> = {}) {
  return {
    listDir: vi.fn(async (path: string) => (tree[path] ? ok(tree[path] as never) : unavailable("no such folder"))),
    getFileContent: vi.fn(async (path: string) => {
      if (path === `${DIR}/worker.yaml` && yaml !== null) return ok(yaml);
      if (content[path] !== undefined) return ok(content[path]!);
      return unavailable("read failed");
    }),
  };
}

const NESTED: Tree = {
  [DIR]: [
    { name: "knowledge", path: `${DIR}/knowledge`, isDir: true, hasChildren: true },
    { name: "policies", path: `${DIR}/policies`, isDir: true, hasChildren: true },
    { name: "skills", path: `${DIR}/skills`, isDir: true, hasChildren: true },
    { name: ".env", path: `${DIR}/.env`, isDir: false },
    { name: ".env.local", path: `${DIR}/.env.local`, isDir: false },
    { name: "api-credentials.json", path: `${DIR}/api-credentials.json`, isDir: false },
    { name: "runbook.md", path: `${DIR}/runbook.md`, isDir: false },
    { name: "worker.yaml", path: `${DIR}/worker.yaml`, isDir: false },
  ],
  [`${DIR}/skills`]: [
    { name: "onboard.md", path: `${DIR}/skills/onboard.md`, isDir: false },
    { name: "build-deck", path: `${DIR}/skills/build-deck`, isDir: true, hasChildren: true },
    { name: "billing", path: `${DIR}/skills/billing`, isDir: true, hasChildren: true },
  ],
  [`${DIR}/knowledge`]: [
    { name: "templates", path: `${DIR}/knowledge/templates`, isDir: true, hasChildren: true },
  ],
  [`${DIR}/knowledge/templates`]: [
    { name: "deck.html", path: `${DIR}/knowledge/templates/deck.html`, isDir: false },
  ],
  [`${DIR}/policies`]: [
    { name: "acme-no-send.md", path: `${DIR}/policies/acme-no-send.md`, isDir: false },
    { name: "acme-tone.md", path: `${DIR}/policies/acme-tone.md`, isDir: false },
  ],
};

const POLICY_FILES = {
  [`${DIR}/policies/acme-no-send.md`]: "---\ntitle: Never send without approval\nenforcement: hard\n---\nBody.",
  [`${DIR}/policies/acme-tone.md`]: "---\ntitle: Keep a plain tone\nenforcement: soft\n---\nBody.",
};

const noop = () => {};

describe("OWNER-R12 worker.yaml details", () => {
  it("reads only fields that have a value, with checkpoints in plain words", () => {
    const d = workerYamlDetail(MANY_SKILLS_YAML, DIR);
    expect(d.status).toBe("active");
    expect(d.rows).toEqual([
      { label: "Type", value: "OpsWorker" },
      { label: "Team", value: "ops-team" },
      { label: "Model", value: "opus" },
      { label: "Mode", value: "scheduled" },
      { label: "Schedule", value: "0 7 * * 1-5" },
      { label: "Time zone", value: "America/New_York" },
      { label: "Max runtime", value: "30m" },
      { label: "Approval", value: "Required before it finishes" },
    ]);
    expect(d.asksBefore).toEqual(["Asks for approval merging to production"]);
    expect(d.contextFiles).toEqual(["companies/acme/SUMMARY.md", "companies/acme/policies/acme-portal.md"]);
    expect(d.knowledgeFiles).toEqual(["companies/acme/projects/delivery/README.md"]);
    expect(d.skills.map((s) => s.name)).toEqual(["onboard", "build-deck", "invoicing"]);
    expect(d.skills[2]!.file).toBe(`${DIR}/skills/billing/SKILL.md`);
  });

  it("a parked worker with an empty schedule has no schedule row", () => {
    const d = workerYamlDetail(PARKED_YAML, DIR);
    expect(d.status).toBe("parked");
    expect(d.rows.map((r) => r.label)).toEqual(["Type", "Runtime", "Mode", "Max runtime"]);
  });

  it("parses block text and nested lists without bleeding keys", () => {
    const doc = parseWorkerYaml(MANY_SKILLS_YAML);
    expect(typeof doc.description).toBe("string");
    expect(String(doc.description)).toContain("0. onboard");
    expect(Object.keys(doc)).toEqual(["worker", "description", "execution", "context", "knowledge", "skills", "verification"]);
  });
});

describe("OWNER-R12 worker status in the list", () => {
  it("a parked worker shows Parked, not its scope", async () => {
    const workers = [
      { id: "a", name: "A", type: "Ops", description: "", scope: "company" as const, company: "acme", status: "active", path: "companies/acme/workers/a/" },
      { id: "b", name: "B", type: "Gtm", description: "", scope: "company" as const, company: "acme", status: "parked", path: "companies/acme/workers/b/" },
    ];
    expect(workerRowFromLibrary(workers[1]!).status).toBe("parked");
    const library = { getCompany: vi.fn(async () => ok({ workers, skills: [] })) };
    const c = mount(BrainPage, {
      target: document.body,
      props: { page: "workers", slug: "acme-r12-list", files: null, library: library as never, shell: null, settings: null },
    });
    try {
      await vi.waitFor(() => expect(document.querySelectorAll("[data-testid='worker-row']").length).toBe(2));
      const labels = Array.from(document.querySelectorAll("[data-testid='worker-row-status']")).map((el) => el.textContent?.trim());
      expect(labels).toEqual(["Active", "Parked"]);
      // The pane shows the same status as the list.
      expect(document.querySelector("[data-testid='worker-status']")?.textContent?.trim()).toBe("Active");
    } finally {
      await unmount(c);
    }
  });
});

describe("OWNER-R12 WorkerDetailPane", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  function mountPane(files: ReturnType<typeof filesFor> | null, over: Partial<WorkerRow> = {}, onrun = vi.fn()) {
    component = mount(WorkerDetailPane, {
      target: document.body,
      props: { worker: row(over), slug: "acme", files: files as never, onrun, onopenclaude: noop, onedit: noop, onclose: noop },
    });
    return onrun;
  }

  it("header shows at once; many skills each with a file and a per-skill Run", async () => {
    const files = filesFor(MANY_SKILLS_YAML, NESTED, POLICY_FILES);
    const onrun = mountPane(files);
    flushSync();
    expect(document.querySelector("h2")?.textContent).toBe("Delivery Manager - Acme");
    expect(document.querySelector("[data-testid='worker-scope']")?.textContent).toBe("Company");
    expect(document.querySelector("[data-testid='worker-status']")?.textContent).toBe("Active");
    await vi.waitFor(() => expect(document.querySelectorAll("[data-testid='worker-skill']").length).toBe(3));
    const fileLinks = Array.from(document.querySelectorAll("[data-testid='worker-skill-file']")).map((el) => el.textContent);
    expect(fileLinks).toEqual(["skills/onboard.md", "skills/build-deck/SKILL.md", "skills/billing/SKILL.md"]);
    (document.querySelectorAll("[data-testid='worker-skill-run']")[1] as HTMLButtonElement).click();
    expect(onrun).toHaveBeenCalledWith("/run delivery build-deck", "build-deck");
    const details = document.querySelector("[data-testid='worker-details']")?.textContent ?? "";
    expect(details).toContain("ops-team");
    expect(details).toContain("Asks for approval merging to production");
    expect(details).not.toContain("—");
  });

  it("a worker with no skills says so; no Run per skill", async () => {
    mountPane(filesFor(NO_SKILLS_YAML, { [DIR]: [] }), { id: "quiet", name: "Quiet Worker" });
    await vi.waitFor(() => expect(document.querySelector("[data-testid='worker-skills-none']")).toBeTruthy());
    expect(document.querySelectorAll("[data-testid='worker-skill-run']").length).toBe(0);
    expect(document.querySelector("[data-testid='worker-policies']")).toBeNull();
  });

  it("a parked worker shows Parked in the header", async () => {
    mountPane(filesFor(PARKED_YAML, { [DIR]: [] }), { status: "parked", parked: true });
    expect(document.querySelector("[data-testid='worker-status']")?.textContent).toBe("Parked");
  });

  it("files: nested folders as on disk; env and credential files never appear", async () => {
    mountPane(filesFor(MANY_SKILLS_YAML, NESTED, POLICY_FILES));
    await vi.waitFor(() => expect(document.querySelectorAll("[data-testid='worker-files'] [data-testid='vault-tree-row']").length).toBeGreaterThan(0));
    const names = () => Array.from(document.querySelectorAll("[data-testid='worker-files'] [data-testid='vault-tree-row']")).map((el) => el.getAttribute("data-tree-path"));
    expect(names()).toEqual([
      `${DIR}/knowledge`,
      `${DIR}/policies`,
      `${DIR}/skills`,
      `${DIR}/runbook.md`,
      `${DIR}/worker.yaml`,
    ]);
    (document.querySelector(`[data-tree-path='${DIR}/knowledge']`) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector(`[data-tree-path='${DIR}/knowledge/templates']`)).toBeTruthy());
    expect(document.body.innerHTML).not.toContain(".env");
    expect(document.body.innerHTML).not.toContain("api-credentials");
  });

  it("policies list by title with their enforcement level", async () => {
    mountPane(filesFor(MANY_SKILLS_YAML, NESTED, POLICY_FILES));
    await vi.waitFor(() => expect(document.querySelectorAll("[data-testid='worker-policy']").length).toBe(2));
    const text = Array.from(document.querySelectorAll("[data-testid='worker-policy']")).map((el) => el.textContent?.replace(/\s+/g, " ").trim());
    expect(text).toEqual(["Never send without approval Hard", "Keep a plain tone Soft"]);
  });

  it("a failed worker.yaml read shows its own failed state and Try again; files still load", async () => {
    const files = filesFor(null, NESTED, POLICY_FILES);
    mountPane(files);
    await vi.waitFor(() => expect(document.querySelector("[data-testid='worker-details-failed']")).toBeTruthy());
    expect(document.querySelector("[data-testid='worker-skills-failed']")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelectorAll("[data-testid='worker-files'] [data-testid='vault-tree-row']").length).toBe(5));
    files.getFileContent.mockImplementation(async (path: string) => (path.endsWith("worker.yaml") ? ok(NO_SKILLS_YAML) : ok("")));
    (Array.from(document.querySelectorAll("[data-testid='worker-details-failed'] button"))[0] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("[data-testid='worker-skills-none']")).toBeTruthy());
  });
});
