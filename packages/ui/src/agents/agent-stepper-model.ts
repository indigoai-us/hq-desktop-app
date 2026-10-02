/**
 * Six-step New agent draft (Runtime → Verify) mapped onto the existing
 * create-bot model. Local create still goes through `toCreateInput`; hosted
 * create through `CloudBotDraft`. No new backend contract.
 *
 * Grant levels are read and write only. Probe text is redacted before paint
 * so an enroll token or secret value never reaches the log.
 */
import type { LocalBotCreateInput } from "@hq/platform";
import type { CloudBotDraft } from "../chat/lifecycle-entry-points.js";
import {
  botHandle,
  displayNameIssue,
  initialDraft,
  localHandleIssue,
  toCreateInput,
  type BotRuntime,
  type CreateBotContext,
  type CreateBotDraft,
} from "../chat/create-bot/create-bot-model.js";

export const AGENT_STEPS = ["runtime", "identity", "membership", "access", "capabilities", "verify"] as const;
export type AgentStep = (typeof AGENT_STEPS)[number];

export type AgentPlace = "local" | "hosted" | "external";
export type BoxSize = "basic" | "power" | "dev";
export type MemberRole = "member" | "guest";
export type ModelChoice = "haiku" | "sonnet" | "opus";
export type SlackPostMode = "ask" | "auto" | "off";

export interface CompanyChoice {
  id: string;
  label: string;
  detail: string;
  joined: boolean;
  role: MemberRole;
}

export interface ChannelChoice {
  id: string;
  label: string;
  detail: string;
  joined: boolean;
  locked?: boolean;
}

export interface VaultGrant {
  path: string;
  note: string;
  read: boolean;
  /** Write implies read. There is no admin level. */
  write: boolean;
}

export interface SecretAllow {
  name: string;
  note: string;
  granted: boolean;
  blocked?: boolean;
}

export interface SkillChoice {
  id: string;
  title: string;
  detail: string;
  selected: boolean;
  blocked?: boolean;
}

export interface ToolChoice {
  id: string;
  title: string;
  detail: string;
  selected: boolean;
  slack?: boolean;
}

export interface ProbeLine {
  at: string;
  ok: boolean;
  text: string;
  detail?: string;
}

export interface AgentStepperDraft {
  place: AgentPlace;
  size: BoxSize;
  region: string;
  runtime: BotRuntime;
  name: string;
  handle: string;
  description: string;
  intro: string;
  ownerLabel: string;
  companies: CompanyChoice[];
  channels: ChannelChoice[];
  grants: VaultGrant[];
  secrets: SecretAllow[];
  skills: SkillChoice[];
  tools: ToolChoice[];
  slackPost: SlackPostMode;
  model: ModelChoice;
  budgetPerDay: string;
  probe: ProbeLine[];
  probeStatus: "idle" | "running" | "passed" | "failed";
}

export const STEP_COPY: Record<AgentStep, { title: string; idle: string; heading: string }> = {
  runtime: { title: "Runtime", idle: "Where it runs", heading: "Runtime" },
  identity: { title: "Identity", idle: "Name, handle, mark", heading: "Identity" },
  membership: { title: "Membership", idle: "Companies and channels", heading: "Membership" },
  access: { title: "Access", idle: "Vault paths and secrets", heading: "Access" },
  capabilities: { title: "Capabilities", idle: "Skills, tools, model", heading: "Capabilities" },
  verify: { title: "Verify", idle: "Live probe, then chat", heading: "Verify" },
};

const ENROLL_MASK = "••••";

/** Always a mask. Never return a real enroll token. */
export function enrollPlaceholder(): string {
  return ENROLL_MASK;
}

/** Strip token-shaped and secret-shaped values before they are rendered. */
export function redactProbeText(raw: string): string {
  return raw
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, ENROLL_MASK)
    .replace(/\b(enroll[_ -]?token|api[_ -]?key|secret|password|token)\b\s*[:=]\s*\S+/gi, "$1: " + ENROLL_MASK)
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, ENROLL_MASK);
}

export function stepIndex(step: AgentStep): number {
  return AGENT_STEPS.indexOf(step);
}

export function nextAgentStep(step: AgentStep): AgentStep | null {
  return AGENT_STEPS[stepIndex(step) + 1] ?? null;
}

