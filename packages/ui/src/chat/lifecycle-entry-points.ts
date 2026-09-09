/**
 * "New company" / "New agent" entry points.
 *
 * Both reuse the server-stamped lifecycle cards instead of a form of their
 * own: the host runs one card action, the server posts (or resurfaces) the
 * right card, and the shell selects that channel and scrolls to the card.
 * Zero-network: callers hand in the `ConversationApi` seam.
 */

import type { CardActionResult, ConversationApi } from "./chat-api.js";
import { cardActionFailureMessage } from "./card-action.js";
import { SETUP_CHANNEL_ID } from "./setup-channel.js";

/** #setup summary card + its action that posts a fresh create_company card. */
export const COMPANIES_SUMMARY_CARD_ID = "companies_summary";
export const CREATE_COMPANY_ACTION_ID = "create_company";
/** Team tab spend row + its action that posts (or resurfaces) create_agent. */
export const TEAM_SPEND_CARD_ID = "team:spend";
export const ADD_AGENT_ACTION_ID = "add_agent";

/** Where the shell should land after an entry-point action. */
export interface EntryPointTarget {
  channelId: string;
  /** Card to scroll to and focus; null when only the kind is known. */
  cardId: string | null;
  /** Fallback when the server did not name a card (seeded create_company). */
  cardKind: string | null;
}

export type EntryPointResult =
  | { ok: true; target: EntryPointTarget }
  | {
      ok: false;
      /** Plain-language reason, shown inline where the control was. */
      reason: string;
      /** True when the server refused (permission / plan), not a transport error. */
      blocked: boolean;
    };

export type EntryPointApi = Pick<
  ConversationApi,
  "runCardAction" | "runCompanyTabAction"
>;

function isNotFound(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return /\b404\b|not[_ ]found/i.test(raw);
}

function isPermission(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return /\b403\b|forbidden|permission|owners? only|only owners/i.test(raw);
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * New company: run the #setup summary card's `create_company` action. The
 * server answers `{ cardId, channelId: "setup" }` with the fresh card. A user
 * with no companies yet has no summary card (404) — the seeded create_company
 * card already sits in #setup, so land there by kind.
 */
export async function runCreateCompanyEntry(
  api: Pick<EntryPointApi, "runCardAction">,
  options: { idempotencyKey?: string } = {},
): Promise<EntryPointResult> {
  let result: CardActionResult;
  try {
    result = await api.runCardAction({
      channelId: SETUP_CHANNEL_ID,
      cardId: COMPANIES_SUMMARY_CARD_ID,
      actionId: CREATE_COMPANY_ACTION_ID,
      values: {},
      idempotencyKey: options.idempotencyKey,
    });
  } catch (err) {
    if (isNotFound(err)) {
      return {
        ok: true,
        target: {
          channelId: SETUP_CHANNEL_ID,
          cardId: null,
          cardKind: CREATE_COMPANY_ACTION_ID,
        },
      };
    }
    return {
      ok: false,
      reason: cardActionFailureMessage(err),
      blocked: isPermission(err),
    };
  }
  if (result.state === "blocked") {
    return {
      ok: false,
      reason: trimmed(result.reason) || "You can't create a company right now",
      blocked: true,
    };
  }
  const cardId = trimmed(result.cardId);
  return {
    ok: true,
    target: {
      channelId: trimmed(result.channelId) || SETUP_CHANNEL_ID,
      cardId: cardId && cardId !== COMPANIES_SUMMARY_CARD_ID ? cardId : null,
      cardKind: CREATE_COMPANY_ACTION_ID,
    },
  };
}

/**
 * New agent: run the Team tab's `team:spend` / `add_agent` action for one
 * company. The server answers `{ channelId, cardId }` — the create_agent card
 * on Workforce, or the upgrade card on a free plan. A `blocked` result (or a
 * permission error) becomes an inline reason for the caller to render.
 */
export async function runAddAgentEntry(
  api: EntryPointApi,
  companyUid: string,
  options: { idempotencyKey?: string } = {},
): Promise<EntryPointResult> {
  const uid = companyUid.trim();
  if (!uid) {
    return { ok: false, reason: "Pick a company first", blocked: false };
  }
  const run = api.runCompanyTabAction;
  if (typeof run !== "function") {
    return {
      ok: false,
      reason: "Adding agents isn't available in this build",
      blocked: false,
    };
  }
  let result: CardActionResult;
  try {
    result = await run({
      companyUid: uid,
      tab: "team",
      cardId: TEAM_SPEND_CARD_ID,
      actionId: ADD_AGENT_ACTION_ID,
      values: {},
      idempotencyKey: options.idempotencyKey,
    });
  } catch (err) {
    return {
      ok: false,
      reason: cardActionFailureMessage(err),
      blocked: isPermission(err),
    };
  }
  if (result.state === "blocked") {
    return {
      ok: false,
      reason:
        trimmed(result.reason) || "You don't have permission to add agents here",
      blocked: true,
    };
  }
  const channelId = trimmed(result.channelId);
  if (!channelId) {
    return {
      ok: false,
      reason: "The server didn't say where the agent step was posted",
      blocked: false,
    };
  }
  const cardId = trimmed(result.cardId);
  return {
    ok: true,
    target: {
      channelId,
      cardId: cardId && cardId !== TEAM_SPEND_CARD_ID ? cardId : null,
      cardKind: null,
    },
  };
}

/** Selector for the card an entry point landed on, by id then by kind. */
export function findLifecycleCardElement(
  root: ParentNode,
  target: Pick<EntryPointTarget, "cardId" | "cardKind">,
): HTMLElement | null {
  if (target.cardId) {
    const byId = root.querySelector<HTMLElement>(
      `[data-testid="lifecycle-card"][data-card-id="${cssEscape(target.cardId)}"]`,
    );
    if (byId) return byId;
  }
  if (target.cardKind) {
    // The newest card of that kind that is still live (open / pending /
    // blocked); a done step is not the one the user asked to fill in.
    const all = Array.from(
      root.querySelectorAll<HTMLElement>(
        `[data-testid="lifecycle-card"][data-card-kind="${cssEscape(target.cardKind)}"]`,
      ),
    );
    const live = all.filter((el) => {
      const state = el.getAttribute("data-state");
      return state === "open" || state === "pending" || state === "blocked";
    });
    return live.at(-1) ?? all.at(-1) ?? null;
  }
  return null;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
