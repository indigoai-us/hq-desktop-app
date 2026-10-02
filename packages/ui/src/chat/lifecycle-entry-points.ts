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
import { botHandle, type BotRuntime } from "./create-bot/create-bot-model.js";
import { SETUP_CHANNEL_ID } from "./setup-channel.js";

/** #setup summary card + its action that posts a fresh create_company card. */
export const COMPANIES_SUMMARY_CARD_ID = "companies_summary";
export const CREATE_COMPANY_ACTION_ID = "create_company";
/** Team tab spend row + its action that opens the cloud-bot sequence. */
const TEAM_SPEND_CARD_ID = "team:spend";
const ADD_AGENT_ACTION_ID = "add_agent";

/** Where the shell should land after an entry-point action. */
export interface EntryPointTarget {
  channelId: string;
  /** Card to scroll to and focus; null when only the kind is known. */
  cardId: string | null;
  /** Fallback when the server did not name a card (seeded create_company). */
  cardKind: string | null;
  /**
   * The bot the cloud-bot sequence just minted, when the server named it.
   * The host needs it to write the parts of the New bot draft the sequence
   * never asked for — today the job title — onto the agent profile.
   */
  agentUid?: string;
}

export type EntryPointResult =
  | { ok: true; target: EntryPointTarget }
  | {
      ok: false;
      /** Plain-language reason, shown inline where the control was. */
      reason: string;
      /** True when the server refused (permission / plan), not a transport error. */
      blocked: boolean;
      /**
       * Set when the refusal is the company's plan: where the upgrade card
       * lives, so the caller can offer the way forward instead of a dead end.
       */
      upgrade?: { channelId: string; cardId: string };
      /**
       * Set when the person cancelled while the request was still out. The
       * caller shows nothing for it: no waiting screen and no message.
       */
      cancelled?: boolean;
    };

export type EntryPointApi = Pick<ConversationApi, "runCardAction">;

/** What the cloud-bot entry needs: the team action and the one create action. */
export type CloudBotEntryApi = Pick<
  ConversationApi,
  "runCardAction" | "runCompanyTabAction"
> & {
  /** Desktop support-log bridge. Optional so web hosts remain compatible. */
  logToFile?: (tag: string, message: string) => Promise<void>;
};

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

/** Shown when the server answered without creating the bot or saying why. */
export const CLOUD_BOT_NEEDS_MORE_REASON =
  "The server isn't ready for this version of bot setup yet. Try again shortly.";

/** Shown when the server did not say where the new bot's setup lives. */
export const CLOUD_BOT_NO_NEXT_STEP_REASON =
  "The server didn't send the next step for the new bot. Try again in a moment.";

/** Fallback when the server refused without saying why. */
const CLOUD_BOT_REFUSED_REASON = "The server refused the new bot.";

/** The handle is derived from the name and never shown, so say "name". */
export const CLOUD_BOT_NAME_TAKEN_REASON =
  "A bot with that name already exists in this company. Try a different name.";
export const CLOUD_BOT_NAME_INVALID_REASON =
  "That name can't be used for a bot. Try letters and numbers.";

const CREATE_AGENT_CARD_ID = "create_agent";
/** The card the server resurfaces in the company channel on a plan refusal. */
export const UPGRADE_PLAN_CARD_ID = "upgrade_plan";
const CREATE_ACTION_ID = "create";

export interface CloudBotDraft {
  /** The name the person typed in the New bot flow. */
  name: string;
  /** The @handle they saw there and could edit. */
  handle: string;
  /**
   * The optional job title they typed there. No turn of the `create_agent`
   * sequence asks for one — it collects name, handle, runtime and size — so
   * this is not sent to any card. It travels with the draft so the caller can
   * write it onto the agent profile once the sequence hands back a uid, which
   * is the same PATCH the Local path uses.
   */
  title?: string;
  runtime?: BotRuntime;
  size?: "basic" | "power" | "dev";
  authMode?: "subscription" | "apiKey";
  /** Write-only create input; never copied into lifecycle card state. */
  apiKey?: string;
}

/** Console page where a newly-created Claude subscription can be authorized. */
export function claudeSubscriptionSignInUrl(
  draft: Pick<CloudBotDraft, "runtime" | "authMode">,
  agentUid: string,
): string | null {
  const uid = agentUid.trim();
  if (
    draft.runtime !== "claude" ||
    (draft.authMode ?? "subscription") !== "subscription" ||
    !uid
  ) {
    return null;
  }
  return `https://hq.getindigo.ai/resolve/agents/${encodeURIComponent(uid)}`;
}

