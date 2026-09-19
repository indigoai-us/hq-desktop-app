/**
 * Create a company from the search palette, without leaving the modal.
 *
 * The server has no direct "create company" route: a company is made by the
 * `create_company` lifecycle card's own turn in #setup. So this drives that
 * card headlessly — the same shape `runCreateCloudBotEntry` uses for bots —
 * and hands the modal the card's OWN fields to render. Nothing here invents a
 * field: whatever the server declares on the card is what step 2 asks for.
 *
 * Two calls, because the card only exists after the first one:
 *   `openCreateCompanyDraft` — run `companies_summary/create_company`, read
 *   the fresh card back, return its fields.
 *   `submitCreateCompany` — run that card's primary action with the values the
 *   person typed, then send one `team:invite` per address.
 */

import type { CardActionResult, ConversationApi } from "../chat-api.js";
import { cardActionFailureMessage } from "../card-action.js";
import {
  parseLifecycleCard,
  type LifecycleCardField,
  type LifecycleCardModel,
} from "../messaging/channelMessageModels.js";
import { messagesForDisplay } from "../live-messages.js";
import { SETUP_CHANNEL_ID } from "../setup-channel.js";
import {
  COMPANIES_SUMMARY_CARD_ID,
  CREATE_COMPANY_ACTION_ID,
} from "../lifecycle-entry-points.js";

/** The Team tab row that invites a person to a company, and its action. */
export const TEAM_INVITE_CARD_ID = "team:invite";
export const TEAM_INVITE_ACTION_ID = "invite";

/** How long to wait for the server to post the card it just promised. */
const POLL_ATTEMPTS = 8;
const POLL_MS = 150;

export type CreateCompanyApi = Pick<
  ConversationApi,
  "runCardAction" | "fetchChannel"
> &
  Partial<Pick<ConversationApi, "runCompanyTabAction" | "checkCompanySlug">>;

/** The form step 2 renders: the card, as the server declared it. */
export interface CompanyDraftForm {
  channelId: string;
  cardId: string;
  title: string;
  summary: string | null;
  /** Editable fields only — a readonly field is nothing to ask for. */
  fields: LifecycleCardField[];
  /** The action the primary button runs. */
  actionId: string;
  /** The field the typed company name belongs in, when the card has one. */
  nameFieldId: string | null;
}

export type CompanyDraftResult =
  | { ok: true; form: CompanyDraftForm }
  | { ok: false; reason: string; blocked: boolean };

export interface CompanyInvite {
  email: string;
  role: string;
}

/** One invite that did not go out, with the server's own words. */
export interface InviteFailure {
  email: string;
  reason: string;
}

export interface CreatedCompany {
  companyUid: string | null;
  companyChannelId: string | null;
  /** Invites the server refused. The company still exists. */
  inviteFailures: InviteFailure[];
}

export type CreateCompanyResult =
  | { ok: true; company: CreatedCompany }
  | { ok: false; reason: string; blocked: boolean };

