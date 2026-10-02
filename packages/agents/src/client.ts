/**
 * REST client for creating and setting up cloud bots (hq-pro-agents).
 *
 * Framework-free and host-free: the caller hands in a Fetch-compatible
 * function from its platform adapter. On desktop that function goes through
 * the Rust `hq_pro_fetch` command (the Cognito token never reaches the
 * webview); on the web build it is the browser fetch with the session's
 * headers. Paths are relative (`/v1/agents/...`); the adapter's fetch owns
 * the base URL and the auth header.
 *
 * Nothing here imports Tauri or Svelte, so the web build of apps/work can
 * reuse it unchanged (desktop-agent-creation US-010).
 */

import type {
  AgentBrain,
  AgentCreateResponse,
  AgentStatusResponse,
} from "./types.js";

/** The slice of the Fetch API this client needs. */
export type AgentsFetch = (
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Which way a refused or failed call went, in terms the UI can act on. */
export type AgentsErrorKind =
  /** 403 AGENT_PLAN_LIMIT: the company's plan cannot host another bot. */
  | "plan_limit"
  /** 403 without a plan code: the caller lacks the `createAgents` capability. */
  | "forbidden"
  /** 403 CLAUDE_PROVIDER_NOT_ENABLED. */
  | "brain_not_enabled"
  /** 409 AGENT_PROVISION_QUOTE_STALE: the size or price moved since the quote. */
  | "quote_stale"
  /** 409 slug conflict: the @handle is taken in that company. */
  | "handle_taken"
  /** 404: not a member of the company, or no such agent. */
  | "not_found"
  /** 400: the request was refused as invalid. */
  | "invalid"
  /** 401: the session has expired. */
  | "unauthorized"
  /** 5xx or any other status. */
  | "server"
  /** The request never got an HTTP answer. */
  | "network";

export interface AgentsError {
  kind: AgentsErrorKind;
  /** HTTP status; 0 for a transport failure. */
  status: number;
  /** Server error code when present (`AGENT_PLAN_LIMIT`, ...). */
  code?: string;
  /** The server's own sentence, when it sent one. */
  serverMessage?: string;
  /** plan_limit only. */
  requiredPlan?: string;
  checkoutUrl?: string;
  amountMinor?: number;
  currency?: string;
}

export type AgentsResult<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; error: AgentsError };

/**
 * The size and price the person saw, echoed back so the server can refuse a
 * stale quote (409) instead of charging a different amount. Comes from
 * GET /v1/agents/provision-options.
 */
export interface AgentCreateQuote {
  instanceType: string;
  netMonthlyCents: number;
  catalogVersion: string;
}

export interface CreateAgentInput {
  companyUid: string;
  name: string;
  /** The @handle, without the `@`. */
  slug: string;
  brain: AgentBrain;
  /**
   * One key per wizard session. A double-click or a retry after a lost
   * response replays the same create (200) instead of making a second bot.
   */
  idempotencyKey: string;
  quote: AgentCreateQuote;
  /** Attribution for the create-attempt funnel, e.g. `desktop_new_bot`. */
  surface: string;
  /** Skip Slack at create time. Defaults to true (decision 1). */
  deferChannels?: boolean;
}

/** An action the setup card can run against a bot that already exists. */
export type AgentSetupActionRequest =
  | { kind: "login-code"; code: string }
  | { kind: "retry" }
  | { kind: "authorize-brain"; brain: AgentBrain };

/**
 * Can the caller add a cloud bot to this company, read before the wizard
 * offers it. The provision-options quote is the probe: it refuses (403)
 * exactly when the caller lacks the `createAgents` capability.
 *
 * `admins` and the plan block are additive fields requested from
 * hq-pro-agents (desktop-agent-creation US-005). Until the server sends them
 * the role state names no admin and a plan limit is first seen at create
 * (403 AGENT_PLAN_LIMIT).
 */
export type CreateAvailability =
  | { state: "available" }
  | { state: "role"; admins: string[] }
  | {
      state: "plan";
      requiredPlan?: string;
      checkoutUrl?: string;
      amountMinor?: number;
      currency?: string;
    }
  | { state: "not_member" }
  /** The probe failed; the card stays usable and create reports any refusal. */
  | { state: "unknown"; error: AgentsError };

