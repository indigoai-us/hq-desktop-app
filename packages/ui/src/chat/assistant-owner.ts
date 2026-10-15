/**
 * THE ASSISTANT HAS ONE OWNER.
 *
 * The assistant is the setup bot: the bot a first run names ("Hazel") and
 * that stays as the person's helper afterwards. Its handle on this computer
 * is the reserved `setup`; the cloud knows it by the slug `setup-<owner8>`
 * and, on a new enough HQ Cloud, by `role: "assistant"`.
 *
 * Before this module three parts of the app could bring it onto a computer
 * with no coordination: the visual first run's create, #welcome's start and
 * the automatic restore. On the v0.11.4 release check the restore adopted it
 * a second before the first run's create, the create failed with "already
 * set up on this computer", and "Couldn't start Hazel" stayed on screen next
 * to a running bot that called itself by yesterday's name. The status lines
 * read "setup is back online." and "setup is thinking…".
 *
 * So, here:
 *  - `createAssistantOwner` is the only thing that creates, adopts or
 *    recovers the assistant. Its operations run one at a time, and every one
 *    re-reads the bot list first, so the second of two callers finds the
 *    assistant the first one made.
 *  - Whether the assistant is starting or could not start is worked out from
 *    the bot list plus the last attempt (`assistantStatus`). Nothing keeps an
 *    error: once the assistant is in the list, no surface can say it could
 *    not start.
 *  - `assistantName` is the one name lookup. It never returns a handle or a
 *    slug, and falls back to "Your assistant".
 *  - Automatic restore never takes the assistant (`isAssistantRecord`).
 *
 * Pure apart from the host callbacks: every decision is unit-tested without a
 * DOM. `DesktopApp.svelte` supplies the calls and renders the results.
 */

import type { LocalBotRow } from "@hq/platform";

import {
  ASSISTANT_ROLE,
  SETUP_BOT_NAME,
  findSetupBot,
  isAssistantRecord,
  isAssistantSlug,
  type SetupBotRef,
} from "./setup-bot.js";

export { ASSISTANT_ROLE, isAssistantRecord, isAssistantSlug };

/** The assistant among this computer's bots, if it is here. */
export const findAssistant = findSetupBot;

/** What the assistant is called when no name for it is known. */
export const ASSISTANT_FALLBACK_NAME = "Your assistant";

/**
 * The first hq-cli release whose `hq bot create setup --display-name X --json`
 * is idempotent and lock-protected (hq-cli #1812): it answers `outcome:
 * "created" | "adopted" | "existing"` with `agentUid`, `displayName` and
 * `role`, and applies the name in every case (contract section 3). Older CLIs
 * keep the desktop's own create path.
 */
export const ASSISTANT_CLI_MIN_VERSION: string | null = "5.345.87";

function parseVersion(raw: unknown): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when the installed hq-cli owns creating and adopting the assistant
 * (contract section 3). Unknown or unreadable versions count as older.
 */
export function cliOwnsAssistantCreate(
  cliVersion: string | null | undefined,
  minVersion: string | null = ASSISTANT_CLI_MIN_VERSION,
): boolean {
  const have = parseVersion(cliVersion);
  const need = parseVersion(minVersion);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i]! > need[i]!;
  }
  return true;
}

/** A name, cleaned; empty when it is missing or is only a handle or slug. */
function usableName(value: string | null | undefined): string {
  const name = (value ?? "").trim().replace(/\s+/g, " ");
  if (!name || isAssistantSlug(name)) return "";
  return name;
}

/** Everything the app knows that could name the assistant. */
export interface AssistantNameSources {
  /** The name the person confirmed on this computer this session. */
  confirmed?: string | null;
  /** The bot list's `displayName` for it. */
  listed?: string | null;
  /** The cloud roster's name for it. */
  cloud?: string | null;
  /** This computer's saved copy (`bot-display-names.ts`). */
  cached?: string | null;
  /**
   * True when the installed hq-cli reports the cloud name in the bot list
   * (see `cliOwnsAssistantCreate`). An older CLI reports whatever its own
   * config file says, which can be a name from an earlier install.
   */
  listIsCloudName?: boolean;
}