export interface CreateCompanyOptions {
  idempotencyKey?: string;
  pollAttempts?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Shown when the server never posted the card its answer pointed at. */
export const CREATE_COMPANY_NO_CARD_REASON =
  "The server didn't send the company form. Try again in a moment.";
/** Shown when the card carries no button this flow can press. */
export const CREATE_COMPANY_NO_ACTION_REASON =
  "Creating a company needs a step this app can't fill in yet. Try again after updating HQ.";
/** Shown when the server answered the submit without saying what it made. */
export const CREATE_COMPANY_NO_RESULT_REASON =
  "The company was submitted but the server didn't say it was created. Check #setup.";

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isNotFound(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return /\b404\b|not[_ ]found/i.test(raw);
}

function isPermission(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return /\b403\b|forbidden|permission|owners? only|only owners/i.test(raw);
}

function failure(err: unknown): { ok: false; reason: string; blocked: boolean } {
  return { ok: false, reason: cardActionFailureMessage(err), blocked: isPermission(err) };
}

/** Every lifecycle card on a channel page, oldest first (the wire is newest-first). */
async function readCards(
  api: CreateCompanyApi,
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

/** The card's primary button. Never a link — those navigate, they don't submit. */
function primaryActionOf(card: LifecycleCardModel): string | null {
  const primary = card.actions.find((action) => action.style === "primary" && !action.href);
  const fallback = card.actions.find((action) => !action.href);
  return (primary ?? fallback)?.id ?? null;
}

/**
 * The field the typed company name belongs in: the card's own `name` field
 * when it has one, else the first required text field. A card that asks for
 * something else entirely gets no prefill rather than a guessed one.
 */
function nameFieldOf(fields: readonly LifecycleCardField[]): string | null {
  const byId = fields.find((field) => field.id === "name");
  if (byId) return byId.id;
  const firstText = fields.find((field) => field.control === "text" && field.required);
  return firstText?.id ?? null;
}

function formFrom(card: LifecycleCardModel, channelId: string): CompanyDraftForm | null {
  const actionId = primaryActionOf(card);
  if (!actionId) return null;
  const fields = card.fields.filter((field) => field.control !== "readonly");
  return {
    channelId,
    cardId: card.cardId,
    title: card.title,
    summary: card.summary,
    fields,
    actionId,
    nameFieldId: nameFieldOf(fields),
  };
}

/**
 * Open the company form.
 *
 * Runs the #setup summary card's `create_company` action, which posts a fresh
 * card, then reads #setup back until that card lands. An account with no
 * company yet has no summary card (404) — the seeded `create_company` card is
 * already in #setup, so that case reads the seeded one instead of failing.
 */
export async function openCreateCompanyDraft(
  api: CreateCompanyApi,
  options: CreateCompanyOptions = {},
): Promise<CompanyDraftResult> {
  const attempts = Math.max(1, options.pollAttempts ?? POLL_ATTEMPTS);
  const ms = options.pollMs ?? POLL_MS;
  const sleep = options.sleep ?? ((wait: number) => new Promise<void>((r) => setTimeout(r, wait)));

  let result: CardActionResult | null = null;
  try {
    result = await api.runCardAction({
      channelId: SETUP_CHANNEL_ID,
      cardId: COMPANIES_SUMMARY_CARD_ID,
      actionId: CREATE_COMPANY_ACTION_ID,
      values: {},
      idempotencyKey: options.idempotencyKey,
    });
  } catch (err) {
    // No summary card yet: the seeded create_company card is the form.
    if (!isNotFound(err)) return failure(err);
  }
  if (result?.state === "blocked") {
    return {
      ok: false,
      reason: trimmed(result.reason) || "You can't create a company right now",
      blocked: true,
    };
  }

  const channelId = trimmed(result?.channelId) || SETUP_CHANNEL_ID;
  const wantedId = trimmed(result?.cardId);
  const targetId = wantedId && wantedId !== COMPANIES_SUMMARY_CARD_ID ? wantedId : null;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(ms);
    let cards: LifecycleCardModel[];
    try {
      cards = await readCards(api, channelId);
      lastError = null;
    } catch (err) {
      lastError = err;
      continue;
    }
    const card = targetId
      ? newestCard(cards, (row) => row.cardId === targetId)
      : newestCard(
          cards,
          (row) =>
            row.cardKind === CREATE_COMPANY_ACTION_ID &&
            (row.state === "open" || row.state === "blocked"),
        );
    if (!card) continue;
    if (!card.viewer.canAct) {
      return { ok: false, reason: "You don't have permission to create a company", blocked: true };
    }
    const form = formFrom(card, channelId);
    if (!form) return { ok: false, reason: CREATE_COMPANY_NO_ACTION_REASON, blocked: false };
    return { ok: true, form };
  }
  if (lastError) return failure(lastError);
  return { ok: false, reason: CREATE_COMPANY_NO_CARD_REASON, blocked: false };
}

/**
 * Submit the company form, then send the invites.
 *
 * The card's answer carries the new company and its channel — the server mints
 * that channel itself, so nothing here creates one. Invites run afterwards,
 * one per address, and a refused invite is reported without pretending the
 * company failed: it exists either way.
 */
export async function submitCreateCompany(
  api: CreateCompanyApi,
  form: CompanyDraftForm,
  values: Record<string, string>,
  invites: readonly CompanyInvite[] = [],
  options: CreateCompanyOptions = {},
): Promise<CreateCompanyResult> {
  let result: CardActionResult;
  try {
    result = await api.runCardAction({
      channelId: form.channelId,
      cardId: form.cardId,
      actionId: form.actionId,
      values,
      idempotencyKey: options.idempotencyKey,
    });
  } catch (err) {
    return failure(err);
  }
  if (result.state === "blocked") {
    // The card itself carries the reason ("that handle is taken"); read it
    // back when the action answer did not repeat it.
    let reason = trimmed(result.reason);
    if (!reason) {
      const cards = await readCards(api, form.channelId).catch(() => [] as LifecycleCardModel[]);
      reason = trimmed(newestCard(cards, (row) => row.cardId === form.cardId)?.reason);
    }
    return { ok: false, reason: reason || "The server refused the new company.", blocked: true };
  }

  const companyUid = trimmed(result.companyUid) || null;
  const companyChannelId = trimmed(result.companyChannelId) || trimmed(result.channelId) || null;
  if (!companyUid && !companyChannelId) {
    return { ok: false, reason: CREATE_COMPANY_NO_RESULT_REASON, blocked: false };
  }

  const inviteFailures = companyUid
    ? await sendCompanyInvites(api, companyUid, invites)
    : invites.map((invite) => ({
        email: invite.email,
        reason: "The server didn't name the new company, so the invite wasn't sent.",
      }));

  return { ok: true, company: { companyUid, companyChannelId, inviteFailures } };
}

/**
 * One `team:invite` per address. A refusal is collected, never swallowed and
 * never allowed to stop the addresses behind it.
 */
export async function sendCompanyInvites(
  api: CreateCompanyApi,
  companyUid: string,
  invites: readonly CompanyInvite[],
): Promise<InviteFailure[]> {
  const failures: InviteFailure[] = [];
  if (invites.length === 0) return failures;
  const runTabAction = api.runCompanyTabAction;
  if (typeof runTabAction !== "function") {
    return invites.map((invite) => ({
      email: invite.email,
      reason: "Inviting people isn't available in this build.",
    }));
  }
  for (const invite of invites) {
    const email = invite.email.trim();
    if (!email) continue;
    try {
      const answer = await runTabAction({
        companyUid,
        tab: "team",
        cardId: TEAM_INVITE_CARD_ID,
        actionId: TEAM_INVITE_ACTION_ID,
        values: { email, role: invite.role.trim() || "member" },
      });
      if (answer.state === "blocked") {
        failures.push({ email, reason: trimmed(answer.reason) || "The server refused the invite." });
      }
    } catch (err) {
      failures.push({ email, reason: cardActionFailureMessage(err) });
    }
  }
  return failures;
}

/**
 * Advisory handle check for the handle field, when the host has the route.
 * Resolves with the server's raw answer; the caller parses it. Rejections are
 * the caller's to report — this seam never turns a failure into a verdict.
 */
export type CheckCompanySlug = (slug: string) => Promise<unknown>;

/** What the modal needs wired to create a company without leaving it. */
export interface CompanyCreateSeam {
  open: () => Promise<CompanyDraftResult>;
  submit: (
    form: CompanyDraftForm,
    values: Record<string, string>,
    invites: readonly CompanyInvite[],
  ) => Promise<CreateCompanyResult>;
  /** Absent on a host whose server has no availability route. */
  checkSlug?: CheckCompanySlug | null;
}

/**
 * The field the live handle check watches: the card's own `slug` field when it
 * has one, else the first text field that publishes a format rule. A card with
 * neither gets no live check rather than a guessed one.
 */
export function slugFieldOf(
  fields: readonly LifecycleCardField[],
): string | null {
  const bySlug = fields.find((field) => field.id === "slug");
  if (bySlug) return bySlug.id;
  const constrained = fields.find(
    (field) => field.control === "text" && field.constraints !== null,
  );
  return constrained?.id ?? null;
}
