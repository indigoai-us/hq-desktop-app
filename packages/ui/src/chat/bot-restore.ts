/**
 * Bots come back after a reinstall.
 *
 * `hq bot list` only knows THIS computer, so the desktop could not tell two
 * very different states apart: "you have no such bot" and "you own this bot,
 * its identity and memory are safe in HQ, and nothing here can run it". The
 * owner hit the second one — a fresh Mac on the same account, a DM with
 * test-bot spinning for 41 s while the bot's own setup said it could not run
 * here — because the cloud half of the bot was invisible to the app.
 *
 * `hq bot list --remote` is the source of truth that closes it: every local
 * bot the account owns, each flagged `here` or not. From that one listing come
 * all three surfaces in this module's copy — the honest DM notice with a way
 * out ("Start on this computer" → `hq bot adopt`), the one-time prompt after a
 * fresh install ("Restore all" → `hq bot restore --all`), and the Settings
 * rows for bots that live elsewhere.
 *
 * Pure on purpose: the selection rules, the dismissal memory and every
 * sentence are unit-tested without a DOM, and the host (`DesktopApp.svelte`,
 * `BotsSettingsPane.svelte`) owns the state and the rendering.
 *
 * WORDING: "bot", never "agent". Nothing the CLI or the API says is ever
 * rendered — see `plainBotFailure`.
 */

import type { BotRestoreResult, BotRestoreRow, LocalBotRow, RemoteBotRow } from "@hq/platform";

import { plainBotFailure } from "./local-bots.js";
import { botRunsHere, localBotsTracedButGone, type LocalBotTrace } from "./bot-runnability.js";

/**
 * How often the shell re-reads the account's own bots. Four times slower than
 * the local listing on purpose: `hq bot list --remote` is a cloud round trip,
 * and "which bots do I own" changes on the scale of a reinstall, not a
 * heartbeat. Every surface that changes it (adopt, restore, Check again)
 * refreshes immediately rather than waiting for this.
 */
export const REMOTE_BOTS_POLL_MS = 120_000;

/**
 * Hard bound on ONE `hq bot list --remote` call.
 *
 * On the owner's VM the remote listing was asked for three times and then not
 * again for 16 m 38 s, while the 30 s local poller kept firing from the same
 * `onMount`. Whatever swallowed those calls, a poll that never comes back
 * must never become a poll that never happens again: every call is raced
 * against this bound, the pending one is abandoned, and the cadence carries
 * on. Comfortably under the 120 s period and over the host's own 60 s CLI
 * timeout is the wrong trade here — a listing that has not answered in 20 s
 * is not going to make this tick useful, and the next tick is 100 s away.
 */
export const REMOTE_BOTS_CALL_TIMEOUT_MS = 20_000;

/** The one warn line an abandoned listing call writes. */
export const REMOTE_BOTS_TIMEOUT_LOG =
  "[hq-desktop] remote bot list did not answer in time; abandoning this poll";

/** What `withPollTimeout` gives back: an answer, or the bound expiring. */
export type PollOutcome<T> = { timedOut: false; value: T } | { timedOut: true; value: null };

/**
 * Run `call` and resolve either with its answer or, after `timeoutMs`, with
 * `timedOut`. The abandoned call is never awaited again, so a hung invoke
 * cannot pin a caller's single-flight guard: the guard is released on this
 * promise, not on the call's.
 *
 * A rejection is passed through — the caller owns what a failed listing means.
 */
export function withPollTimeout<T>(
  call: () => Promise<T>,
  timeoutMs: number = REMOTE_BOTS_CALL_TIMEOUT_MS,
): Promise<PollOutcome<T>> {
  return new Promise<PollOutcome<T>>((resolve, reject) => {
    let settled = false;
    const handle = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, value: null });
    }, timeoutMs);
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(handle);
      run();
    };
    let started: Promise<T>;
    try {
      started = call();
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    started.then(
      (value) => finish(() => resolve({ timedOut: false, value })),
      (err) => finish(() => reject(err)),
    );
  });
}

