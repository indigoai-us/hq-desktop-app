import { describe, expect, it } from "vitest";

import type { LocalBotWorkerOption } from "@hq/platform";
import {
  canAdvance,
  canCreate,
  companyTemplates,
  firstBlockingStep,
  firstReadyRuntime,
  firstSentence,
  groupTemplates,
  initialDraft,
  introIssue,
  nameIssue,
  nextStep,
  prevStep,
  stepIssue,
  stepsFor,
  suggestBotName,
  suggestBotNames,
  templateBringsLine,
  templateCard,
  thinksWithLine,
  toCreateInput,
  type CreateBotContext,
  type CreateBotDraft,
} from "./create-bot-model.js";

const WORKERS: LocalBotWorkerOption[] = [
  {
    id: "iris-cx",
    path: "companies/indigo/workers/iris-cx",
    company: "indigo",
    description: "Customer support for Indigo. Handles tickets and refunds.",
    skillCount: 4,
  },
  {
    id: "setup",
    path: "core/workers/setup",
    name: "Setup",
    summary: "Walks you through HQ on day one.",
    description: "The onboarding helper.",
    skillCount: 1,
    source: "core",
  },
  {
    id: "ads-analyst",
    path: "companies/acme/workers/ads-analyst",
    company: "acme",
    summary: "Reads Meta and Google ad performance.",
    skillCount: 0,
  },
  {
    id: "zed",
    path: "companies/indigo/workers/zed",
    company: "indigo",
  },
];

function ctx(over: Partial<CreateBotContext> = {}): CreateBotContext {
  return {
    canLocal: true,
    canCloud: true,
    runtimeReady: { claude: true, codex: false, grok: true },
    existingNames: [],
    companies: [
      { companyUid: "cmp_indigo", label: "Indigo" },
      { companyUid: "cmp_acme", label: "Acme" },
    ],
    templates: WORKERS,
    ...over,
  };
}

function draft(over: Partial<CreateBotDraft> = {}, c: CreateBotContext = ctx()): CreateBotDraft {
  return { ...initialDraft(c), ...over };
}

describe("initialDraft", () => {
  it("defaults to a blank Local bot with the first signed-in runtime and a free name", () => {
    const d = initialDraft(ctx({ runtimeReady: { claude: false, codex: true, grok: true }, existingNames: ["assistant"] }));
    expect(d).toMatchObject({ kind: "blank", home: "local", runtime: "codex", name: "scout", memory: "synced", autoApprove: true });
    expect(d.companyUid).toBe("cmp_indigo");
  });

  it("opens on Cloud when this Mac cannot host a bot", () => {
    expect(initialDraft(ctx({ canLocal: false })).home).toBe("cloud");
    expect(firstReadyRuntime(null)).toBe("claude");
    expect(firstReadyRuntime({ claude: false, codex: false, grok: false })).toBe("claude");
  });
});

describe("names", () => {
  it("validates with the CLI's rule and rejects taken names", () => {
    expect(nameIssue("scout", [])).toBeNull();
    expect(nameIssue("  Scout ", [])).toBeNull();
    expect(nameIssue("", [])).toBe("Give your bot a name.");
    expect(nameIssue("Bad Name", [])).toContain("Lowercase letters");
    expect(nameIssue("a--b", [])).toContain("Lowercase letters");
    expect(nameIssue("scout", ["Scout"])).toBe("You already have a bot named scout.");
  });

  it("suggests the first free name and skips taken ones", () => {
    expect(suggestBotName([])).toBe("assistant");
    expect(suggestBotName(["assistant", "scout"])).toBe("buddy");
    expect(suggestBotName(["a"], ["a"])).toBe("a-2");
    expect(suggestBotNames(["assistant"], 3, "buddy")).toEqual(["scout", "atlas", "quill"]);
  });

});

describe("intro", () => {
  it("caps at 500 characters and rejects control characters", () => {
    expect(introIssue("")).toBeNull();
    expect(introIssue("Hi, I'm Scout. Ask me anything.")).toBeNull();
    expect(introIssue("x".repeat(500))).toBeNull();
    expect(introIssue("x".repeat(501))).toContain("500");
    expect(introIssue("hi[31m")).toContain("control characters");
  });
});

describe("templates", () => {
  it("summarises from summary, else the first sentence of the description", () => {
    expect(firstSentence("Customer support for Indigo. Handles tickets.")).toBe("Customer support for Indigo.");
    expect(firstSentence("  No period here  ")).toBe("No period here");
    expect(templateCard(WORKERS[0]!)).toEqual({
      id: "iris-cx",
      name: "Iris Cx",
      summary: "Customer support for Indigo.",
      skillCount: 4,
      company: "indigo",
      source: "company",
    });
    expect(templateCard(WORKERS[1]!)).toMatchObject({ name: "Setup", summary: "Walks you through HQ on day one.", company: null, source: "core" });
    expect(templateCard(WORKERS[3]!)).toMatchObject({ name: "Zed", summary: "", skillCount: null });
  });

  it("offers company workers only, never core ones", () => {
    expect(companyTemplates(WORKERS).map((w) => w.id)).toEqual(["iris-cx", "ads-analyst", "zed"]);
    // No explicit source: a worker without a company counts as core.
    expect(companyTemplates([{ id: "loose", path: "core/workers/loose" }])).toEqual([]);
    expect(companyTemplates([{ id: "tagged", path: "x", source: "company", company: "indigo" }]).map((w) => w.id)).toEqual(["tagged"]);
  });

  it("groups by company and searches across name/summary/company", () => {
    const groups = groupTemplates(companyTemplates(WORKERS));
    expect(groups.map((g) => [g.company, g.label, g.templates.map((t) => t.id)])).toEqual([
      ["acme", "Acme", ["ads-analyst"]],
      ["indigo", "Indigo", ["iris-cx", "zed"]],
    ]);
    expect(groupTemplates(WORKERS, "support").flatMap((g) => g.templates.map((t) => t.id))).toEqual(["iris-cx"]);
    expect(groupTemplates(WORKERS, "acme ads").flatMap((g) => g.templates.map((t) => t.id))).toEqual(["ads-analyst"]);
    expect(groupTemplates(WORKERS, "nothing-here")).toEqual([]);
  });

  it("describes what a template brings", () => {
    expect(templateBringsLine(templateCard(WORKERS[0]!))).toBe("Brings its instructions, 4 skills and Indigo policies.");
    expect(templateBringsLine(templateCard(WORKERS[1]!))).toBe("Brings its instructions and 1 skill.");
    expect(templateBringsLine(templateCard(WORKERS[3]!))).toBe("Brings its instructions and Indigo policies.");
    expect(templateBringsLine(null)).toBe("");
  });
});

