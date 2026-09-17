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
 *
 * Because nobody sees those cards, the driver owns what a person would have
 * done with them: it carries the name and handle they chose in the New bot
 * flow, it answers a stale refusal through the card's own "try again" instead
 * of returning it forever, and it never submits into a sequence opened for a
 * different bot.
 */

import type { CardActionResult, ConversationApi } from "./chat-api.js";
import { cardActionFailureMessage } from "./card-action.js";
import {
  parseLifecycleCard,
  type LifecycleCardModel,
} from "./messaging/channelMessageModels.js";
import { botHandle } from "./create-bot/create-bot-model.js";
import { messagesForDisplay } from "./live-messages.js";
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

/** Fallback when the server refused without saying why. */
export const CLOUD_BOT_REFUSED_REASON = "The server refused the new bot.";

/**
 * Shown when the company channel still holds a half-finished sequence that
 * belongs to a different bot. The driver will not submit this person's answers
 * into someone else's draft, and the server offered no way to put it away.
 */
export function cloudBotStaleCardReason(recordedHandle: string | null): string {
  return recordedHandle
    ? `A half-finished setup for @${recordedHandle} is still open in that company's channel. Use that handle to finish it, or try again later.`
    : "A half-finished bot setup is still open in that company's channel. Try again in a moment.";
}

/** How many card turns the sequence may take before we stop following it. */
const CLOUD_BOT_MAX_TURNS = 6;
/** How many read-backs we allow while waiting for the server to post a turn. */
const CLOUD_BOT_POLL_ATTEMPTS = 8;
const CLOUD_BOT_POLL_MS = 150;

/** Card actions that mean "let me try that again", by id. */
const RECOVERY_ACTION_IDS = ["retry", "try_again", "start_over", "again", "edit"];
/** Card actions that mean "put this away", by id. */
const DISMISS_ACTION_IDS = ["dismiss", "cancel", "close", "discard", "abandon", "delete", "remove"];

export interface CloudBotDraft {
  /** The name the person typed in the New bot flow. */
  name: string;
  /** The @handle they saw there and could edit. */
  handle: string;
}