/**
 * THE name lookup for the assistant, used by every person-facing surface:
 * the sidebar, the conversation title, "is thinking…", #welcome, the first
 * run, the restore lines and notifications. Never a handle or a slug; with
 * nothing usable it is "Your assistant".
 */
export function assistantName(sources: AssistantNameSources = {}): string {
  const order = sources.listIsCloudName
    ? [sources.confirmed, sources.listed, sources.cloud, sources.cached]
    : [sources.confirmed, sources.cached, sources.cloud, sources.listed];
  for (const candidate of order) {
    const name = usableName(candidate);
    if (name) return name;
  }
  return ASSISTANT_FALLBACK_NAME;
}

/**
 * A name about to be shown for some agent: the assistant's handle or slug
 * becomes "Your assistant", anything else is returned as it is. For surfaces
 * that only have a sender's name (the OS notification, a message author).
 */
export function personFacingAgentName(name: string | null | undefined): string {
  const value = (name ?? "").trim();
  return isAssistantSlug(value) ? ASSISTANT_FALLBACK_NAME : value;
}

/**
 * Put the assistant's name on rows that carry a sender or contact name: the
 * row for `assistant.agentUid` gets `assistant.name`, and any agent row still
 * named by the assistant's handle or slug reads "Your assistant". Other rows
 * are returned untouched (the same objects, so nothing re-renders for them).
 */
export function withAssistantNames<T extends object>(
  rows: readonly T[],
  assistant: { agentUid: string; name: string } | null | undefined,
  uidKey: string,
  nameKey: string,
): T[] {
  const uid = assistant?.agentUid.trim() ?? "";
  let changed = false;
  const out = rows.map((row) => {
    const fields = row as Record<string, unknown>;
    const rowUid = typeof fields[uidKey] === "string" ? (fields[uidKey] as string).trim() : "";
    const current = typeof fields[nameKey] === "string" ? (fields[nameKey] as string) : "";
    const marked = typeof fields.agentRole === "string" && fields.agentRole.trim().toLowerCase() === ASSISTANT_ROLE;
    let next: string | null = null;
    if (uid && rowUid === uid) next = assistant!.name;
    else if (rowUid.startsWith("agt_") && (isAssistantSlug(current) || (marked && !current.trim()))) {
      next = ASSISTANT_FALLBACK_NAME;
    }
    if (next === null || next === current) return row;
    changed = true;
    return { ...row, [nameKey]: next };
  });
  return changed ? out : (rows as T[]);
}

// ── Starting it ─────────────────────────────────────────────────────────────

/** What the last start or recovery did. Kept as an event, never shown as one. */
export type AssistantAttempt =
  | { state: "idle" }
  | { state: "running"; name: string | null }
  | { state: "done"; name: string | null; bot: SetupBotRef }
  | { state: "failed"; name: string | null; reason: string }
  /**
   * A recovery the app tried by itself (nobody asked) did not bring it back.
   * Nobody is told "couldn't start" for it: the conversation's own notice and
   * the Restore prompt are the honest surfaces.
   */
  | { state: "recover-failed" };

/** Where the assistant stands, worked out from the bot list and the last attempt. */
export type AssistantStatus =
  | { state: "absent" }
  | { state: "starting"; name: string | null }
  | { state: "ready"; bot: SetupBotRef }
  | { state: "failed"; name: string | null; reason: string };

/**
 * The assistant's status. The bot list wins: an assistant in the list is
 * never "failed", whatever the last attempt said, and a failed attempt only
 * counts while the assistant is not here.
 */