// ── Which of the account's bots this Mac could actually run ─────────────────
//
// Round 4, Defect 7: `hq bot restore` brought a COMPANY bot back as a personal
// local bot. It was credentialed, scaffolded, given a startup agent, counted
// in `restored: 6` with `failed: 0` — and its runtime refused it forever
// ("this installation cannot run it"), at every login. The desktop offered
// that restore, so the desktop must stop offering it: a row this Mac cannot
// run is never counted, never given "Start on this computer", and never
// treated as one of the person's local bots.

/** The CLI's reason for a row it will not run here. */
export const BOT_REASON_COMPANY = "company-bot";
/** The reason adopt/restore refuse with. */
export const BOT_REASON_NOT_RUNNABLE_HERE = "not-runnable-here";

/**
 * Could THIS Mac run the bot behind this listing row?
 *
 * `runnable` is the CLI's own answer and wins whenever it is sent. A listing
 * from a CLI that predates it has only `kind`, and `company` is the one kind
 * that cannot run on a personal Mac — so the fallback is exactly the predicate
 * the runtime enforces, not a guess.
 */
export function remoteBotRunnableHere(bot: RemoteBotRow | null | undefined): boolean {
  if (!bot) return false;
  if (typeof bot.runnable === "boolean") return bot.runnable;
  return (bot.kind ?? "").trim().toLowerCase() !== "company";
}

/**
 * Why this Mac cannot run it, normalised. Null when it can (or when nothing
 * says otherwise). `kind: "company"` answers for a CLI with no `reason` yet.
 */
export function remoteBotNotRunnableReason(bot: RemoteBotRow | null | undefined): string | null {
  if (!bot || remoteBotRunnableHere(bot)) return null;
  const named = (bot.reason ?? "").trim().toLowerCase();
  if (named) return named;
  return BOT_REASON_COMPANY;
}

/**
 * Bots the account owns that are not set up here AND that this Mac could run,
 * in listing order — the only rows any restore surface may offer.
 */
export function botsNotHere(
  remote: readonly RemoteBotRow[] | null | undefined,
): RemoteBotRow[] {
  return (remote ?? []).filter(
    (bot) => bot.here !== true && bot.agentUid.trim() !== "" && remoteBotRunnableHere(bot),
  );
}

/** The action on the "cannot run here" notice, now that there is a real one. */
export const BOT_START_HERE = "Start on this computer";
/** While `hq bot adopt` is running. */
export const BOT_START_HERE_BUSY = "Starting…";

/** Under the notice, so the button is not a leap of faith. */
export const BOT_START_HERE_EXPLAINER =
  "It keeps its name, its memory and this conversation — only the part that runs it is rebuilt here.";

/** A bot whose identity lives in HQ Cloud: nothing on this Mac can run it. */
export const BOT_RUNS_IN_CLOUD_NOT_HERE = "This bot runs in HQ Cloud, not on this Mac.";

/**
 * The `reason` out of the CLI's failure document, lower-cased, or null.
 *
 * `hq bot adopt`/`restore` refuse a company bot with
 * `{"ok":false,"reason":"not-runnable-here",…}`, and that document reaches the
 * app as the failure `message`. `plainBotFailure` correctly refuses to render
 * it, so without reading the reason the person gets "please try again" for
 * something that will never work.
 */
