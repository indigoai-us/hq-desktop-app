/**
 * Accounts on a hosted bot: the subscriptions it can run on. The status read
 * carries `accounts[]`; an older server leaves it out, and the pane then hides
 * the section so a single-auth bot reads exactly as before.
 *
 * Every array is coerced here, at the parse boundary. Every failure maps to
 * plain copy with a retry path; server text never reaches the pane.
 */
import type { AgentAccountInput, AgentsApi } from "@hq/platform";

export type AccountProvider = "claude" | "codex" | "grok";
export type AccountStatus = "active" | "benched" | "needs_auth";

export interface BotAccount {
  id: string;
  provider: AccountProvider;
  label: string;
  authKind: "subscription" | "apiKey";
  status: AccountStatus;
  /** ISO time a benched account comes back; null otherwise. */
  benchedUntil: string | null;
  /** The bot's original single sign-in, before accounts existed. */
  legacy: boolean;
}

export type AccountSignIn =
  | { state: "pending"; url: string | null; code: string | null }
  | { state: "signed-in" }
  | { state: "failed"; reason: string }
  | { state: "idle" }
  | { state: "unknown" };

export const ACCOUNT_PROVIDERS: readonly AccountProvider[] = ["claude", "codex", "grok"];
export const ACCOUNT_LABEL_MAX = 64;
export const ACCOUNT_LIMIT = 10;
export const ACCOUNT_SIGN_IN_CHECK_EVERY_MS = 3000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function provider(value: unknown): AccountProvider | null {
  const p = str(value).toLowerCase();
  return p === "claude" || p === "codex" || p === "grok" ? p : null;
}

export function accountFromPayload(value: unknown): BotAccount | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const prov = provider(value.provider);
  if (!id || !prov) return null;
  const rawStatus = str(value.status);
  const status: AccountStatus =
    rawStatus === "benched" || rawStatus === "needs_auth" ? rawStatus : "active";
  return {
    id,
    provider: prov,
    label: str(value.label),
    authKind: str(value.authKind) === "apiKey" ? "apiKey" : "subscription",
    status,
    benchedUntil: status === "benched" ? str(value.benchedUntil) || null : null,
    legacy: id === "legacy",
  };
}

function accountList(value: unknown): BotAccount[] {
  const list = Array.isArray(value) ? value : [];
  return list.map(accountFromPayload).filter((a): a is BotAccount => a !== null);
}

/**
 * Accounts from the status read. Null when the server sent no `accounts`
 * field, which hides the section.
 */
export function accountsFromStatusPayload(payload: unknown): BotAccount[] | null {
  if (!isRecord(payload)) return null;
  const rec = isRecord(payload.agent) && "accounts" in payload.agent ? payload.agent : payload;
  if (!("accounts" in rec) || rec.accounts === null || rec.accounts === undefined) return null;
  return accountList(rec.accounts);
}

/** The full list an add or remove hands back; null when it is missing. */
export function accountsFromWritePayload(payload: unknown): BotAccount[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.accounts)) return null;
  return accountList(payload.accounts);
}

export function accountSignInFromPayload(payload: unknown): AccountSignIn {
  const rec = isRecord(payload) ? payload : {};
  const state = str(rec.state);
  if (state === "pending" || state === "starting") {
    return { state: "pending", url: str(rec.url) || null, code: str(rec.code) || null };
  }
  if (state === "signed-in") return { state: "signed-in" };
  if (state === "failed") return { state: "failed", reason: str(rec.reason) };
  if (state === "idle") return { state: "idle" };
  return { state: "unknown" };
}

export function providerLabel(p: AccountProvider): string {
  if (p === "claude") return "Claude";
  if (p === "codex") return "Codex";
  return "Grok";
}

function clockTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function statusLabel(account: BotAccount): string {
  if (account.status === "needs_auth") return "Needs sign-in";
  if (account.status === "benched") {
    const at = clockTime(account.benchedUntil);
    return at ? `Resting until ${at}` : "Resting";
  }
  return "Active";
}

export function accountName(account: BotAccount): string {
  if (account.legacy) return "Default";
  return account.label || providerLabel(account.provider);
}

interface FailureLike {
  status?: number;
}

function statusOf(res: unknown): number | null {
  const s = (res as FailureLike | null)?.status;
  return typeof s === "number" ? s : null;
}

export function addFailureMessage(res: unknown): string {
  const status = statusOf(res);
  if (status === 403) return "Only the bot's owner can change its accounts.";
  if (status === 409) return "That name is taken or the bot already has 10 accounts. Pick another name and try again.";
  if (status === 400) return "Use a name of 64 characters or fewer and try again.";
  return "Couldn't add the account. Try again.";
}

export function removeFailureMessage(res: unknown): string {
  const status = statusOf(res);
  if (status === 403) return "Only the bot's owner can change its accounts.";
  if (status === 409) return "A bot needs at least one account.";
  return "Couldn't remove the account. Try again.";
}

export function signInFailureMessage(reason: string | null | undefined): string {
  if (reason === "expired") return "The sign-in link expired. Start again.";
  if (reason === "duplicate-account") return "That login is already on this bot.";
  return "Couldn't finish sign-in. Try again.";
}

export function codeFailureMessage(res: unknown): string {
  const status = statusOf(res);
  if (status === 409) return "The sign-in timed out. Start again.";
  return "Couldn't send the code. Try again.";
}

type Result = { ok: true; value: unknown } | { ok: false; reason?: string; message?: string; status?: number };

/** The account calls the section needs, bound to one bot. */
export interface AccountsClient {
  add(input: AgentAccountInput): Promise<Result>;
  remove(accountId: string): Promise<Result>;
  startSignIn(accountId: string): Promise<Result>;
  getSignIn(accountId: string): Promise<Result>;
  submitLoginCode?(accountId: string, code: string): Promise<Result>;
}

/** Null when this platform build has no account routes. */
export function accountsClientFor(api: AgentsApi | null | undefined, agentUid: string | null | undefined): AccountsClient | null {
  const uid = (agentUid ?? "").trim();
  if (!api || !uid) return null;
  const { addAccount, removeAccount, startAccountSignIn, getAccountSignIn, submitAccountLoginCode } = api;
  if (!addAccount || !removeAccount || !startAccountSignIn || !getAccountSignIn) return null;
  return {
    add: (input) => addAccount.call(api, uid, input),
    remove: (accountId) => removeAccount.call(api, uid, accountId),
    startSignIn: (accountId) => startAccountSignIn.call(api, uid, accountId),
    getSignIn: (accountId) => getAccountSignIn.call(api, uid, accountId),
    submitLoginCode: submitAccountLoginCode
      ? (accountId, code) => submitAccountLoginCode.call(api, uid, accountId, code)
      : undefined,
  };
}