export function prevAgentStep(step: AgentStep): AgentStep | null {
  const i = stepIndex(step);
  return i > 0 ? AGENT_STEPS[i - 1]! : null;
}

export function emptyDraft(partial?: Partial<AgentStepperDraft>): AgentStepperDraft {
  return {
    place: "hosted",
    size: "power",
    region: "us-east-1",
    runtime: "claude",
    name: "",
    handle: "",
    description: "",
    intro: "",
    ownerLabel: "You",
    companies: [],
    channels: [],
    grants: [],
    secrets: [],
    skills: [],
    tools: [],
    slackPost: "ask",
    model: "sonnet",
    budgetPerDay: "12",
    probe: [],
    probeStatus: "idle",
    ...partial,
  };
}

export function displayHandle(draft: Pick<AgentStepperDraft, "name" | "handle">): string {
  return botHandle({ name: draft.name, handle: draft.handle });
}

export function runtimeSummary(draft: AgentStepperDraft): string {
  if (draft.place === "local") return "Local on this Mac";
  if (draft.place === "external") return "External bot";
  const size = draft.size[0]!.toUpperCase() + draft.size.slice(1);
  return `Hosted fleet agent · HQ cloud box · ${size} · ${draft.region}`;
}

export function accessSummary(draft: AgentStepperDraft): string {
  const read = draft.grants.filter((g) => g.read || g.write).length;
  const write = draft.grants.filter((g) => g.write).length;
  const secrets = draft.secrets.filter((s) => s.granted && !s.blocked).length;
  const blocked = draft.secrets.filter((s) => s.blocked).length;
  return `${read} paths read, ${write} write · ${secrets} secrets${blocked ? ` · ${blocked} blocked` : ""}`;
}

/** Write turns read on. Clearing read clears write. */
export function setGrant(grant: VaultGrant, level: "read" | "write", on: boolean): VaultGrant {
  if (level === "write") return { ...grant, write: on, read: on ? true : grant.read };
  return { ...grant, read: on, write: on ? grant.write : false };
}

export function identityIssue(draft: AgentStepperDraft, existingNames: readonly string[]): string | null {
  return displayNameIssue(draft.name) ?? localHandleIssue({ name: draft.name, handle: draft.handle }, existingNames);
}

export function membershipIssue(draft: AgentStepperDraft): string | null {
  if (draft.place === "local") return null;
  if (!draft.companies.some((c) => c.joined)) return "Pick at least one company.";
  return null;
}

export function canContinue(step: AgentStep, draft: AgentStepperDraft, existingNames: readonly string[]): boolean {
  if (step === "runtime") return true;
  if (step === "identity") return identityIssue(draft, existingNames) === null;
  if (step === "membership") return membershipIssue(draft) === null;
  if (step === "verify") return draft.probeStatus === "passed";
  return true;
}

export function subcopy(step: AgentStep, name: string): string {
  const who = name.trim() || "this agent";
  switch (step) {
    case "runtime":
      return "Pick where the agent lives before anything is named or paid for. Local bots act as you; hosted and external bots get their own identity.";
    case "identity":
      return "Who this agent is. The name and handle are permanent; everything else can change from the profile.";
    case "membership":
      return `Which companies and channels ${who} belongs to. Membership is written at Verify, in one step with the identity.`;
    case "access":
      return `What ${who} can read and write in the vault. Start narrow; you can widen this later from the agent's profile.`;
    case "capabilities":
      return `What ${who} can do. Skills come from the company skill list; a skill that needs a grant you did not give stays blocked here.`;
    case "verify":
      return "The agent confirmed each capability from its own runtime. Nothing here was assumed from the grants alone.";
  }
}

/** Map onto a create-bot draft so local create reuses `toCreateInput`. */
export function toCreateBotDraft(
  draft: AgentStepperDraft,
  ctx: Pick<CreateBotContext, "canLocal" | "canCloud" | "existingNames" | "companies" | "runtimeReady">,
): CreateBotDraft {
  const base = initialDraft(ctx);
  const home = draft.place === "local" ? "local" : "cloud";
  const company = draft.companies.find((c) => c.joined);
  return {
    ...base,
    home,
    runtime: draft.runtime,
    size: draft.place === "hosted" ? draft.size : "",
    name: draft.name.trim() || base.name,
    handle: draft.handle.trim(),
    intro: draft.intro.trim(),
    title: draft.description.trim().slice(0, 60),
    scope: home === "local" && company ? "company" : "personal",
    companySlugs: company ? [company.id] : [],
    companyUid: company?.id ?? base.companyUid,
    model: draft.model,
    autoApprove: draft.slackPost === "auto",
  };
}