export function botFailureReason(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const reason = (parsed as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.trim() ? reason.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True when a refusal means "not on this Mac, ever" rather than "try again". */
export function isNotRunnableHereReason(reason: string | null | undefined): boolean {
  const key = (reason ?? "").trim().toLowerCase();
  return key === BOT_REASON_COMPANY || key === BOT_REASON_NOT_RUNNABLE_HERE;
}

/** A failed adopt, when there is nothing quotable to say. */
export function adoptFallbackNotice(name: string): string {
  return `Could not bring ${name} back to this computer. Please try again.`;
}

/**
 * Why a local bot's card says it stopped, as far as the ONE remedy it offers
 * is concerned.
 *
 * - `not-runnable-here` — its identity is a company bot's, so no sign-in and
 *   no restart on this Mac can ever start it (round 4, Defect 7).
 * - `runtime-sign-in`   — its coding tool needs the person to sign in again.
 * - `unknown`           — nothing here knows; say only what is true.
 */
export type BotStoppedReason = "not-runnable-here" | "runtime-sign-in" | "unknown";

/**
 * Which remedy a stopped local bot's card should offer.
 *
 * `needsSignIn` is the runtime's own signal; `owned` is the account listing's
 * row for the same identity, which is the only place the desktop can learn
 * that a locally-adopted bot is really a company bot (adopt writes
 * `kind=personal` locally whatever the cloud record says — round 4, Defect 7).
 */
export function botStoppedReasonFor(
  needsSignIn: boolean,
  owned: RemoteBotRow | null | undefined,
): BotStoppedReason {
  // "Not runnable here" outranks everything: no sign-in and no restart can
  // start a company bot's identity on a personal Mac, so offering either
  // would repeat the VM's false remedy in a different sentence.
  if (owned && !remoteBotRunnableHere(owned)) return "not-runnable-here";
  if (needsSignIn) return "runtime-sign-in";
  return "unknown";
}

/**
 * The one sentence under a stopped bot.
 *
 * The VM read `Check that Claude Code is signed in, then start it again` on a
 * bot that could never run, while six sibling bots were online on that very
 * sign-in — the remedy was not just unhelpful, it was false. So the sign-in
 * sentence is offered only when a sign-in is actually what is missing.
 */
export function botStoppedRemedy(reason: BotStoppedReason, runtimeLabel: string): string {
  switch (reason) {
    case "not-runnable-here":
      return `${BOT_RUNS_IN_CLOUD_NOT_HERE} Removing it here is safe — it keeps running in HQ Cloud.`;
    case "runtime-sign-in":
      return `The bot stopped after repeated errors. Check that ${runtimeLabel} is signed in, then start it again.`;
    default:
      return "The bot stopped after repeated errors. Starting it again is worth one try.";
  }
}

/** Retry on a failed adopt. */
export const BOT_START_HERE_RETRY = "Retry";

// ── The one-time prompt after a fresh install ────────────────────────────────

/** Heading on the restore prompt. */
export const BOT_RESTORE_TITLE = "Your bots are waiting";

/**
 * One sentence saying what is true and what "Restore all" does. Counted, so a
 * person with one bot is not told about "bots".
 */
export function botRestorePromptBody(count: number): string {
  const subject = count === 1 ? "One of your bots isn't" : `${count} of your bots aren't`;
  return `${subject} set up on this computer yet. Restoring brings ${
    count === 1 ? "it" : "them"
  } back here — same name, same memory, same conversations.`;
}

export const BOT_RESTORE_ALL = "Restore all";
export const BOT_RESTORE_ALL_BUSY = "Restoring…";
export const BOT_RESTORE_DISMISS = "Not now";
/** Settings › Bots re-offers it after a dismissal. */
export const BOT_RESTORE_FROM_SETTINGS = "Restore my bots";

/** Nothing quotable came back from `hq bot restore`. */
export const BOT_RESTORE_FAILED =
  "Could not bring your bots back right now. Please try again.";

/**
 * Remembered per machine, so the prompt is offered once and not at every
 * launch. Settings › Bots is where a person asks for it again.
 */
export const BOT_RESTORE_DISMISSED_KEY = "hq.bots.restore.dismissed";

/** Minimal `localStorage` shape, so this stays testable and host-agnostic. */
export interface RestorePromptMemory {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** True once this machine has been offered the prompt and said not now. */
export function botRestorePromptDismissed(store: RestorePromptMemory | null | undefined): boolean {
  try {
    return store?.getItem(BOT_RESTORE_DISMISSED_KEY) === "1";
  } catch {
    // A host with storage disabled simply never remembers; better than throwing
    // inside the shell's render path.
    return false;
  }
}

/** Remember the dismissal. Never throws — a failure only costs one re-offer. */
export function rememberBotRestoreDismissed(store: RestorePromptMemory | null | undefined): void {
  try {
    store?.setItem(BOT_RESTORE_DISMISSED_KEY, "1");
  } catch {
    /* storage disabled */
  }
}

// ── Results ─────────────────────────────────────────────────────────────────

/** A row the CLI refused because the bot cannot run on a personal Mac. */
export function botStaysInCloudLine(name: string): string {
  return `${name} runs in HQ Cloud, so there is nothing to bring back to this Mac.`;
}

/** What happened to one bot, in a person's words. */
export function botRestoreRowLine(row: BotRestoreRow): string {
  // `reason` is the CLI's own marker; `detail` carries its failure document on
  // an older build. Either one means the same thing, and it outranks the
  // action: "skipped" for a company bot must not read "already set up here".
  if (isNotRunnableHereReason(row.reason ?? botFailureReason(row.detail))) {
    return botStaysInCloudLine(row.name);
  }
  switch (row.action) {
    case "restored":
      return `${row.name} is back on this computer.`;
    case "repaired":
      return `${row.name} was already here — its sign-in was refreshed.`;
    case "skipped":
    case "would-skip":
      return `${row.name} was already set up here.`;
    case "would-restore":
      return `${row.name} would come back to this computer.`;
    case "would-repair":
      return `${row.name} would have its sign-in refreshed.`;
    case "failed":
    default:
      // `detail` is the CLI's own words on this path: a sentence when it wrote
      // one for a person, the written fallback when it did not.
      return plainBotFailure(row.detail, `${row.name} could not be brought back.`);
  }
}

/** True when a row is one a person should read as gone wrong. */
export function botRestoreRowFailed(row: BotRestoreRow): boolean {
  return row.action === "failed";
}

/** The headline over the per-bot list once a restore finishes. */
export function botRestoreSummary(result: BotRestoreResult): string {
  const back = result.restored;
  const failed = result.failed;
  if (back === 0 && failed === 0) return "Every bot you own was already set up here.";
  if (failed === 0) {
    return back === 1 ? "One bot is back on this computer." : `${back} bots are back on this computer.`;
  }
  if (back === 0) {
    return failed === 1
      ? "One bot could not be brought back."
      : `${failed} bots could not be brought back.`;
  }
  return `${back} of your bots are back; ${failed} could not be brought back.`;
}

// ── When HQ Cloud cannot list your bots ─────────────────────────────────────
//
// The listing is an ENHANCEMENT, never a gate. The owner's VM ran against a
// server that does not have the route yet: every call answered 404, and
// because the app treated the listing as the source of truth for runnability,
// each of the owner's own local bots was drawn as `Cloud`, a wiped bot's DM
// showed a normal composer with no notice, and one message spun for 2 m 39 s.
//
// So a failed listing changes only what the app can OFFER — never what it
// claims. The last good listing is kept and marked stale; the failure is
// classified into the handful of reasons a person can act on; and everything
// about runnability falls back to local evidence (see `bot-runnability.ts`).

/**
 * Why the account's own listing could not be read.
 *
 * - `server-unsupported` — this HQ Cloud has no such route yet. Nothing the
 *   person does here will change that, so no action is offered.
 * - `network`            — it could not be reached; worth another go.
 * - `auth`               — the account is not (or no longer) allowed to ask.
 * - `malformed`          — an answer arrived that could not be read at all.
 */
export type RemoteBotListFailure = "server-unsupported" | "network" | "auth" | "malformed";

/** The account's own listing, plus what happened to the newest attempt. */
export interface RemoteBotListing {
  /**
   * Rows from the last listing that SUCCEEDED; null until one does. When
   * `failure` is set these are stale — an earlier answer, kept because losing
   * them would silently turn every bot on them into a bot the app has never
   * heard of. They are never presented as fresh: the actions that depend on
   * the listing are withdrawn while `failure` is set.
   */
  rows: RemoteBotRow[] | null;
  /** Why the newest attempt failed; null while the listing is fine. */
  failure: RemoteBotListFailure | null;
}

/** Before the first attempt (and on hosts without the command). */
export const NO_REMOTE_BOT_LISTING: RemoteBotListing = { rows: null, failure: null };

/** A listing that came back. */
export function remoteBotListingOk(rows: readonly RemoteBotRow[]): RemoteBotListing {
  return { rows: [...rows], failure: null };
}

/** A listing that did not. The last good rows stay, now stale. */
export function remoteBotListingFailed(
  previous: RemoteBotListing | null | undefined,
  failure: RemoteBotListFailure,
): RemoteBotListing {
  return { rows: previous?.rows ?? null, failure };
}

/**
 * "This server has no such route." The first shapes are the raw HTTP wording
 * an older CLI relayed; the last two are the CLI's own sentence, which says it
 * in plain words and mentions no status code at all — the VM saw exactly that
 * sentence read as "could not be reached" because nothing here matched it.
 */
const UNSUPPORTED_SHAPES: readonly RegExp[] = [
  /→\s*404\b/,
  /\b404\b/,
  /\bnot found\b/i,
  /\bunsupported\b/i,
  /\bunknown (?:route|endpoint|command)\b/i,
  /\bnot implemented\b/i,
  /\bcannot list the bots you own yet\b/i,
  /\bnewer HQ Cloud\b/i,
];

/** "You are not allowed to ask." */
const AUTH_SHAPES: readonly RegExp[] = [
  /→\s*40[13]\b/,
  /\b40[13]\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bnot signed in\b/i,
  /\bsign in again\b/i,
  /\bno (?:api )?(?:token|credentials)\b/i,
];

/**
 * The reasons the CLI itself names, mapped onto ours. Its whole set is
 * `server-unsupported | auth | network | server-error | error`; the last two
 * are network-class here, because "HQ Cloud answered badly" and "HQ Cloud did
 * not answer" are the same thing to the person reading it — worth another go,
 * and never a claim that a bot is missing.
 */
function failureFromReason(reason: string): RemoteBotListFailure | null {
  const key = reason.trim().toLowerCase();
  if (key === "server-unsupported" || key === "unsupported" || key === "not-found") return "server-unsupported";
  if (key === "auth" || key === "unauthorized" || key === "forbidden") return "auth";
  if (key === "network" || key === "offline" || key === "timeout") return "network";
  if (key === "server-error" || key === "error") return "network";
  if (key === "malformed" || key === "unreadable") return "malformed";
  return null;
}

/**
 * The adapter's own `reason` is a transport discriminant (`error` /
 * `unavailable`), not one of the CLI's — it says only THAT the call failed.
 * Reading it as a CLI reason would classify every failure as network-class and
 * silence the text fallback below, so those two names are ignored here.
 */
const ADAPTER_TRANSPORT_REASONS: ReadonlySet<string> = new Set(["error", "unavailable"]);

/**
 * Classify a failed `hq bot list --remote`.
 *
 * Two shapes are tolerated on purpose. The CLI's own contract is a JSON
 * document — `{ok:false, reason, message, bots:[]}` — and when it reaches the
 * app that reason is used verbatim; it is the only thing that tells
 * "this HQ Cloud is too old" apart from "HQ Cloud did not answer" without
 * guessing from prose. An older CLI, or any other failure, relays plain text
 * instead (`HQ API /v1/agents/mine → 404: Not found`, or the CLI's own
 * sentence), so the text is read for the same few conditions. Anything
 * unrecognised is `network`: "try again" is the safe guess, because it never
 * claims a bot is missing and never hides a route that does exist.
 */
export function classifyRemoteBotFailure(
  adapterReason: string | null | undefined,
  message: string | null | undefined,
): RemoteBotListFailure {
  const text = (message ?? "").trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = parsed as { reason?: unknown; message?: unknown };
        if (typeof body.reason === "string") {
          const named = failureFromReason(body.reason);
          if (named) return named;
        }
        if (typeof body.message === "string" && body.message.trim()) {
          return classifyRemoteBotFailure(adapterReason, body.message);
        }
      }
    } catch {
      // Not the contract after all — fall through and read it as text.
    }
  }
  const relayed = (adapterReason ?? "").trim().toLowerCase();
  if (relayed && !ADAPTER_TRANSPORT_REASONS.has(relayed)) {
    const named = failureFromReason(relayed);
    if (named) return named;
  }
  if (!text) return "network";
  if (UNSUPPORTED_SHAPES.some((shape) => shape.test(text))) return "server-unsupported";
  if (AUTH_SHAPES.some((shape) => shape.test(text))) return "auth";
  return "network";
}