export interface CloudBotEntryOptions {
  idempotencyKey?: string;
}

/** Shown when the server failed for a reason a person cannot act on. */
export const CLOUD_BOT_SERVER_FAILED_REASON =
  "We couldn't create this bot. Try again in a moment.";

/**
 * What to show for a thrown failure. A short sentence the server wrote for a
 * person is kept. Anything that reads like a raw backend error (cloud resource
 * names, status payloads, stack text, long strings) is replaced with a plain
 * line, and the detail goes to the support log instead of the screen.
 */
function shownFailure(err: unknown): { reason: string; raw: boolean } {
  const message = cardActionFailureMessage(err);
  const raw =
    message.length > 140 ||
    /arn:aws|not authorized to perform|AccessDenied|Exception\b|statusCode|status \d{3}|\{\s*"|\bat \S+ \(/i.test(
      message,
    );
  return raw
    ? { reason: CLOUD_BOT_SERVER_FAILED_REASON, raw: true }
    : { reason: message, raw: false };
}

/** A single-line, length-bounded copy of a failure for the support log. */
function failureDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return raw.replace(/\s+/g, " ").trim().slice(0, 400);
}

interface WireField {
  id: string;
  value: string;
  error: string;
}

/** The fields a card action answered with, read defensively off the wire. */
function resultFields(result: CardActionResult): WireField[] {
  if (!Array.isArray(result.fields)) return [];
  const fields: WireField[] = [];
  for (const row of result.fields as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const field = row as Record<string, unknown>;
    const id = trimmed(field.id);
    if (!id) continue;
    fields.push({ id, value: trimmed(field.value), error: trimmed(field.error) });
  }
  return fields;
}

/** Why the server refused, in words a person can act on. */
function blockedReason(result: CardActionResult): string {
  const said = trimmed(result.reason);
  if (said) return said;
  const fields = resultFields(result);
  const why = fields.find((field) => field.id === "blocked_reason")?.value;
  if (why === "plan") return "This company's plan doesn't include cloud bots yet.";
  if (why === "permission") {
    const owner = fields.find((field) => field.id === "owner")?.value || "the owner";
    return `You don't have permission to add bots here. Ask ${owner}.`;
  }
  return CLOUD_BOT_REFUSED_REASON;
}

/**
 * One line per failed attempt in the support log, so a failure names its own
 * exit. Ids and states only: no names, handles or keys.
 */
function logCloudBotExit(
  api: CloudBotEntryApi,
  exit: string,
  detail: Record<string, string>,
): void {
  const line = [
    `exit=${exit}`,
    ...Object.entries(detail).map(([key, value]) => `${key}=${value || "none"}`),
  ].join(" ");
  console.warn(`[cloud-bot] ${line}`);
  if (typeof api.logToFile !== "function") return;
  void api.logToFile("cloud-bot", line).catch((err: unknown) => {
    console.error("[cloud-bot] logToFile failed", err);
  });
}