export function toLocalInput(
  draft: AgentStepperDraft,
  ctx: Pick<CreateBotContext, "canLocal" | "canCloud" | "existingNames" | "companies" | "runtimeReady">,
): LocalBotCreateInput {
  return toCreateInput(toCreateBotDraft(draft, ctx));
}

export function toCloudDraft(draft: AgentStepperDraft): CloudBotDraft {
  const title = draft.description.trim().slice(0, 60);
  return {
    name: draft.name.trim(),
    handle: displayHandle(draft),
    ...(title ? { title } : {}),
    runtime: draft.runtime,
    size: draft.size,
    authMode: "subscription",
  };
}

export function probeScript(draft: AgentStepperDraft, started: Date): ProbeLine[] {
  const stamp = (ms: number) => new Date(started.getTime() + ms).toISOString().slice(11, 21);
  const handle = displayHandle(draft) || "agent";
  const company = draft.companies.find((c) => c.joined)?.label ?? "company";
  const channels = draft.channels.filter((c) => c.joined).map((c) => c.label).join(" ") || "none";
  const grants = draft.grants.filter((g) => g.read || g.write).length;
  const secrets = draft.secrets.filter((s) => s.granted && !s.blocked).map((s) => s.name).join(" · ") || "none";
  const lines: ProbeLine[] = [
    { at: stamp(0), ok: true, text: "identity minted", detail: `${handle} · @${handle}` },
    { at: stamp(300), ok: true, text: "membership written", detail: `${company} · ${channels}` },
    { at: stamp(800), ok: true, text: `vault grants applied (${grants})`, detail: "read or write only" },
    { at: stamp(1200), ok: true, text: "secrets bound", detail: `${secrets} · mounted per run` },
    { at: stamp(3600), ok: true, text: "runtime booted", detail: runtimeSummary(draft) },
    { at: stamp(3900), ok: true, text: "probe message sent", detail: "reply ACK and list what you can read" },
    draft.place === "external"
      ? { at: stamp(5700), ok: true, text: "external enroll acknowledged", detail: `code stays on the host · ${enrollPlaceholder()}` }
      : { at: stamp(5700), ok: true, text: "reply received", detail: "ACK · paths readable · secrets mount by name only" },
  ];
  return lines.map((line) => ({
    ...line,
    text: redactProbeText(line.text),
    ...(line.detail ? { detail: redactProbeText(line.detail) } : {}),
  }));
}

export function continueLabel(step: AgentStep): string {
  if (step === "capabilities") return "Run the probe";
  if (step === "verify") return "Start chatting";
  const next = nextAgentStep(step);
  return next ? `Continue to ${STEP_COPY[next].title}` : "Continue";
}

export function stepSubtitle(step: AgentStep, draft: AgentStepperDraft, current: AgentStep): string {
  const past = stepIndex(step) < stepIndex(current) || (step !== current && draft.probeStatus === "passed" && step === "verify");
  const done = stepIndex(step) < stepIndex(current);
  if (!done && step !== current) return STEP_COPY[step].idle;
  if (step === "runtime" && (done || step === current)) return runtimeSummary(draft).split(" · ")[0] ?? STEP_COPY.runtime.idle;
  if (step === "identity" && done) {
    const handle = displayHandle(draft);
    return handle ? `${draft.name.trim()} · @${handle}` : STEP_COPY.identity.idle;
  }
  if (step === "membership" && done) {
    const company = draft.companies.find((c) => c.joined);
    return company ? `${company.label} · ${company.role === "guest" ? "Guest" : "Member"}` : STEP_COPY.membership.idle;
  }
  if (step === "access" && done) return accessSummary(draft);
  if (step === "capabilities" && done) {
    const n = draft.skills.filter((s) => s.selected).length;
    return `${n} skills · ${draft.model[0]!.toUpperCase()}${draft.model.slice(1)}`;
  }
  if (past && step === "verify") return "Live probe, then chat";
  return STEP_COPY[step].idle;
}