export const AGENTS_PATHS = {
  create: "/v1/agents",
  provisionOptions: (companyUid: string) =>
    `/v1/agents/provision-options?companyUid=${encodeURIComponent(companyUid)}`,
  status: (agentUid: string, brain?: AgentBrain) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/status${
      brain ? `?brain=${encodeURIComponent(brain)}` : ""
    }`,
  loginCode: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/login-code`,
  retry: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/retry`,
  authorizeBrain: (agentUid: string, brain: AgentBrain) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/brains/${encodeURIComponent(brain)}/authorize`,
} as const;

/**
 * The model fields that pick a brain on an agents-v2 box. Mirrors the
 * lifecycle `create_agent` card (hq-pro-core
 * src/lifecycle/actions/create-agent-invoke.ts) so a bot made here is the same
 * bot the card made: Codex is the server default, Grok and Claude are chosen
 * through `codexModel`.
 */
export function brainCreateFields(brain: AgentBrain): Record<string, string> {
  switch (brain) {
    case "claude":
      return { codexModel: "claude-opus-5-5", codexReasoningEffort: "low" };
    case "grok":
      return { codexModel: "grok-4.7" };
    case "codex":
      return {};
  }
}

/** The POST /v1/agents body. Subscription sign-in only: no API key is ever sent. */
export function createAgentBody(input: CreateAgentInput): Record<string, unknown> {
  return {
    companyUid: input.companyUid,
    name: input.name,
    slug: input.slug,
    provider: "agents-v2",
    ...brainCreateFields(input.brain),
    codexAuthMode: "subscription",
    deferChannels: input.deferChannels ?? true,
    idempotencyKey: input.idempotencyKey,
    surface: input.surface,
    desiredInstanceType: input.quote.instanceType,
    quotedNetMonthlyCents: input.quote.netMonthlyCents,
    quoteCatalogVersion: input.quote.catalogVersion,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Map a non-2xx answer onto an {@link AgentsError}. */
export function classifyAgentsError(status: number, bodyText: string): AgentsError {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(bodyText));
  } catch {
    parsed = null;
  }
  const code = str(parsed?.code);
  const serverMessage = str(parsed?.error) ?? str(parsed?.message);
  const base = {
    status,
    ...(code ? { code } : {}),
    ...(serverMessage ? { serverMessage } : {}),
  };
  if (status === 403 && code === "AGENT_PLAN_LIMIT") {
    const amountMinor = parsed?.amountMinor;
    return {
      kind: "plan_limit",
      ...base,
      ...(str(parsed?.requiredPlan) ? { requiredPlan: str(parsed?.requiredPlan) } : {}),
      ...(str(parsed?.checkoutUrl) ? { checkoutUrl: str(parsed?.checkoutUrl) } : {}),
      ...(typeof amountMinor === "number" ? { amountMinor } : {}),
      ...(str(parsed?.currency) ? { currency: str(parsed?.currency) } : {}),
    };
  }
  if (status === 403 && code === "CLAUDE_PROVIDER_NOT_ENABLED") {
    return { kind: "brain_not_enabled", ...base };
  }
  if (status === 403) return { kind: "forbidden", ...base };
  if (status === 409 && code === "AGENT_PROVISION_QUOTE_STALE") {
    return { kind: "quote_stale", ...base };
  }
  if (status === 409) return { kind: "handle_taken", ...base };
  if (status === 404) return { kind: "not_found", ...base };
  if (status === 401) return { kind: "unauthorized", ...base };
  if (status >= 400 && status < 500) return { kind: "invalid", ...base };
  return { kind: "server", ...base };
}

function adminNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    const name = typeof item === "string" ? str(item) : str(asRecord(item)?.displayName);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Read a provision-options answer as a {@link CreateAvailability}. */
export function availabilityFrom(
  result: AgentsResult<unknown>,
  bodyOnRefusal?: unknown,
): CreateAvailability {
  if (result.ok) {
    const block = asRecord(asRecord(result.value)?.createBlock);
    if (block && block.code === "AGENT_PLAN_LIMIT") {
      return {
        state: "plan",
        ...(str(block.requiredPlan) ? { requiredPlan: str(block.requiredPlan) } : {}),
        ...(str(block.checkoutUrl) ? { checkoutUrl: str(block.checkoutUrl) } : {}),
        ...(typeof block.amountMinor === "number" ? { amountMinor: block.amountMinor } : {}),
        ...(str(block.currency) ? { currency: str(block.currency) } : {}),
      };
    }
    return { state: "available" };
  }
  switch (result.error.kind) {
    case "forbidden":
      return { state: "role", admins: adminNames(asRecord(bodyOnRefusal)?.admins) };
    case "plan_limit":
      return {
        state: "plan",
        ...(result.error.requiredPlan ? { requiredPlan: result.error.requiredPlan } : {}),
        ...(result.error.checkoutUrl ? { checkoutUrl: result.error.checkoutUrl } : {}),
        ...(result.error.amountMinor !== undefined ? { amountMinor: result.error.amountMinor } : {}),
        ...(result.error.currency ? { currency: result.error.currency } : {}),
      };
    case "not_found":
      return { state: "not_member" };
    default:
      return { state: "unknown", error: result.error };
  }
}

export interface AgentsClient {
  /** POST /v1/agents. */
  createAgent(input: CreateAgentInput): Promise<AgentsResult<AgentCreateResponse>>;
  /**
   * GET /v1/agents/{uid}/status. `brain` scopes the sign-in read to that
   * brain's pairing, the way the console polls.
   */
  getStatus(
    agentUid: string,
    options?: { brain?: AgentBrain },
  ): Promise<AgentsResult<AgentStatusResponse>>;
  /** Whether the caller can add a cloud bot to this company (see {@link CreateAvailability}). */
  getCreateAvailability(companyUid: string): Promise<CreateAvailability>;
  /** login-code (Claude paste-back), retry, or brains/{brain}/authorize. */
  runAction(
    agentUid: string,
    action: AgentSetupActionRequest,
  ): Promise<AgentsResult<unknown>>;
}

export function createAgentsClient(fetchFn: AgentsFetch): AgentsClient {
  /** One request. A refusal keeps its parsed body for fields the error does not carry. */
  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ result: AgentsResult<T>; refusalBody?: unknown }> {
    let status: number;
    let text: string;
    try {
      const res = await fetchFn(path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      return {
        result: {
          ok: false,
          error: {
            kind: "network",
            status: 0,
            serverMessage: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
    if (status < 200 || status >= 300) {
      let refusalBody: unknown;
      try {
        refusalBody = JSON.parse(text);
      } catch {
        refusalBody = undefined;
      }
      return { result: { ok: false, error: classifyAgentsError(status, text) }, refusalBody };
    }
    if (!text.trim()) return { result: { ok: true, status, value: undefined as T } };
    try {
      return { result: { ok: true, status, value: JSON.parse(text) as T } };
    } catch {
      return {
        result: {
          ok: false,
          error: { kind: "server", status, serverMessage: "The server sent an unreadable answer." },
        },
      };
    }
  }

  async function send<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<AgentsResult<T>> {
    return (await request<T>(method, path, body)).result;
  }

  return {
    async createAgent(input) {
      const result = await send<AgentCreateResponse>(
        "POST",
        AGENTS_PATHS.create,
        createAgentBody(input),
      );
      const agent = result.ok ? asRecord(asRecord(result.value)?.agent) : null;
      if (result.ok && !str(agent?.uid)) {
        return {
          ok: false,
          error: { kind: "server", status: result.status, serverMessage: "The server did not name the new bot." },
        };
      }
      return result;
    },
    async getCreateAvailability(companyUid) {
      const { result, refusalBody } = await request("GET", AGENTS_PATHS.provisionOptions(companyUid));
      return availabilityFrom(result, refusalBody);
    },
    getStatus(agentUid, options = {}) {
      return send<AgentStatusResponse>("GET", AGENTS_PATHS.status(agentUid, options.brain));
    },
    runAction(agentUid, action) {
      switch (action.kind) {
        case "login-code":
          return send("POST", AGENTS_PATHS.loginCode(agentUid), { code: action.code.trim() });
        case "retry":
          return send("POST", AGENTS_PATHS.retry(agentUid), {});
        case "authorize-brain":
          return send("POST", AGENTS_PATHS.authorizeBrain(agentUid, action.brain), {});
      }
    },
  };
}
