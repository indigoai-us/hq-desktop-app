/**
 * The "New company" and "New cloud bot" entry points.
 *
 * Both reuse the server-stamped lifecycle cards instead of a form of their
 * own: the host runs one card action and the shell lands where the server
 * says. Zero-network: callers hand in the `ConversationApi` seam.
 *
 * The cloud-bot entry is a HEADLESS driver over that card sequence. Creating a
 * company-hosted bot exists only as the Team tab's `add_agent` action followed
 * by the `create_agent` card's own turns — there is no direct create route —
 * but that card is no longer RENDERED (it was a second, rival way to make a
 * bot inside a company channel). So the flow runs the same actions the card's
 * buttons ran, filling each turn from the New bot draft, and lands the person
 * in the bot's own channel. Nothing is drawn and nothing is focused on the way.
 */

import type { CardActionResult, ConversationApi } from "./chat-api.js";
import { cardActionFailureMessage } from "./card-action.js";
import {
  parseLifecycleCard,
  type LifecycleCardModel,
} from "./messaging/channelMessageModels.js";
import { slugifyBotName } from "./create-bot/create-bot-model.js";
import { SETUP_CHANNEL_ID } from "./setup-channel.js";

/** #setup summary card + its action that posts a fresh create_company card. */
export const COMPANIES_SUMMARY_CARD_ID = "companies_summary";
export const CREATE_COMPANY_ACTION_ID = "create_company";
/** Team tab spend row + its action that opens the cloud-bot sequence. */
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

export type EntryPointApi = Pick<ConversationApi, "runCardAction">;

/** What the cloud-bot entry needs: the team action, the card turns, the read-back. */
export type CloudBotEntryApi = Pick<
  ConversationApi,
  "runCardAction" | "fetchChannel" | "runCompanyTabAction"
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

/** Shown when the summary card 404s for an account the roster says has a company. */
export const CREATE_COMPANY_ROSTER_SYNCING_REASON =
  "Your company is still syncing. Try again in a moment.";

/**
 * New company: run the #setup summary card's `create_company` action. The
 * server answers `{ cardId, channelId: "setup" }` with the fresh card. A user
 * with no companies yet has no summary card (404) — the seeded create_company
 * card already sits in #setup, so land there by kind.
 *
 * When the caller's roster ALREADY holds a company (`hasCompanies`), that
 * 404 means the server has not caught up with the website-created company
 * yet. Landing on the seeded card would re-prompt an owner to create the
 * company they already have, so report it inline instead of navigating.
 */
