/**
 * Wire types for the hq-pro-agents cloud-bot API (`/v1/agents`).
 *
 * TODO(desktop-agent-creation US-001/US-003): generate these from
 * hq-pro-agents `schemas/agent-status.schema.json` once it is on main (today
 * on branch feature/desktop-agent-creation-next-actions). Until then they are
 * written by hand from hq-pro-agents origin/main (`src/agents/handler.ts`
 * handleStatus, toAgentView, setupStateResponse; `src/agents/types.ts`) and
 * that branch's `nextActions` shape. `nextActions` is only sent when the
 * company has `agents.desktop-agent-creation`; a status without it is handled
 * by the reducer.
 *
 * Every type here is a read model: fields the client does not use are kept
 * loose (`unknown`) so a server addition never breaks a parse.
 */

/** The model a cloud bot thinks with. */
export type AgentBrain = "codex" | "grok" | "claude";

export const AGENT_BRAINS: readonly AgentBrain[] = ["codex", "grok", "claude"];

export type AgentSetupPhase =
  | "provisioning"
  | "waiting"
  | "failed"
  | "ready"
  | "deprovisioning"
  | "deprovisioned";

export type AgentSetupStepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "failed"
  | "done";

/**
 * Known setup step names. The server owns the order; a name this build does
 * not know is still carried through as a plain string.
 */
export type AgentSetupStepName =
  | "identity"
  | "membership"
  | "vault"
  | "runtime"
  | "codex-auth"
  | "sync"
  | "channels"
  | "audit"
  | "runtime-install";

export interface AgentSetupStep {
  name: AgentSetupStepName | (string & {});
  status: AgentSetupStepStatus;
  startedAt?: string;
  completedAt?: string;
  /** Present when status is `failed` or `waiting`. */
  lastError?: string;
}

export interface AgentSetupState {
  version: number;
  phase: AgentSetupPhase;
  idempotencyKey: string;
  steps: AgentSetupStep[];
  updatedAt: string;
  /**
   * Runtime install and brain sign-in are done; the bot can reply, possibly
   * before the audit (so `phase` may still be provisioning, waiting or
   * failed). Only sent for chat-first bots; false while deprovisioning.
   */
  chatReady?: boolean;
  /** `"chat-first"` on bots created through the desktop New bot flow with the flag on. */
  stepOrder?: string;
}

/** The public agent projection (`toAgentView`). Only the fields the app reads are typed. */
export interface AgentView {
  uid: string;
  name: string;
  slug: string;
  companyUid: string;
  provider?: string;
  codexModel?: string;
  profile?: { displayName?: string; title?: string; description?: string } | null;
  [key: string]: unknown;
}

/** Device-code sign-in relayed from the box (Codex and Grok). */
export interface AgentPairing {
  url: string;
  code: string;
  capturedAt?: string;
}

/** Durable outcome of a Claude paste-back sign-in. */
export interface AgentSignInResult {
  outcome: "accepted" | "rejected" | "unknown";
  reason: string;
  at: string;
}

interface NextActionBase {
  /** Stable id, e.g. `brain-signin:codex`. */
  id: string;
  /** `true` blocks ready; optional actions never do. */
  required: boolean;
  /** Plain-language line the surface shows as the action's heading. */
  title: string;
}

/** Codex or Grok subscription sign-in: show the code and an "Open sign-in page" link. */
export interface BrainSigninDeviceAction extends NextActionBase {
  kind: "brain_signin_device";
  brain?: AgentBrain;
  url: string;
  code: string;
  /** Absent or null when the box stamped no capture time. */
  expiresAt?: string;
}

/** The route an action posts to, as the server names it. */
export interface NextActionEndpoint {
  method: "POST";
  path: string;
}

/** Claude subscription sign-in: open the URL, paste `code#state` back. */
export interface BrainSigninPasteAction extends NextActionBase {
  kind: "brain_signin_paste";
  brain?: AgentBrain;
  url: string;
  /** POST /v1/agents/{uid}/login-code. */
  endpoint?: NextActionEndpoint;
}

/** The plan cannot host another bot. */
export interface PlanUpgradeAction extends NextActionBase {
  kind: "plan_upgrade";
  requiredPlan?: string;
  checkoutUrl?: string;
  /** Minor units (cents). */
  amount?: number;
  currency?: string;
}

/** A step failed or ran past its time limit. */
export interface RetryAction extends NextActionBase {
  kind: "retry";
  step?: string;
  /** Plain words, e.g. "Starting the bot's computer failed." */
  reason?: string;
  /** POST /v1/agents/{uid}/retry. */
  endpoint?: NextActionEndpoint;
}

/** Informational: vault download or first sync still running. */
export interface SyncInProgressAction extends NextActionBase {
  kind: "sync_in_progress";
  progress?: {
    phase?: string;
    filesDone?: number;
    filesTotal?: number;
    bytesDone?: number;
    bytesTotal?: number;
    startedAt?: string;
    updatedAt?: string;
  };
}

export type NextAction =
  | BrainSigninDeviceAction
  | BrainSigninPasteAction
  | PlanUpgradeAction
  | RetryAction
  | SyncInProgressAction;

export type NextActionKind = NextAction["kind"];

export const NEXT_ACTION_KINDS: readonly NextActionKind[] = [
  "brain_signin_device",
  "brain_signin_paste",
  "plan_upgrade",
  "retry",
  "sync_in_progress",
];

/** `201 {agent, setupState}` from POST /v1/agents (`200` on an idempotent replay). */
export interface AgentCreateResponse {
  agent: AgentView;
  setupState: AgentSetupState;
}

/** GET /v1/agents/{uid}/status. */
export interface AgentStatusResponse extends AgentCreateResponse {
  pairing: AgentPairing | null;
  /** Only on a `?brain=` poll that has no code yet. */
  signIn?: "starting" | "failed";
  signInResult?: AgentSignInResult;
  /** Server-owned next steps (US-001). Absent on servers that predate it. */
  nextActions?: unknown[];
}