export function assistantStatus(
  attempt: AssistantAttempt,
  here: SetupBotRef | null,
): AssistantStatus {
  if (here) return attempt.state === "running" ? { state: "starting", name: attempt.name } : { state: "ready", bot: here };
  if (attempt.state === "running") return { state: "starting", name: attempt.name };
  if (attempt.state === "done") return { state: "ready", bot: attempt.bot };
  if (attempt.state === "failed") return { state: "failed", name: attempt.name, reason: attempt.reason };
  // A background recovery that failed, or nothing tried yet.
  return { state: "absent" };
}

export type AssistantOutcome = "created" | "adopted" | "existing";

/** How a start ended for the caller. */
export type AssistantStartResult =
  | { ok: true; bot: SetupBotRef; outcome: AssistantOutcome }
  | { ok: false; reason: string };

/** What the host's create call answered. */
export type AssistantCreateResult =
  | { ok: true; agentUid: string; outcome: AssistantOutcome | null }
  | { ok: false; reason: string; raw?: string };

export interface AssistantOwnerHost {
  /** Re-read this computer's bot list and answer the fresh rows. */
  refreshLocal(): Promise<readonly LocalBotRow[]>;
  /**
   * The coding tool to run the assistant with, from the one readiness signal
   * restore and the first run share. Null when none is signed in.
   */
  runtime(): Promise<LocalBotRow["runtime"] | null>;
  /** True when the installed hq-cli creates and adopts idempotently (contract section 3). */
  cliOwnsCreate(): Promise<boolean>;
  /** `hq bot create setup --display-name <name> …` with the caller's intro and kickoff. */
  create(name: string, runtime: LocalBotRow["runtime"]): Promise<AssistantCreateResult>;
  /** `hq bot adopt setup`, when the host has it. */
  adopt?(handle: string): Promise<{ ok: true } | { ok: false; raw: string }>;
  /**
   * The assistant on the account's own listing when it is not on this
   * computer. `adoptable` is false when it is running on another computer
   * (bringing it here would take it off that one) or cannot run here.
   */
  cloudAssistant?(): { ref: SetupBotRef; adoptable: boolean } | null;
  /** Older hq-cli only: put the person's name on an assistant that was already there. */
  rename(bot: SetupBotRef, name: string): Promise<void>;
  /** The account's assistant in the cloud roster, when it is not here (older hq-cli only). */
  findCloud?(): Promise<SetupBotRef | null>;
  /** Sentences, in the app's own words. */
  copy: {
    noRuntime(): string;
    unavailable: string;
    alreadyElsewhere: string;
    couldNotStart(name: string | null): string;
  };
  onchange?(attempt: AssistantAttempt): void;
  /** True while an operation that may bring the assistant here runs or waits in the queue. */
  onbusy?(busy: boolean): void;
}

/** A start request. */
export interface AssistantStartRequest {
  /** The name the person chose: applied whether the assistant is new or already here. */
  name?: string | null;
  /** A name for an assistant this start has to create; an existing one keeps its own. */
  nameIfNew?: string | null;
}

/**
 * The CLI's words for "this bot is already here, or already in the account":
 * hq-cli's own "already set up on this computer" (the adopt guard), hq-pro's
 * 409, and the local "already exists". All mean: re-read and use it.
 */
export function isAssistantAlreadyThere(raw: string | null | undefined): boolean {
  const text = (raw ?? "").toLowerCase();
  if (!text) return false;
  if (/already set up on this computer/.test(text)) return true;
  // hq-cli's own 409 wording on a fresh install: "You already have a bot
  // named "setup" in HQ — it is just not set up on this computer. Bring it
  // back with: hq bot adopt setup".
  if (/already have a bot named/.test(text)) return true;
  if (/already exists/.test(text)) return true;
  if (/\b(?:entity_exists|already_exists|duplicate_entity)\b/.test(text)) return true;
  if (/→\s*409\b/.test(text)) return true;
  return /\b409\b/.test(text) && /conflict/.test(text);
}