export async function runCreateCompanyEntry(
  api: Pick<EntryPointApi, "runCardAction">,
  options: { idempotencyKey?: string; hasCompanies?: boolean } = {},
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
      if (options.hasCompanies) {
        return {
          ok: false,
          reason: CREATE_COMPANY_ROSTER_SYNCING_REASON,
          blocked: false,
        };
      }
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

/** Shown when the desktop cannot finish the server's bot sequence by itself. */
export const CLOUD_BOT_NEEDS_MORE_REASON =
  "Setting up a cloud bot needs a step this app can't fill in yet. Try again after updating HQ.";

/** Shown when the server stopped answering mid-sequence. */
export const CLOUD_BOT_NO_NEXT_STEP_REASON =
  "The server didn't send the next step for the new bot. Try again in a moment.";

/** How many card turns the sequence may take before we stop following it. */
const CLOUD_BOT_MAX_TURNS = 6;
/** How many read-backs we allow while waiting for the server to post a turn. */
const CLOUD_BOT_POLL_ATTEMPTS = 8;
const CLOUD_BOT_POLL_MS = 150;

export interface CloudBotDraft {
  /** The name the New bot flow already collected; also seeds the handle. */
  name: string;
}

export interface CloudBotEntryOptions {
  idempotencyKey?: string;
  maxTurns?: number;
  pollAttempts?: number;
  pollMs?: number;
  /** Injected by tests so the waits are instant. */
  sleep?: (ms: number) => Promise<void>;
}

/** Every lifecycle card currently on a channel page, newest page first. */
async function readLifecycleCards(
  api: CloudBotEntryApi,
  channelId: string,
): Promise<LifecycleCardModel[]> {
  const page = await api.fetchChannel({ channelId, limit: 50 });
  const cards: LifecycleCardModel[] = [];
  for (const message of page.messages ?? []) {
    const card = parseLifecycleCard(message.systemEvent);
    if (card) cards.push(card);
  }
  return cards;
}

/** The action a card's own primary button would have run. */
function primaryActionOf(card: LifecycleCardModel): string | null {
  const primary = card.actions.find((action) => action.style === "primary" && !action.href);
  const fallback = card.actions.find((action) => !action.href);
  return (primary ?? fallback)?.id ?? null;
}

/**
 * The values the card's form would have carried. Every field keeps whatever
 * the server pre-filled; the two the person actually chose in the New bot
 * flow — name and handle — come from the draft.
 */
function valuesForCard(
  card: LifecycleCardModel,
  draft: CloudBotDraft,
): Record<string, string> | null {
  const name = draft.name.trim();
  const values: Record<string, string> = {};
  for (const field of card.fields) {
    if (field.control === "readonly") continue;
    let value = field.value.trim();
    if (field.id === "name" && name) value = name;
    else if (field.id === "handle" && name) value = slugifyBotName(name) || name;
    if (!value && field.required) return null;
    values[field.id] = value;
  }
  return values;
}

/**
 * Create a company-hosted bot and land in its channel.
 *
 * Runs the Team tab's `add_agent` action, then drives the `create_agent` card
 * sequence it opens — the same actions the card's buttons ran — until the
 * server answers with the minted agent channel. The card itself is never
 * rendered or focused: the New bot flow is the only surface the person sees.
 *
 * A company on a plan that cannot host a bot gets the server's upgrade card
 * instead; that one still renders, so the caller is sent to it.
 */
export async function runCreateCloudBotEntry(
  api: CloudBotEntryApi,
  companyUid: string,
  draft: CloudBotDraft,
  options: CloudBotEntryOptions = {},
): Promise<EntryPointResult> {
  const uid = companyUid.trim();
  if (!uid) return { ok: false, reason: "Pick a company first", blocked: false };
  const runTabAction = api.runCompanyTabAction;
  if (typeof runTabAction !== "function") {
    return { ok: false, reason: "Adding bots isn't available in this build", blocked: false };
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollAttempts = options.pollAttempts ?? CLOUD_BOT_POLL_ATTEMPTS;
  const pollMs = options.pollMs ?? CLOUD_BOT_POLL_MS;

  let opened: CardActionResult;
  try {
    opened = await runTabAction({
      companyUid: uid,
      tab: "team",
      cardId: TEAM_SPEND_CARD_ID,
      actionId: ADD_AGENT_ACTION_ID,
      values: {},
      idempotencyKey: options.idempotencyKey,
    });
  } catch (err) {
    return { ok: false, reason: cardActionFailureMessage(err), blocked: isPermission(err) };
  }
  if (opened.state === "blocked") {
    return {
      ok: false,
      reason: trimmed(opened.reason) || "You don't have permission to add bots here",
      blocked: true,
    };
  }
  const channelId = trimmed(opened.channelId);
  if (!channelId) {
    return { ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false };
  }
  let cardId = trimmed(opened.cardId);
  if (!cardId || cardId === TEAM_SPEND_CARD_ID) {
    return { ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false };
  }

  let cards: LifecycleCardModel[];
  try {
    cards = await readLifecycleCards(api, channelId);
  } catch (err) {
    return { ok: false, reason: cardActionFailureMessage(err), blocked: isPermission(err) };
  }
  const first = cards.find((card) => card.cardId === cardId);
  if (first && first.cardKind !== "create_agent") {
    // A plan that cannot host a bot answers with the upgrade card instead.
    // That card still renders, so this is a destination, not a failure.
    return { ok: true, target: { channelId, cardId, cardKind: null } };
  }

  const maxTurns = options.maxTurns ?? CLOUD_BOT_MAX_TURNS;
  const submitted = new Set<string>();
  let card = first ?? null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (!card) return { ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false };
    if (card.state === "blocked") {
      return {
        ok: false,
        reason: trimmed(card.reason) || "The server refused the new bot.",
        blocked: true,
      };
    }
    if (!card.viewer.canAct) {
      return { ok: false, reason: "You don't have permission to add bots here", blocked: true };
    }
    const actionId = primaryActionOf(card);
    const values = valuesForCard(card, draft);
    if (!actionId || !values) {
      return { ok: false, reason: CLOUD_BOT_NEEDS_MORE_REASON, blocked: false };
    }
    let result: CardActionResult;
    try {
      result = await api.runCardAction({ channelId, cardId: card.cardId, actionId, values });
    } catch (err) {
      return { ok: false, reason: cardActionFailureMessage(err), blocked: isPermission(err) };
    }
    const agentChannelId = trimmed(result.agentChannelId);
    if (agentChannelId) {
      // The bot exists and has its own channel. Nothing to focus: no card was
      // ever drawn, and the person lands in the conversation with their bot.
      return { ok: true, target: { channelId: agentChannelId, cardId: null, cardKind: null } };
    }
    submitted.add(card.cardId);
    if (result.state === "blocked") {
      const settled = await readLifecycleCards(api, channelId).catch(() => [] as LifecycleCardModel[]);
      const refused = settled.find((row) => row.cardId === card!.cardId);
      return {
        ok: false,
        reason: trimmed(refused?.reason) || "The server refused the new bot.",
        blocked: true,
      };
    }
    // The server posts the next turn asynchronously; read the channel back
    // until it lands rather than guessing the next card's id.
    card = null;
    for (let attempt = 0; attempt < pollAttempts && !card; attempt += 1) {
      await sleep(pollMs);
      const next = await readLifecycleCards(api, channelId).catch(
        () => [] as LifecycleCardModel[],
      );
      card =
        next.find(
          (row) =>
            row.cardKind === "create_agent" &&
            row.state === "open" &&
            !submitted.has(row.cardId),
        ) ?? null;
    }
    cardId = card?.cardId ?? cardId;
  }
  return { ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false };
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
