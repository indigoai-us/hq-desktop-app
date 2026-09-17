import { describe, expect, it } from "vitest";

import type { LocalBotWorkerOption } from "@hq/platform";
import {
  botHandle,
  canAdvance,
  canCreate,
  cloudNameIssue,
  companyTemplates,
  firstBlockingStep,
  firstReadyRuntime,
  firstSentence,
  groupTemplates,
  handleIssue,
  initialDraft,
  introIssue,
  nameIssue,
  nextStep,
  prevStep,
  scopeIssue,
  scopeLine,
  stepIssue,
  stepsFor,
  titleIssue,
  suggestBotName,
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
    ownerCompanies: [
      { slug: "indigo", label: "Indigo" },
      { slug: "acme", label: "Acme" },
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
  });

});

describe("title", () => {
  it("is optional, caps at 60 characters, and rejects control characters", () => {
    expect(titleIssue("")).toBeNull();
    expect(titleIssue("Ad account analyst")).toBeNull();
    expect(titleIssue("  x  ")).toBeNull();
    expect(titleIssue("x".repeat(60))).toBeNull();
    expect(titleIssue("x".repeat(61))).toContain("60");
    expect(titleIssue("ad\u001banalyst")).toContain("control characters");
  });

  it("never reaches the CLI input — `hq bot create` has no --title flag", () => {
    const input = toCreateInput(draft({ title: "Ad account analyst" }));
    expect(input).not.toHaveProperty("title");
    expect(input).toEqual({ name: "assistant", runtime: "claude", autoApprove: true });
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
  it("both homes walk kind → home → details", () => {
    // A Cloud bot is named HERE: the company channel's card that used to ask
    // for its name and handle is no longer shown to anyone.
    expect(stepsFor({ home: "cloud" })).toEqual(["kind", "home", "details"]);
    expect(stepsFor({ home: "local" })).toEqual(["kind", "home", "details"]);
    expect(nextStep("kind", { home: "local" })).toBe("home");
    expect(nextStep("home", { home: "cloud" })).toBe("details");
    expect(nextStep("details", { home: "cloud" })).toBeNull();
    expect(nextStep("home", { home: "local" })).toBe("details");
    expect(prevStep("kind", { home: "local" })).toBeNull();
    expect(prevStep("details", { home: "cloud" })).toBe("home");
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
    // The last step never "advances"; home is no longer the last one.
    expect(canAdvance("home", draft({ home: "cloud", companyUid: "cmp_acme" }), c)).toBe(true);
    expect(canAdvance("details", draft({ home: "cloud", companyUid: "cmp_acme" }), c)).toBe(false);
    expect(canAdvance("home", draft({ home: "local" }), c)).toBe(true);
  });

  it("details needs at least one of the owner's companies for a company bot (bot-kinds)", () => {
    const c = ctx();
    // "Who is it for?" moved off the home step, so home no longer blocks on it.
    expect(stepIssue("home", draft({ scope: "company" }), c)).toBeNull();
    expect(stepIssue("details", draft({ scope: "personal" }), c)).toBeNull();
    expect(stepIssue("details", draft({ scope: "company" }), c)).toBe("Pick at least one company.");
    expect(stepIssue("details", draft({ scope: "company", companySlugs: ["nope"] }), c)).toBe("Pick at least one company.");
    expect(stepIssue("details", draft({ scope: "company", companySlugs: ["indigo"] }), c)).toBeNull();
    expect(stepIssue("details", draft({ scope: "company", companySlugs: ["indigo", "acme"] }), c)).toBeNull();
    // Not in any company yet: the answer is personal, not a dead end.
    expect(scopeIssue({ scope: "company", companySlugs: [] }, { ownerCompanies: [] })).toContain("personal");
    expect(canCreate(draft({ scope: "company" }), c)).toBe(false);
    expect(firstBlockingStep(draft({ scope: "company" }), c)).toBe("details");
    // Cloud drafts never ask.
    expect(stepIssue("details", draft({ home: "cloud", companyUid: "cmp_acme", name: "Polar", scope: "company" }), c)).toBeNull();
  });

  it("cloud details validates the optional title too, after the name and handle", () => {
    const c = ctx();
    const cloud = (over: Partial<CreateBotDraft>) => draft({ home: "cloud", companyUid: "cmp_acme", ...over }, c);
    expect(stepIssue("details", cloud({ name: "Polar", title: "Ad account analyst" }), c)).toBeNull();
    expect(stepIssue("details", cloud({ name: "Polar", title: "x".repeat(61) }), c)).toContain("under 60");
    expect(stepIssue("details", cloud({ name: "Polar", title: "ad\u001banalyst" }), c)).toContain("control characters");
    // The name and the handle are still reported first: a title is optional.
    expect(stepIssue("details", cloud({ name: "", title: "x".repeat(61) }), c)).toBe("Give your bot a name.");
    expect(stepIssue("details", cloud({ name: "Polar", handle: "!!!", title: "x".repeat(61) }), c)).toContain(
      "Give your bot a handle",
    );
  });

  it("cloud details validates the name and the @handle it will be created under", () => {
    const c = ctx({ existingNames: ["scout"] });
    const cloud = (over: Partial<CreateBotDraft>) => draft({ home: "cloud", companyUid: "cmp_acme", ...over }, c);
    expect(stepIssue("details", cloud({ name: "" }), c)).toBe("Give your bot a name.");
    expect(stepIssue("details", cloud({ name: "Polar Bear" }), c)).toBeNull();
    expect(stepIssue("details", cloud({ name: "Polar", handle: "Not A Handle" }), c)).toBeNull();
    expect(stepIssue("details", cloud({ name: "Polar", handle: "!!!" }), c)).toContain("Give your bot a handle");
    // A cloud bot's name is a label, not the @handle: it is not held to the
    // handle's character rules, and a local bot's name never blocks it.
    expect(stepIssue("details", cloud({ name: "scout" }), c)).toBeNull();
    expect(stepIssue("details", cloud({ name: "x".repeat(61) }), c)).toContain("under 60");
  });

  it("the @handle follows the name until the person edits it", () => {
    expect(botHandle({ name: "Polar Bear", handle: "" })).toBe("polar-bear");
    expect(botHandle({ name: "Polar", handle: "@ice-bear" })).toBe("ice-bear");
    expect(botHandle({ name: "Polar", handle: "  " })).toBe("polar");
    expect(cloudNameIssue("  ")).toBe("Give your bot a name.");
    expect(handleIssue({ name: "Polar", handle: "" })).toBeNull();
    expect(handleIssue({ name: "", handle: "" })).toContain("Give your bot a handle");
  });

  it("details validates name, then title, then who it is for", () => {
    const c = ctx({ existingNames: ["scout"] });
    expect(stepIssue("details", draft({ name: "scout" }), c)).toBe("You already have a bot named scout.");
    expect(stepIssue("details", draft({ name: "buddy", title: "x".repeat(61) }), c)).toContain("60");
    expect(stepIssue("details", draft({ name: "buddy", intro: "x".repeat(501) }), c)).toContain("500");
    expect(stepIssue("details", draft({ name: "buddy", title: "Ad account analyst" }), c)).toBeNull();
    // The name is reported before the company choice.
    expect(stepIssue("details", draft({ name: "scout", scope: "company" }), c)).toBe("You already have a bot named scout.");
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
    // A cloud bot is never created under a name nobody chose.
    expect(canCreate(draft({ home: "cloud", name: "", companyUid: "cmp_indigo" }), c)).toBe(false);
    expect(firstBlockingStep(draft({ home: "cloud", name: "", companyUid: "cmp_indigo" }), c)).toBe("details");
    expect(canCreate(draft({ home: "cloud", name: "Polar", companyUid: "cmp_indigo" }), c)).toBe(true);
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
      memory: "local"
    });
    // A blank bot never carries a worker even if a stale templateId lingers.
    expect(toCreateInput(draft({ kind: "blank", templateId: "iris-cx" })).worker).toBeUndefined();
  });

  it("passes the kind and, for company bots, each company slug once (bot-kinds)", () => {
    expect(toCreateInput(draft({ scope: "company", companySlugs: ["indigo", " acme ", "indigo", ""] }))).toEqual({
      name: "assistant",
      runtime: "claude",
      autoApprove: true,
      kind: "company",
      companies: ["indigo", "acme"],
    });
    // Personal is the CLI default and is not passed (older hq compatibility);
    // slugs picked and then switched back to personal never leak through.
    const personal = toCreateInput(draft({ scope: "personal", companySlugs: ["indigo"] }));
    expect(personal.kind).toBeUndefined();
    expect(personal.companies).toBeUndefined();
    const c = ctx();
    expect(scopeLine(draft({ scope: "personal" }), c)).toBe("acts as you");
    expect(scopeLine(draft({ scope: "company", companySlugs: ["indigo", "acme"] }), c)).toBe("for Indigo and Acme");
    expect(scopeLine(draft({ home: "cloud" }), c)).toBe("");
  });

  it("describes what the bot thinks with", () => {
    const c = ctx();
    expect(thinksWithLine(draft(), c)).toBe("thinks with Claude Code");
    expect(thinksWithLine(draft({ runtime: "grok", model: "grok-4" }), c)).toBe("thinks with Grok · grok-4");
    expect(thinksWithLine(draft({ home: "cloud", companyUid: "cmp_acme" }), c)).toBe("hosted by Acme");
  });
});
