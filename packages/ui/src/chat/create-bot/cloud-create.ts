/**
 * New bot → Cloud through POST /v1/agents (desktop-agent-creation US-004).
 *
 * This is the ONE place in this repo that reads the
 * `agents.desktop-agent-creation` flag. Everything that behaves differently
 * under the flag asks a {@link DirectCloudCreate} built here; with the flag
 * off (or absent, or unreadable) every caller keeps its older path. The flag
 * is targeted to one company, so it is read with the company's uid.
 *
 * Only REST through the platform adapter (`adapter.agents.fetch`) is used,
 * so the web build gets the same behaviour as the desktop (US-010).
 */

import {
  DESKTOP_AGENT_CREATION_FLAG,
  type HqProFetch,
  type IdentityApi,
} from "@hq/platform";
import {
  createAgentsClient,
  createErrorCopy,
  type AgentBrain,
  type AgentCreateQuote,
  type AgentsClient,
  type CreateAvailability,
  type CreateErrorFix,
} from "@hq/agents";

/** Create-attempt attribution for bots made from the desktop New bot flow. */
export const DESKTOP_NEW_BOT_SURFACE = "desktop_new_bot";

export interface DirectCloudCreate {
  /** The flag for this company; person-only when null. Off on any failure. */
  isEnabled(companyUid: string | null): Promise<boolean>;
  /** On for the person, or for any of these companies. */
  anyEnabled(companyUids: readonly string[]): Promise<boolean>;
  /** Whether the caller can add a cloud bot to this company. */
  availability(companyUid: string): Promise<CreateAvailability>;
  client: AgentsClient;
}

export interface DirectCloudCreateAdapter {
  identity: Pick<IdentityApi, "hasFeature">;
  agents: { fetch?: HqProFetch };
}

/** Null when the adapter has no REST transport; callers keep the older path. */
export function createDirectCloudCreate(
  adapter: DirectCloudCreateAdapter,
): DirectCloudCreate | null {
  const fetch = adapter.agents?.fetch;
  if (typeof fetch !== "function") return null;
  const client = createAgentsClient(fetch);
  async function isEnabled(companyUid: string | null): Promise<boolean> {
    const uid = companyUid?.trim() ?? "";
    try {
      const result = await adapter.identity.hasFeature(
        DESKTOP_AGENT_CREATION_FLAG,
        uid ? { companyUid: uid } : undefined,
      );
      return result.ok && result.value === true;
    } catch {
      return false;
    }
  }
  return {
    isEnabled,
    async anyEnabled(companyUids) {
      const checks = await Promise.all([
        isEnabled(null),
        ...companyUids.map((uid) => isEnabled(uid)),
      ]);
      return checks.some(Boolean);
    },
    availability: (companyUid) => client.getCreateAvailability(companyUid),
    client,
  };
}

/** One key per New bot session, so a double-click or a retry makes one bot. */
export function newWizardIdempotencyKey(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `desktop-new-bot-${random}`;
}

/** What the direct create needs beyond the older draft. */
export interface DirectCloudDraft {
  name: string;
  handle: string;
  runtime?: AgentBrain;
  idempotencyKey: string;
  quote: AgentCreateQuote;
}

export type DirectCloudCreateResult =
  | { ok: true; agentUid: string; name: string }
  | {
      ok: false;
      /** Plain sentence for the flow's error line. */
      reason: string;
      /** The server refused (role, plan, quote, handle), not a transport miss. */
      blocked: boolean;
      /** The one thing that fixes it, when there is one. */
      fix: CreateErrorFix | null;
    };

/** POST /v1/agents with deferChannels and subscription sign-in; no Slack, no API key. */
export async function runDirectCloudCreate(
  client: AgentsClient,
  companyUid: string,
  draft: DirectCloudDraft,
  context: { companyLabel?: string } = {},
): Promise<DirectCloudCreateResult> {
  const result = await client.createAgent({
    companyUid,
    name: draft.name,
    slug: draft.handle,
    brain: draft.runtime ?? "codex",
    idempotencyKey: draft.idempotencyKey,
    quote: draft.quote,
    surface: DESKTOP_NEW_BOT_SURFACE,
    deferChannels: true,
  });
  if (result.ok) {
    return { ok: true, agentUid: result.value.agent.uid, name: result.value.agent.name || draft.name };
  }
  const copy = createErrorCopy(result.error, {
    ...(context.companyLabel ? { companyLabel: context.companyLabel } : {}),
    handle: draft.handle,
  });
  return {
    ok: false,
    reason: copy.message,
    blocked: result.error.kind !== "network" && result.error.kind !== "server",
    fix: copy.fix,
  };
}

/**
 * The direct create for one company, gated on the flag for THAT company. A
 * person in a flagged company and an unflagged one gets no POST for the
 * unflagged one, whichever surface asked.
 */
export async function runCompanyDirectCloudCreate(
  seam: Pick<DirectCloudCreate, "isEnabled" | "client">,
  companyUid: string,
  draft: DirectCloudDraft,
  context: { companyLabel?: string } = {},
): Promise<DirectCloudCreateResult> {
  if (!(await seam.isEnabled(companyUid))) {
    return {
      ok: false,
      reason: "Adding cloud bots this way isn't on for this company yet.",
      blocked: true,
      fix: null,
    };
  }
  return runDirectCloudCreate(seam.client, companyUid, draft, context);
}