export interface AssistantOwner {
  /**
   * Bring the assistant here: find it, adopt it or create it. Runs after any
   * operation in flight, never alongside it, and re-reads the bot list first,
   * so the second of two callers finds the assistant the first one made.
   */
  start(request: AssistantStartRequest): Promise<AssistantStartResult>;
  /**
   * Bring an assistant the account owns back to this computer
   * (`hq bot adopt setup`), with no new name, intro or kickoff.
   */
  recover(): Promise<AssistantStartResult>;
  /**
   * Run another write on the assistant (a process start, a person-driven
   * adopt or restore) in the same queue, so it never overlaps a create.
   */
  exclusive<T>(op: () => Promise<T>, options?: { touchesAssistant?: boolean }): Promise<T>;
  /** The last attempt. */
  attempt(): AssistantAttempt;
  /** True while an operation runs or waits. */
  busy(): boolean;
}

export function createAssistantOwner(host: AssistantOwnerHost): AssistantOwner {
  let attempt: AssistantAttempt = { state: "idle" };
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  /** Queued or running operations that may create, adopt or start the assistant. */
  let assistantOps = 0;

  const set = (next: AssistantAttempt): void => {
    attempt = next;
    host.onchange?.(next);
  };

  function exclusive<T>(op: () => Promise<T>, options: { touchesAssistant?: boolean } = {}): Promise<T> {
    const touches = options.touchesAssistant !== false;
    pending += 1;
    if (touches) {
      assistantOps += 1;
      if (assistantOps === 1) host.onbusy?.(true);
    }
    const run = queue.then(op, op);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      pending -= 1;
      if (touches) {
        assistantOps -= 1;
        if (assistantOps === 0) host.onbusy?.(false);
      }
    });
  }

  /**
   * The assistant as this computer's bot list shows it right now. Nothing is
   * remembered between operations: a later operation trusts only the list.
   */
  async function here(): Promise<SetupBotRef | null> {
    return findAssistant(await host.refreshLocal());
  }

  function succeed(bot: SetupBotRef, name: string | null, outcome: AssistantOutcome): AssistantStartResult {
    set({ state: "done", name, bot });
    return { ok: true, bot, outcome };
  }

  function fail(name: string | null, reason: string): AssistantStartResult {
    set({ state: "failed", name, reason });
    return { ok: false, reason };
  }

  /** Already here: an older hq-cli cannot rename it, so the app does. */
  async function keep(bot: SetupBotRef, name: string | null, cliOwns: boolean): Promise<AssistantStartResult> {
    if (name && !cliOwns) await host.rename(bot, name);
    return succeed(bot, name, "existing");
  }

  async function adoptHere(name: string | null): Promise<AssistantStartResult> {
    if (!host.adopt) return fail(name, host.copy.unavailable);
    const result = await host.adopt(SETUP_BOT_NAME);
    const found = await here();
    if (found) return succeed(found, name, "adopted");
    if (!result.ok) console.warn("[hq-desktop] assistant adopt failed:", result.raw);
    return fail(name, host.copy.couldNotStart(name));
  }

  async function runStart(request: AssistantStartRequest): Promise<AssistantStartResult> {
    const chosen = request.name?.trim() || null;
    const label = chosen ?? (request.nameIfNew?.trim() || null);
    set({ state: "running", name: label });
    const cliOwns = await host.cliOwnsCreate();
    const existing = await here();
    // Here, and either no new name or a CLI that cannot apply one in create.
    if (existing && (!chosen || !cliOwns)) return keep(existing, chosen, cliOwns);
    if (!existing && !chosen) {
      // Not here, nobody chose a name, and the account already has one: bring
      // back the one the account's listing shows, as it is, rather than make
      // one under a picked name. One running on another computer is opened,
      // never taken (its conversation says what starting it here costs), and
      // so is one only the cloud roster shows.
      const listed = host.cloudAssistant?.() ?? null;
      // Brought back as it is: a failure never names it with a picked name.
      if (listed?.adoptable) return adoptHere(null);
      if (listed) return keep(listed.ref, null, cliOwns);
      const cloud = (await host.findCloud?.()) ?? null;
      if (cloud) return keep(cloud, null, cliOwns);
    }
    const runtime = await host.runtime();
    if (!runtime) {
      if (existing) return keep(existing, chosen, false);
      return fail(label, host.copy.noRuntime());
    }
    if (!label) return fail(label, host.copy.couldNotStart(null));
    const created = await host.create(label, runtime);
    if (created.ok) {
      const listed = await here();
      if (created.agentUid) {
        const bot: SetupBotRef = listed?.agentUid === created.agentUid ? listed : { agentUid: created.agentUid, handle: SETUP_BOT_NAME };
        // A create that adopted the account's assistant applied this start's
        // name, intro and kickoff (hq-cli #1812): to every caller it is a
        // made assistant. (The visual first run passes no kickoff; its
        // assistant starts from the handoff note, whatever the outcome.)
        const outcome = created.outcome === "adopted" ? "created" : (created.outcome ?? (existing ? "existing" : "created"));
        return succeed(bot, label, outcome);
      }
      // An hq that answered without a uid: find it on the list.
      return listed ? succeed(listed, label, "created") : fail(label, host.copy.couldNotStart(label));
    }
    // "It is already there" is the opposite of a failure: someone else (a
    // restore, another window, an earlier install) got there first.
    if (isAssistantAlreadyThere(created.raw ?? created.reason)) {
      const found = await here();
      if (found) return keep(found, chosen, false);
      // The account owns it but this computer does not run it (a fresh
      // install, a second Mac) and this hq-cli's create stopped at the
      // cloud's 409. Bring it here the way "Start on this computer" does,
      // then name it. Naming the cloud record alone left the assistant bound
      // to the other computer: the owner's fresh install showed the new name
      // over "set up on another computer" (run 2026-10-15). One running on
      // another computer is still never taken.
      const listed = host.cloudAssistant?.() ?? null;
      if (host.adopt && (!listed || listed.adoptable)) {
        const adopted = await host.adopt(SETUP_BOT_NAME);
        const brought = await here();
        if (brought) {
          if (chosen) await host.rename(brought, chosen);
          return succeed(brought, chosen, "adopted");
        }
        if (!adopted.ok) console.warn("[hq-desktop] assistant adopt after create failed:", adopted.raw);
      }
      const cloud = (await host.findCloud?.()) ?? null;
      if (cloud) return keep(cloud, chosen, false);
      return fail(label, host.copy.alreadyElsewhere);
    }
    // Whatever the create said, an assistant in the list is here.
    const after = await here();
    if (after) return keep(after, chosen, false);
    return fail(label, created.reason || host.copy.couldNotStart(label));
  }

  async function runRecover(): Promise<AssistantStartResult> {
    set({ state: "running", name: null });
    const existing = await here();
    if (existing) return succeed(existing, null, "existing");
    const result = await adoptHere(null);
    if (!result.ok) set({ state: "recover-failed" });
    return result;
  }

  function guarded(run: () => Promise<AssistantStartResult>, name: string | null): Promise<AssistantStartResult> {
    return exclusive(async () => {
      try {
        return await run();
      } catch (err) {
        // A sentence, never a stack: the surfaces render this.
        console.warn("[hq-desktop] assistant start threw:", err);
        return fail(name, host.copy.couldNotStart(name));
      }
    });
  }

  return {
    start: (request) => guarded(() => runStart(request), request.name?.trim() || request.nameIfNew?.trim() || null),
    recover: () => guarded(runRecover, null),
    exclusive,
    attempt: () => attempt,
    busy: () => pending > 0,
  };
}