export interface CloudBotEntryOptions {
  idempotencyKey?: string;
  maxTurns?: number;
  pollAttempts?: number;
  pollMs?: number;
  /** Injected by tests so the waits are instant. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long a read-back may keep trying before the caller gives up. */
interface PollBudget {
  attempts: number;
  ms: number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Every lifecycle card currently on a channel page, in the order its turns
 * happened: oldest first.
 *
 * The WIRE order is the opposite. `fetch_channel` answers NEWEST-first — the
 * Rust type says so (`ChannelDetail` in crates/hq-desktop-core/src/messages.rs:
 * "a page of messages (newest-first)"), the `ConversationApi.fetchChannel`
 * seam repeats it, and the dev harness builds its pages that way
 * (apps/sync/dev-harness/lifecycle-scenario.ts, "Desktop fetch_channel pages
 * are newest-first").
 *
 * So the page is turned around exactly ONCE, here, and through the same named
 * helper the timeline itself uses rather than a reverse of our own:
 * `messagesForDisplay` is where this app states the wire order, and
 * live-messages.test.ts "reverses newest-first REST pages for display" pins
 * it. If the wire order ever changes, that one helper and that one test move
 * — and this driver follows — instead of every reader here silently
 * inverting. Everything below may assume oldest-first.
 */
async function readLifecycleCards(
  api: CloudBotEntryApi,
  channelId: string,
): Promise<LifecycleCardModel[]> {
  const page = await api.fetchChannel({ channelId, limit: 50 });
  const cards: LifecycleCardModel[] = [];
  for (const message of messagesForDisplay(page)) {
    const card = parseLifecycleCard(message.systemEvent);
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * The NEWEST card `match` accepts. `readLifecycleCards` hands its list over
 * oldest-first, so scanning forward would hand a fresh turn's poll a stale
 * card of the same shape; this walks back from the newest end.
 */
function newestCard(
  cards: readonly LifecycleCardModel[],
  match: (card: LifecycleCardModel) => boolean,
): LifecycleCardModel | null {
  for (let i = cards.length - 1; i >= 0; i -= 1) {
    const card = cards[i]!;
    if (match(card)) return card;
  }
  return null;
}

/**
 * Read the channel back until `pick` finds a card, bounded. The first read is
 * immediate; only the retries wait. Errors do not abort the wait — the last
 * one is returned so a caller that found nothing can report it honestly.
 */
async function pollForCard(
  api: CloudBotEntryApi,
  channelId: string,
  pick: (cards: LifecycleCardModel[]) => LifecycleCardModel | null,
  poll: PollBudget,
): Promise<{ card: LifecycleCardModel | null; cards: LifecycleCardModel[]; error: unknown }> {
  let cards: LifecycleCardModel[] = [];
  let error: unknown = null;
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    if (attempt > 0) await poll.sleep(poll.ms);
    try {
      cards = await readLifecycleCards(api, channelId);
      error = null;
    } catch (err) {
      cards = [];
      error = err;
      continue;
    }
    const found = pick(cards);
    if (found) return { card: found, cards, error: null };
  }
  return { card: null, cards, error };
}

/** The action a card's own primary button would have run. */
function primaryActionOf(card: LifecycleCardModel): string | null {
  const primary = card.actions.find((action) => action.style === "primary" && !action.href);
  const fallback = card.actions.find((action) => !action.href);
  return (primary ?? fallback)?.id ?? null;
}

/** The card's own action of one of these kinds, if it offers one. Never a link. */
function actionOf(card: LifecycleCardModel, ids: readonly string[]): string | null {
  for (const action of card.actions) {
    if (action.href) continue;
    const key = action.id.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (ids.includes(key)) return action.id;
  }
  return null;
}

/**
 * Put a card away so a later attempt cannot inherit it, and say whether that
 * worked. A server that offers a dismiss/cancel action gets it run; one that
 * does not leaves the card live, and the driver's own rules — never resume a
 * sequence opened for a different bot, always answer a stale refusal through
 * the card's own "try again" — keep it from deciding the next attempt.
 */
async function abandonCard(
  api: CloudBotEntryApi,
  channelId: string,
  card: LifecycleCardModel,
): Promise<boolean> {
  const actionId = actionOf(card, DISMISS_ACTION_IDS);
  if (!actionId) return false;
  try {
    await api.runCardAction({ channelId, cardId: card.cardId, actionId, values: {} });
    return true;
  } catch {
    return false;
  }
}

/**
 * The opening turn of a sequence: the one that asks for the bot's name. Every
 * later turn asks for something whose shape the server chose (runtime, size),
 * so the opening turn is the only one a New bot draft can fill from scratch.
 */
function isOpeningTurn(card: LifecycleCardModel): boolean {
  return card.fields.some((field) => field.id === "name" && field.control !== "readonly");
}

/** True when an earlier create_agent card in this channel already asked for a name. */
function resumesEarlierSequence(
  cards: readonly LifecycleCardModel[],
  card: LifecycleCardModel,
): boolean {
  const at = cards.indexOf(card);
  const before = at < 0 ? cards : cards.slice(0, at);
  return before.some((row) => row.cardKind === "create_agent" && isOpeningTurn(row));
}

/**
 * The handle a live sequence was already opened under, read from the nearest
 * opening turn in front of it: its status label ("@polar"), else its own
 * handle field. null when the channel records neither.
 */
function recordedHandleFor(
  cards: readonly LifecycleCardModel[],
  card: LifecycleCardModel,
): string | null {
  const at = cards.indexOf(card);
  for (let i = (at < 0 ? cards.length : at) - 1; i >= 0; i -= 1) {
    const prev = cards[i]!;
    if (prev.cardKind !== "create_agent" || !isOpeningTurn(prev)) continue;
    const label = trimmed(prev.statusLabel);
    if (label.startsWith("@")) return label.slice(1).toLowerCase();
    const field = prev.fields.find((row) => row.id === "handle");
    const value = trimmed(field?.value).replace(/^@/, "");
    return value ? value.toLowerCase() : null;
  }
  return null;
}

/**
 * The values the card's form would have carried. Every field keeps whatever
 * the server pre-filled; the two the person actually chose in the New bot
 * flow — name and handle — come from the draft, exactly as they typed them.
 */
function valuesForCard(
  card: LifecycleCardModel,
  draft: CloudBotDraft,
): Record<string, string> | null {
  const name = draft.name.trim();
  const handle = botHandle(draft);
  const values: Record<string, string> = {};
  for (const field of card.fields) {
    if (field.control === "readonly") continue;
    let value = field.value.trim();
    if (field.id === "name" && name) value = name;
    else if (field.id === "handle" && handle) value = handle;
    if (!value && field.required) return null;
    values[field.id] = value;
  }
  return values;
}

/** Either the card this attempt starts from, or the answer to give instead. */
type OpenedSequence =
  | { kind: "card"; channelId: string; card: LifecycleCardModel; cards: LifecycleCardModel[] }
  | { kind: "done"; result: EntryPointResult };

/** Run the Team tab's `add_agent` and read back the card it points at. */
async function openCreateAgent(
  api: CloudBotEntryApi,
  runTabAction: NonNullable<CloudBotEntryApi["runCompanyTabAction"]>,
  companyUid: string,
  idempotencyKey: string | undefined,
  poll: PollBudget,
): Promise<OpenedSequence> {
  const noNextStep: OpenedSequence = {
    kind: "done",
    result: { ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false },
  };
  let opened: CardActionResult;
  try {
    opened = await runTabAction({
      companyUid,
      tab: "team",
      cardId: TEAM_SPEND_CARD_ID,
      actionId: ADD_AGENT_ACTION_ID,
      values: {},
      idempotencyKey,
    });
  } catch (err) {
    return {
      kind: "done",
      result: { ok: false, reason: cardActionFailureMessage(err), blocked: isPermission(err) },
    };
  }
  if (opened.state === "blocked") {
    return {
      kind: "done",
      result: {
        ok: false,
        reason: trimmed(opened.reason) || "You don't have permission to add bots here",
        blocked: true,
      },
    };
  }
  const channelId = trimmed(opened.channelId);
  const cardId = trimmed(opened.cardId);
  if (!channelId || !cardId || cardId === TEAM_SPEND_CARD_ID) return noNextStep;

  // The opening card gets the same bounded read-back every later turn gets: a
  // server that posts it asynchronously is a wait, not a failure.
  const found = await pollForCard(
    api,
    channelId,
    (cards) => newestCard(cards, (row) => row.cardId === cardId),
    poll,
  );
  if (!found.card) {
    if (found.error) {
      return {
        kind: "done",
        result: {
          ok: false,
          reason: cardActionFailureMessage(found.error),
          blocked: isPermission(found.error),
        },
      };
    }
    return noNextStep;
  }
  if (found.card.cardKind !== "create_agent") {
    // A plan that cannot host a bot answers with the upgrade card instead.
    // That card still renders, so this is a destination, not a failure.
    return { kind: "done", result: { ok: true, target: { channelId, cardId, cardKind: null } } };
  }
  return { kind: "card", channelId, card: found.card, cards: found.cards };
}

/**
 * The card this attempt may start from.
 *
 * `add_agent` resurfaces any live create_agent card in the channel, so an
 * attempt that died mid-way hands the next one a turn-2/3 card whose recorded
 * name belongs to the PREVIOUS draft — and the later turns have no name field
 * to correct it with. Such a card is never submitted into: it is put away if
 * the server offers a way (and the sequence opened again), and otherwise
 * reported. A sequence already opened under THIS handle is resumed; finishing
 * it is exactly what the person asked for.
 */
async function enterSequence(
  api: CloudBotEntryApi,
  runTabAction: NonNullable<CloudBotEntryApi["runCompanyTabAction"]>,
  companyUid: string,
  draft: CloudBotDraft,
  idempotencyKey: string | undefined,
  poll: PollBudget,
): Promise<OpenedSequence> {
  const first = await openCreateAgent(api, runTabAction, companyUid, idempotencyKey, poll);
  if (first.kind === "done") return first;
  if (isOpeningTurn(first.card) || !resumesEarlierSequence(first.cards, first.card)) return first;

  const recorded = recordedHandleFor(first.cards, first.card);
  if (recorded && recorded === botHandle(draft)) return first;

  const stale: OpenedSequence = {
    kind: "done",
    result: { ok: false, reason: cloudBotStaleCardReason(recorded), blocked: false },
  };
  if (!(await abandonCard(api, first.channelId, first.card))) return stale;

  // A fresh key: the same one would let the server replay the answer that
  // pointed at the card just put away.
  const second = await openCreateAgent(api, runTabAction, companyUid, undefined, poll);
  if (second.kind === "done") return second;
  if (isOpeningTurn(second.card)) return second;
  return {
    kind: "done",
    result: {
      ok: false,
      reason: cloudBotStaleCardReason(recordedHandleFor(second.cards, second.card)),
      blocked: false,
    },
  };
}

/**
 * Create a company-hosted bot and land in its channel.
 *
 * Runs the Team tab's `add_agent` action, then drives the `create_agent` card
 * sequence it opens — the same actions the card's buttons ran — until the
 * server answers with the minted agent channel. The card itself is never
 * rendered or focused: the New bot flow is the only surface the person sees,
 * and the name and handle it carries are the ones they typed there.
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
  const poll: PollBudget = {
    attempts: Math.max(1, options.pollAttempts ?? CLOUD_BOT_POLL_ATTEMPTS),
    ms: options.pollMs ?? CLOUD_BOT_POLL_MS,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };

  const opened = await enterSequence(api, runTabAction, uid, draft, options.idempotencyKey, poll);
  if (opened.kind === "done") return opened.result;
  const channelId = opened.channelId;
  let card: LifecycleCardModel | null = opened.card;

  const maxTurns = options.maxTurns ?? CLOUD_BOT_MAX_TURNS;
  /** Cards this attempt already answered, so a poll never picks one again. */
  const submitted = new Set<string>();
  /** Refusals this attempt already answered once; a second one is final. */
  const recovered = new Set<string>();
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (!card) return { ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false };
    let recovery: string | null = null;
    if (card.state === "blocked") {
      // A refusal left over from an earlier attempt is not this attempt's
      // answer: run the card's own "try again" with the values the person
      // just chose, so a stale refusal can never be returned forever. Our own
      // refusal — and one with nothing to recover through — is reported.
      recovery =
        submitted.has(card.cardId) || recovered.has(card.cardId)
          ? null
          : actionOf(card, RECOVERY_ACTION_IDS);
      if (!recovery) {
        await abandonCard(api, channelId, card);
        return {
          ok: false,
          reason: trimmed(card.reason) || CLOUD_BOT_REFUSED_REASON,
          blocked: true,
        };
      }
      recovered.add(card.cardId);
    }
    if (!card.viewer.canAct) {
      return { ok: false, reason: "You don't have permission to add bots here", blocked: true };
    }
    const actionId = recovery ?? primaryActionOf(card);
    const values = valuesForCard(card, draft);
    if (!actionId || !values) {
      await abandonCard(api, channelId, card);
      // A refusal we cannot answer is still the server's refusal: a blocked
      // card whose "try again" re-asks for something this draft has no value
      // for keeps the card's own words — "@acme is already taken in Acme" —
      // and stays `blocked`, the flag callers read to tell a refusal from a
      // transient miss. Only an ordinary turn we cannot fill is "needs more".
      if (card.state === "blocked") {
        return {
          ok: false,
          reason: trimmed(card.reason) || CLOUD_BOT_REFUSED_REASON,
          blocked: true,
        };
      }
      return { ok: false, reason: CLOUD_BOT_NEEDS_MORE_REASON, blocked: false };
    }
    const answered = card;
    let result: CardActionResult;
    try {
      result = await api.runCardAction({ channelId, cardId: answered.cardId, actionId, values });
    } catch (err) {
      await abandonCard(api, channelId, answered);
      return { ok: false, reason: cardActionFailureMessage(err), blocked: isPermission(err) };
    }
    const agentChannelId = trimmed(result.agentChannelId);
    if (agentChannelId) {
      // The bot exists and has its own channel. Nothing to focus: no card was
      // ever drawn, and the person lands in the conversation with their bot.
      return { ok: true, target: { channelId: agentChannelId, cardId: null, cardKind: null } };
    }
    submitted.add(answered.cardId);
    if (result.state === "blocked") {
      const settled = await readLifecycleCards(api, channelId).catch(
        () => [] as LifecycleCardModel[],
      );
      const refused = newestCard(settled, (row) => row.cardId === answered.cardId);
      // Nobody can see this card, so nobody can clear it: put it away here if
      // the server offers a way, and leave the next attempt a clean start.
      if (refused) await abandonCard(api, channelId, refused);
      return {
        ok: false,
        reason: trimmed(refused?.reason) || CLOUD_BOT_REFUSED_REASON,
        blocked: true,
      };
    }
    // The server posts the next turn asynchronously; read the channel back
    // until it lands rather than guessing the next card's id.
    const next = await pollForCard(
      api,
      channelId,
      (rows) =>
        newestCard(
          rows,
          (row) =>
            row.cardKind === "create_agent" &&
            row.state === "open" &&
            !submitted.has(row.cardId),
        ),
      poll,
    );
    card = next.card;
  }
  // Out of turns: this sequence is longer than the build knows how to drive.
  // Put the card still waiting away if the server offers a way, so the next
  // attempt does not inherit a draft this one abandoned.
  if (card) await abandonCard(api, channelId, card);
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