/** The listing route is missing, so nothing can be brought back yet. */
export const BOT_RESTORE_NEEDS_NEWER_CLOUD = "Restoring bots needs a newer HQ Cloud.";
/** It could not be reached, or the answer could not be read. */
export const BOT_RESTORE_CLOUD_UNREACHABLE =
  "HQ Cloud couldn't be reached just now, so the bots you own on other computers aren't listed.";
/** The account is not allowed to ask. */
export const BOT_RESTORE_CLOUD_SIGN_IN =
  "Sign in to HQ again to see the bots you own on other computers.";

/**
 * One plain sentence for a failed listing — the only thing a person is told
 * about it. Null while the listing is fine, so the sentence never appears on
 * a working app. Nothing the CLI or the API said is ever part of it.
 */
export function remoteBotListingNotice(failure: RemoteBotListFailure | null | undefined): string | null {
  switch (failure) {
    case "server-unsupported":
      return BOT_RESTORE_NEEDS_NEWER_CLOUD;
    case "auth":
      return BOT_RESTORE_CLOUD_SIGN_IN;
    case "network":
    case "malformed":
      return BOT_RESTORE_CLOUD_UNREACHABLE;
    default:
      return null;
  }
}

/**
 * A bot the person owns that this computer cannot run — the one question the
 * DM notice, the sidebar chip and the send gate all ask.
 *
 * LOCAL EVIDENCE FIRST. A bot on this Mac's own listing runs here, whatever
 * the account listing says (a stale `here:false` must never take a working bot
 * away). What is left comes from two places: the account listing when it
 * answered, and this computer's own trace of bots it has run when it did not.
 * A peer with neither — a cloud or fleet bot — is not in here at all, so its
 * behaviour is untouched.
 */