describe("steps", () => {
  it("a Cloud draft ends at home; a Local draft continues to details", () => {
    expect(stepsFor({ home: "cloud" })).toEqual(["kind", "home"]);
    expect(stepsFor({ home: "local" })).toEqual(["kind", "home", "details"]);
    expect(nextStep("kind", { home: "local" })).toBe("home");
    expect(nextStep("home", { home: "cloud" })).toBeNull();
    expect(nextStep("home", { home: "local" })).toBe("details");
    expect(prevStep("kind", { home: "local" })).toBeNull();
    expect(prevStep("details", { home: "local" })).toBe("home");
  });

  it("kind needs a template pick when From a template is chosen", () => {
    const c = ctx();
    expect(stepIssue("kind", draft({ kind: "blank" }), c)).toBeNull();
    expect(stepIssue("kind", draft({ kind: "template" }), c)).toBe("Pick a template.");
    expect(stepIssue("kind", draft({ kind: "template", templateId: "iris-cx" }), c)).toBeNull();
  });

  it("home needs a signed-in runtime (Local) or a company (Cloud)", () => {
    const c = ctx();
    expect(stepIssue("home", draft({ home: "local", runtime: "claude" }), c)).toBeNull();
    expect(stepIssue("home", draft({ home: "local", runtime: "codex" }), c)).toBe("Codex is not signed in on this Mac.");
    expect(stepIssue("home", draft({ home: "local" }), ctx({ canLocal: false }))).toContain("can’t run on this computer");
    expect(stepIssue("home", draft({ home: "cloud", companyUid: "cmp_acme" }), c)).toBeNull();
    expect(stepIssue("home", draft({ home: "cloud", companyUid: "cmp_nope" }), c)).toBe("Pick a company.");
    expect(stepIssue("home", draft({ home: "cloud" }), ctx({ canCloud: false }))).toContain("No company");
    // The last step never "advances".
    expect(canAdvance("home", draft({ home: "cloud", companyUid: "cmp_acme" }), c)).toBe(false);
    expect(canAdvance("home", draft({ home: "local" }), c)).toBe(true);
  });

  it("details validates name then intro", () => {
    const c = ctx({ existingNames: ["scout"] });
    expect(stepIssue("details", draft({ name: "scout" }), c)).toBe("You already have a bot named scout.");
    expect(stepIssue("details", draft({ name: "buddy", intro: "x".repeat(501) }), c)).toContain("500");
    expect(stepIssue("details", draft({ name: "buddy", intro: "hello" }), c)).toBeNull();
  });

  it("canCreate needs every walked step valid, from any step", () => {
    const c = ctx();
    expect(canCreate(draft(), c)).toBe(true);
    expect(canCreate(draft({ runtime: "codex" }), c)).toBe(false);
    expect(firstBlockingStep(draft({ runtime: "codex" }), c)).toBe("home");
    expect(canCreate(draft({ kind: "template" }), c)).toBe(false);
    expect(firstBlockingStep(draft({ kind: "template" }), c)).toBe("kind");
    expect(canCreate(draft({ name: "" }), c)).toBe(false);
    expect(firstBlockingStep(draft({ name: "" }), c)).toBe("details");
    // Cloud ignores the details fields entirely.
    expect(canCreate(draft({ home: "cloud", name: "", companyUid: "cmp_indigo" }), c)).toBe(true);
    expect(firstBlockingStep(draft(), c)).toBeNull();
  });
});

describe("toCreateInput", () => {
  it("maps the draft to the CLI input and omits defaults", () => {
    expect(toCreateInput(draft({ name: " Scout " }))).toEqual({ name: "scout", runtime: "claude", autoApprove: true });
    expect(
      toCreateInput(
        draft({
          kind: "template",
          templateId: "iris-cx",
          name: "iris",
          runtime: "grok",
          model: " grok-4 ",
          autoApprove: false,
          intro: " Hi there. ",
          memory: "local",
        }),
      ),
    ).toEqual({
      name: "iris",
      runtime: "grok",
      autoApprove: false,
      model: "grok-4",
      worker: "iris-cx",
      intro: "Hi there.",
      memory: "local",
    });
    // A blank bot never carries a worker even if a stale templateId lingers.
    expect(toCreateInput(draft({ kind: "blank", templateId: "iris-cx" })).worker).toBeUndefined();
  });

  it("describes what the bot thinks with", () => {
    const c = ctx();
    expect(thinksWithLine(draft(), c)).toBe("thinks with Claude Code");
    expect(thinksWithLine(draft({ runtime: "grok", model: "grok-4" }), c)).toBe("thinks with Grok · grok-4");
    expect(thinksWithLine(draft({ home: "cloud", companyUid: "cmp_acme" }), c)).toBe("hosted by Acme");
  });
});