/**
 * New cloud bot: ask the Team tab where the company's `create_agent` card
 * lives, then answer it once with everything the person chose.
 *
 * The server keeps ONE create_agent card per company channel and updates it in
 * place. It is never re-posted, so it may sit far up the channel, still on a
 * turn an abandoned attempt left it on, or already `done` for an earlier bot.
 * This driver therefore never reads the card and never walks its turns. It
 * sends a single `create` carrying name, handle, runtime and size, which the
 * server treats as a complete answer regardless of the stored card.
 *
 * `add_agent` answers with the tab row's own id in `cardId` and the lifecycle
 * card in `focusCardId`; the channel is `channelId`. A company on a plan that
 * cannot host a bot gets the upgrade card instead. That one still renders, so
 * the caller is sent to it.
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
    return {
      ok: false,
      reason: "Adding bots isn't available in this build",
      blocked: false,
    };
  }

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
    const shown = shownFailure(err);
    logCloudBotExit(api, "open-failed", { detail: failureDetail(err) });
    return { ok: false, reason: shown.reason, blocked: !shown.raw && isPermission(err) };
  }
  if (opened.state === "blocked") {
    logCloudBotExit(api, "open-blocked", {});
    return { ok: false, reason: blockedReason(opened), blocked: true };
  }
  const channelId = trimmed(opened.channelId);
  const answeredCard = trimmed(opened.cardId);
  const focusCardId =
    trimmed(opened.focusCardId) ||
    (answeredCard && answeredCard !== TEAM_SPEND_CARD_ID ? answeredCard : "");
  if (!channelId || !focusCardId) {
    logCloudBotExit(api, "open-no-target", {
      channel: channelId ? "present" : "",
      card: answeredCard,
      focus: focusCardId,
      state: trimmed(opened.state),
    });
    return { ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false };
  }
  if (focusCardId !== CREATE_AGENT_CARD_ID) {
    // A plan that cannot host a bot answers with the upgrade card instead.
    // That card still renders, so this is a destination, not a failure.
    return {
      ok: true,
      target: { channelId, cardId: focusCardId, cardKind: null },
    };
  }

  const name = draft.name.trim();
  const handle = botHandle(draft);
  const runtime = draft.runtime ?? "";
  const size = draft.size ?? "";
  if (!name || !handle || !runtime || !size) {
    logCloudBotExit(api, "draft-incomplete", {
      name: name ? "present" : "",
      handle: handle ? "present" : "",
      runtime,
      size,
    });
    return { ok: false, reason: CLOUD_BOT_NEEDS_MORE_REASON, blocked: false };
  }
  const authMode = draft.authMode ?? "subscription";
  // An API key is write-only create input. It travels on this one action and
  // is never copied into a lifecycle field, a card snapshot or a log line.
  const values: Record<string, string> = {
    name,
    handle,
    runtime,
    size,
    authMode,
    deferChannels: "true",
    // The person talks to the bot in a direct message. A server that knows
    // this value makes no channel for the bot; an older one ignores it.
    conversation: "dm",
    ...(authMode === "apiKey" && draft.apiKey ? { apiKey: draft.apiKey } : {}),
  };

  let result: CardActionResult;
  try {
    result = await api.runCardAction({
      channelId,
      cardId: CREATE_AGENT_CARD_ID,
      actionId: CREATE_ACTION_ID,
      values,
    });
  } catch (err) {
    // A raw backend failure (a cloud permission, a status payload) is the
    // server's defect, not the person's refusal: it is neither shown nor
    // treated as "you may not do this".
    const shown = shownFailure(err);
    logCloudBotExit(api, "create-failed", { detail: failureDetail(err) });
    return { ok: false, reason: shown.reason, blocked: !shown.raw && isPermission(err) };
  }

  const agentChannelId = trimmed(result.agentChannelId);
  const createdAgentUid = trimmed(result.agentUid);
  if (agentChannelId || createdAgentUid) {
    // The bot exists. Its uid rides along so the caller can finish the profile
    // and open the direct message. An older server also made a channel for the
    // bot; its id is kept so the app can leave that channel out of the list.
    const agentUid = createdAgentUid;
    return {
      ok: true,
      target: {
        channelId: agentChannelId,
        cardId: null,
        cardKind: null,
        ...(agentUid ? { agentUid } : {}),
      },
    };
  }
  if (result.state === "blocked") {
    const why =
      resultFields(result).find((field) => field.id === "blocked_reason")?.value ?? "";
    logCloudBotExit(api, "create-blocked", { why });
    return {
      ok: false,
      reason: blockedReason(result),
      blocked: true,
      // A plan refusal resurfaces the upgrade card in this same channel.
      ...(why === "plan"
        ? { upgrade: { channelId, cardId: UPGRADE_PLAN_CARD_ID } }
        : {}),
    };
  }
  const refused = resultFields(result).find((field) => field.error);
  if (refused) {
    logCloudBotExit(api, "create-field-error", { field: refused.id });
    const reason =
      refused.id === "handle" || refused.id === "name"
        ? /taken/i.test(refused.error)
          ? CLOUD_BOT_NAME_TAKEN_REASON
          : CLOUD_BOT_NAME_INVALID_REASON
        : refused.error;
    return { ok: false, reason, blocked: false };
  }
  // No bot, no refusal, no field error: a server that does not know the
  // one-shot create moved its card a turn instead of creating anything.
  logCloudBotExit(api, "create-no-agent", {
    state: trimmed(result.state),
    turn: resultFields(result).find((field) => field.id === "turn")?.value ?? "",
  });
  return { ok: false, reason: CLOUD_BOT_NEEDS_MORE_REASON, blocked: false };
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