export interface OwnedBotNotHere {
  /** Local folder name, which is what `hq bot adopt` takes. */
  name: string;
  agentUid: string;
  /** True when the account's own listing is what said so. */
  fromListing: boolean;
}

export function ownedBotsNotHere(
  listing: RemoteBotListing | null | undefined,
  trace: LocalBotTrace,
  local: readonly LocalBotRow[] | null | undefined,
): OwnedBotNotHere[] {
  const out: OwnedBotNotHere[] = [];
  const seen = new Set<string>();
  for (const bot of botsNotHere(listing?.rows)) {
    const uid = bot.agentUid.trim();
    if (seen.has(uid) || botRunsHere(local, uid)) continue;
    seen.add(uid);
    out.push({ name: bot.name, agentUid: uid, fromListing: true });
  }
  for (const bot of localBotsTracedButGone(trace, local)) {
    if (seen.has(bot.agentUid)) continue;
    seen.add(bot.agentUid);
    out.push({ name: bot.name, agentUid: bot.agentUid, fromListing: false });
  }
  return out;
}

/** The one in that list behind this agent uid, or null. */
export function ownedBotNotHere(
  owned: readonly OwnedBotNotHere[],
  agentUid: string | null | undefined,
): OwnedBotNotHere | null {
  const uid = (agentUid ?? "").trim();
  if (!uid) return null;
  return owned.find((bot) => bot.agentUid === uid) ?? null;
}
