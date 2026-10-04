/**
 * Cancel for the new cloud bot flow.
 *
 * Cancel stops a create and removes whatever the create already made. A bot
 * that exists is removed by asking the server to decommission it. The request
 * is safe to repeat, and the server answers in one of a few ways this module
 * reads: finished, still working, busy, or refused until the request names the
 * bot's running computer.
 *
 * Nothing here talks to the server directly. The caller passes the removal
 * request in, so tests run against fakes.
 */

/** Where a cancelled bot stands. */
export type BotRemovalPhase =
  /** Cancel was pressed while the create request was still out. */
  | "stopping"
  /** The bot exists and the server is removing it. */
  | "removing"
  /** The server said nothing is left. */
  | "removed"
  /** The bot exists and the removal did not finish. */
  | "failed"
  /** The create request ended without making a bot. */
  | "not-created"
  /**
   * The create request got no answer, and reading the company's bots did
   * not settle it. The bot may exist. Nothing is claimed either way.
   */
  | "unconfirmed";

export interface BotRemoval {
  /** Local id for this cancel. */
  id: string;
  name: string;
  companyUid: string;
  /** Empty until the create request names the bot. */
  agentUid: string;
  /** A channel an older server made for the bot. Usually empty. */
  channelId: string;
  /** The brain chosen at creation. Kept so a bot the person keeps can go on starting. */
  brain: BotRemovalBrain | null;
  phase: BotRemovalPhase;
  /** True when the bot had a sidebar row before Cancel (it was already starting). */
  hadRow: boolean;
  /** When Cancel was pressed. */
  startedAt: number;
  /** Why a removal did not finish. Null unless the phase is "failed". */
  problem: BotRemovalProblem | null;
}

export type BotRemovalBrain = "codex" | "claude" | "grok";

export type BotRemovalProblem =
  /** The request failed, or the server stayed busy past the wait. Worth another try. */
  | "error"
  /**
   * The server accepted the removal and was still taking the bot down when
   * this window stopped asking. The bot is on its way out: it is not kept,
   * and it is not shown as a bot that is starting.
   */
  | "still-removing"
  /** The server allows only an owner or admin of the company to remove a bot. */
  | "not-allowed"
  /** The bot is the one that comes with the company's plan. The server keeps it while the plan is active. */
  | "plan-bot"
  /** The create request named no bot id, so there is nothing to ask the server to remove. */
  | "unknown-bot";

export interface BotRemovalRequestOptions {
  confirmDestroyInstanceId?: string | null;
}

/** The host's removal request. Mirrors `adapter.agents.deprovision`. */
export type RemoveBotRequest = (
  agentUid: string,
  options?: BotRemovalRequestOptions,
) => Promise<unknown>;

/** Server codes this module acts on. Anything else is a plain failure. */
export const REMOVAL_NEEDS_MACHINE_CODE = "AGENTS_V2_BOX_PROTECTED";
export const REMOVAL_BUSY_CODE = "STEP_ALREADY_IN_PROGRESS";
export const REMOVAL_PLAN_BOT_CODE = "TEAM_SETUP_AGENT_PROTECTED";
/**
 * The server's refusal for a caller who is not an owner or admin: an HTTP 403.
 * A host that keeps the server's own code instead (`FORBIDDEN`) is read by
 * `status`, or by the shape of the code (see `readBotRemovalAnswer`).
 */
export const REMOVAL_NOT_ALLOWED_CODE = "http-403";

/** How long to wait before asking again while the server is still working. */
export const BOT_REMOVAL_RETRY_MS = 5_000;
/**
 * Requests one removal run may make that the server did not accept (busy,
 * a machine to name) before it reports a failure.
 */
export const BOT_REMOVAL_MAX_REQUESTS = 36;
/**
 * Times the server may answer "still removing" before this window stops
 * asking. Taking a bot's computer down can run well past three minutes, and
 * a removal the server accepted is not a failure: 240 answers at 5 seconds
 * is 20 minutes.
 */
export const BOT_REMOVAL_MAX_WORKING_REQUESTS = 240;
/** Failed requests in a row before the run reports a failure. */
export const BOT_REMOVAL_MAX_FAILURES = 3;

export type BotRemovalAnswer =
  | { kind: "removed" }
  /** Removal started and is not finished. Ask again. */
  | { kind: "working" }
  /** The server is in the middle of a setup step for this bot. Ask again. */
  | { kind: "busy" }
  /** The server wants the request to name the bot's running computer. */
  | { kind: "name-machine"; instanceId: string }
  /** The server will not remove this bot for this person. Asking again changes nothing. */
  | { kind: "refused"; problem: "not-allowed" | "plan-bot" }
  | { kind: "failed" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Read one answer to a removal request. */
export function readBotRemovalAnswer(result: unknown): BotRemovalAnswer {
  const answer = record(result);
  if (!answer) return { kind: "failed" };
  if (answer.ok === true) {
    const value = record(answer.value);
    const phase = text(record(value?.setupState)?.phase).toLowerCase();
    // Only the server's own word counts. A success with no such word means
    // the removal has started, and the bot is not shown as removed.
    if (value?.terminal === true || phase === "deprovisioned") return { kind: "removed" };
    return { kind: "working" };
  }
  const code = text(answer.code);
  // The HTTP status of the refusal, from the host when it keeps one, else
  // from an `http-403` style code. A refusal with a code of its own
  // (`FORBIDDEN`) has no `http-` code, which is why the status is read too.
  const status =
    typeof answer.status === "number" ? answer.status : Number(code.match(/^http-(\d{3})$/i)?.[1] ?? NaN);
  if (code === REMOVAL_BUSY_CODE) return { kind: "busy" };
  if (code === REMOVAL_PLAN_BOT_CODE) return { kind: "refused", problem: "plan-bot" };
  const instanceId = text(answer.instanceId);
  if (code === REMOVAL_NEEDS_MACHINE_CODE && instanceId) {
    return { kind: "name-machine", instanceId };
  }
  // The server no longer has the bot. That is what the person asked for, so
  // it is not reported as a removal that failed.
  if (status === 404 || /(^|_)NOT_FOUND$/i.test(code)) return { kind: "removed" };
  if (status === 403 || code === REMOVAL_NOT_ALLOWED_CODE || /(^|_)(FORBIDDEN|NOT_ALLOWED)$/i.test(code)) {
    return { kind: "refused", problem: "not-allowed" };
  }
  return { kind: "failed" };
}

export interface BotRemovalRunOptions {
  /** Test seam. Production waits on a timer that ends early when the run is stopped. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retryMs?: number;
  maxRequests?: number;
  /** How many "still removing" answers to sit through. */
  maxWorkingRequests?: number;
  maxFailures?: number;
  /**
   * Stops the run. Nothing more is asked once it is aborted, and the run
   * resolves "stopped". The sidebar aborts it when it goes away; the removal
   * is picked up again from what was written down.
   */
  signal?: AbortSignal;
  /**
   * Test seam. Resolves once the window can be seen. Production waits for the
   * document to stop being hidden: nothing is asked while nobody can see
   * the answer.
   */
  whenVisible?: (signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish);
  });
}

/** Resolves at once when the window can be seen, else when it next can, or when the run is stopped. */
function whenDocumentVisible(signal?: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || !document.hidden || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const check = (): void => {
      if (document.hidden && !signal?.aborted) return;
      document.removeEventListener("visibilitychange", check);
      signal?.removeEventListener("abort", check);
      resolve();
    };
    document.addEventListener("visibilitychange", check);
    signal?.addEventListener("abort", check);
  });
}

export type BotRemovalOutcome = "removed" | BotRemovalProblem;
/** How a removal run ended. "stopped": it was told to stop, and decided nothing. */
export type BotRemovalRun = BotRemovalOutcome | "stopped";

/**
 * Ask the server to remove a bot and keep asking until it says the bot is
 * gone, or until the run gives up. Resolves "removed" only on the server's
 * word (which includes a server that no longer has the bot). Never throws.
 *
 * A removal the server accepted and is still carrying out is not a failure.
 * Those answers have their own, longer allowance, and a run that outlasts it
 * resolves "still-removing", never "error".
 *
 * The run asks nothing while the window is hidden, and nothing more once
 * its `signal` is aborted.
 */
export async function runBotRemoval(
  agentUid: string,
  remove: RemoveBotRequest,
  options: BotRemovalRunOptions = {},
): Promise<BotRemovalRun> {
  const uid = agentUid.trim();
  if (!uid) return "unknown-bot";
  const sleep = options.sleep ?? defaultSleep;
  const whenVisible = options.whenVisible ?? whenDocumentVisible;
  const signal = options.signal;
  const retryMs = options.retryMs ?? BOT_REMOVAL_RETRY_MS;
  const maxRequests = Math.max(1, options.maxRequests ?? BOT_REMOVAL_MAX_REQUESTS);
  const maxWorking = Math.max(1, options.maxWorkingRequests ?? BOT_REMOVAL_MAX_WORKING_REQUESTS);
  const maxFailures = Math.max(1, options.maxFailures ?? BOT_REMOVAL_MAX_FAILURES);
  let machine: string | null = null;
  let failures = 0;
  /** Requests the server did not accept. A "still removing" answer is not one of them. */
  let asked = 0;
  let working = 0;
  while (asked < maxRequests) {
    await whenVisible(signal);
    if (signal?.aborted) return "stopped";
    let answer: BotRemovalAnswer;
    try {
      answer = readBotRemovalAnswer(
        await remove(uid, machine ? { confirmDestroyInstanceId: machine } : undefined),
      );
    } catch {
      answer = { kind: "failed" };
    }
    // What the server said stands, whether or not anyone still waits for it.
    if (answer.kind === "removed") return "removed";
    if (signal?.aborted) return "stopped";
    if (answer.kind === "refused") return answer.problem;
    if (answer.kind === "working") {
      // The server took the removal and is carrying it out.
      failures = 0;
      working += 1;
      if (working >= maxWorking) return "still-removing";
      await (signal ? sleep(retryMs, signal) : sleep(retryMs));
      continue;
    }
    asked += 1;
    if (answer.kind === "name-machine") {
      // The same machine refused twice: naming it did not help.
      if (machine === answer.instanceId) return "error";
      machine = answer.instanceId;
      continue;
    }
    if (answer.kind === "failed") {
      failures += 1;
      if (failures >= maxFailures) return "error";
    } else {
      failures = 0;
    }
    await (signal ? sleep(retryMs, signal) : sleep(retryMs));
  }
  return "error";
}

/** The removal runs that are asking the server right now, by bot. */
const liveRemovalRuns = new Map<string, AbortController>();

/**
 * Start a removal run for a bot, and hand back the way to stop it.
 *
 * There is never more than one run per bot: starting one stops the run that
 * was already going for the same bot (a sidebar that was rebuilt starts its
 * own, and the old sidebar's must not go on beside it).
 */
export function startBotRemoval(
  agentUid: string,
  remove: RemoveBotRequest,
  options: Omit<BotRemovalRunOptions, "signal"> = {},
): { done: Promise<BotRemovalRun>; stop: () => void } {
  const uid = agentUid.trim();
  liveRemovalRuns.get(uid)?.abort();
  const controller = new AbortController();
  if (uid) liveRemovalRuns.set(uid, controller);
  const done = runBotRemoval(uid, remove, { ...options, signal: controller.signal }).finally(() => {
    if (liveRemovalRuns.get(uid) === controller) liveRemovalRuns.delete(uid);
  });
  return { done, stop: () => controller.abort() };
}

/** The one line the person reads about a cancelled bot. */
export function botRemovalLine(removal: Pick<BotRemoval, "name" | "phase" | "problem">): string {
  const name = removal.name.trim() || "Your bot";
  switch (removal.phase) {
    case "stopping":
      return `Cancelling ${name}. Anything already set up for it will be removed.`;
    case "removing":
      return `Removing ${name}. This can take a minute.`;
    case "removed":
      return `${name} was removed.`;
    case "not-created":
      return `${name} was cancelled. Nothing was created.`;
    case "unconfirmed":
      return `We couldn't confirm whether ${name} was created. If it shows up in your bots, remove it from Settings, under Bots.`;
    case "failed":
      if (removal.problem === "not-allowed") {
        return `${name} was not removed. Only an owner or admin of this company can remove a bot. Ask one of them to remove ${name}.`;
      }
      if (removal.problem === "plan-bot") {
        return `${name} was not removed. It is the bot that comes with this company's plan, and it stays while the plan is active.`;
      }
      if (removal.problem === "unknown-bot") {
        return `We couldn't remove ${name}. It still exists. Remove it from Settings, under Bots.`;
      }
      if (removal.problem === "still-removing") {
        return `${name} is still being removed. This is taking longer than usual.`;
      }
      return `We couldn't remove ${name}. It still exists.`;
  }
}

/** Asking again can help when the request itself failed, or the server had not finished. */
export function canRetryBotRemoval(removal: Pick<BotRemoval, "phase" | "agentUid" | "problem">): boolean {
  const problem = removal.problem ?? "error";
  return (
    removal.phase === "failed" &&
    removal.agentUid.trim().length > 0 &&
    (problem === "error" || problem === "still-removing")
  );
}

/** What Try again says for this removal: asking a server that is still at it is a check. */
export function botRemovalRetryLabel(removal: Pick<BotRemoval, "problem">): string {
  return removal.problem === "still-removing" ? "Check again" : "Try again";
}

/**
 * True when putting a failed removal away leaves a bot that goes on starting.
 * Not so for a bot the server is in the middle of taking down: that one is
 * on its way out, and it must not get a waiting screen back.
 */
export function botRemovalKeepsBot(removal: Pick<BotRemoval, "phase" | "agentUid" | "problem">): boolean {
  return canRetryBotRemoval(removal) && removal.problem !== "still-removing";
}

/**
 * What the person presses to put a failed removal away. When asking again
 * could still remove a bot that is otherwise kept, the button says so.
 */
export function botRemovalDismissLabel(removal: Pick<BotRemoval, "name" | "phase" | "agentUid" | "problem">): string {
  return botRemovalKeepsBot(removal) ? `Keep ${removal.name.trim() || "it"}` : "OK";
}

// ── A create the person cancelled ──────────────────────────────────────────

/** What a cancelled create made, as far as is known. */
export type CancelledCreateOutcome =
  /** The request made a bot. It exists. */
  | { kind: "created"; agentUid: string; channelId: string }
  /** The server answered, and made nothing. */
  | { kind: "not-created" }
  /** No answer, or one that cannot say. The bot may exist. */
  | { kind: "unknown" };

/** The part of a create's answer this module reads. Mirrors `EntryPointResult`. */
export type CancelledCreateAnswer =
  | { ok: true; target: { cardId?: string | null; channelId?: string | null; agentUid?: string } }
  | { ok: false; reason?: string; outcomeUnknown?: boolean };

/** Read the answer to a create the person cancelled. */
export function readCancelledCreate(answer: CancelledCreateAnswer | null | undefined): CancelledCreateOutcome {
  // The request threw, or never answered.
  if (!answer) return { kind: "unknown" };
  if (answer.ok) {
    // A card in the answer is the upgrade card, or another step: nothing was created.
    if (answer.target.cardId) return { kind: "not-created" };
    const agentUid = (answer.target.agentUid ?? "").trim();
    const channelId = (answer.target.channelId ?? "").trim();
    return agentUid || channelId ? { kind: "created", agentUid, channelId } : { kind: "not-created" };
  }
  if (answer.outcomeUnknown) return { kind: "unknown" };
  return { kind: "not-created" };
}

/**
 * What one look at the company's bots says about a cancelled create
 * (see created-bot-lookup.ts).
 */
export type CancelledCreateLookup =
  | { kind: "found"; agentUid: string }
  | { kind: "absent" }
  | { kind: "unproven" }
  | { kind: "unreadable" };

/** How long to wait before each look at the company's bots after a cancelled create. */
export const CANCELLED_CREATE_LOOKUP_DELAYS_MS: readonly number[] = [10_000, 20_000, 40_000];

export interface CancelledCreateOptions {
  /** Test seam. Production waits on a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The wait before each look. Its length is how many times the server is asked. */
  delaysMs?: readonly number[];
  /** True once nobody waits for the outcome any more. Checked before each look. */
  stopped?: () => boolean;
}

/**
 * Settle what a cancelled create made.
 *
 * When its own answer says, that is the outcome. When it does not (a
 * timeout, a dropped connection), the company's bots are read and searched
 * for the bot. This only reads: the create is never sent again from here,
 * because a first request that never reached the server would then make the
 * bot the person cancelled. The wait before each look lets a first request
 * that is still running on the server finish.
 *
 * Resolves "not-created" only on the create's own word, never on silence
 * and never because a look did not find the bot. Never throws.
 */
export async function resolveCancelledCreate(
  first: CancelledCreateAnswer | null | undefined,
  lookup: (() => Promise<CancelledCreateLookup>) | null,
  options: CancelledCreateOptions = {},
): Promise<CancelledCreateOutcome> {
  const outcome = readCancelledCreate(first);
  if (outcome.kind !== "unknown" || !lookup) return outcome;
  const sleep = options.sleep ?? defaultSleep;
  for (const delay of options.delaysMs ?? CANCELLED_CREATE_LOOKUP_DELAYS_MS) {
    await sleep(delay);
    if (options.stopped?.()) break;
    let seen: CancelledCreateLookup;
    try {
      seen = await lookup();
    } catch {
      seen = { kind: "unreadable" };
    }
    if (seen.kind === "found") return { kind: "created", agentUid: seen.agentUid, channelId: "" };
    // A bot has the handle and nothing shows this create made it. Looking
    // again will not change that.
    if (seen.kind === "unproven") break;
  }
  return { kind: "unknown" };
}

/** True while the bot may still exist on the server. */
export function botRemovalOpen(removal: Pick<BotRemoval, "phase">): boolean {
  return removal.phase === "stopping" || removal.phase === "removing" || removal.phase === "failed";
}

const BRAINS: readonly BotRemovalBrain[] = ["codex", "claude", "grok"];

let removalSequence = 0;

export function beginBotRemoval(input: {
  name: string;
  companyUid: string;
  agentUid?: string;
  channelId?: string;
  brain?: string | null;
  hadRow?: boolean;
  now?: number;
}): BotRemoval {
  removalSequence += 1;
  const agentUid = (input.agentUid ?? "").trim();
  return {
    id: `removal-${removalSequence}`,
    name: input.name.trim() || "Your bot",
    companyUid: input.companyUid.trim(),
    agentUid,
    channelId: (input.channelId ?? "").trim(),
    brain: BRAINS.find((value) => value === input.brain) ?? null,
    phase: agentUid ? "removing" : "stopping",
    hadRow: input.hadRow === true,
    startedAt: input.now ?? Date.now(),
    problem: null,
  };
}

/**
 * What the confirmation dialog says when Cancel is pressed for a bot that
 * exists.
 *
 * Removing a bot is for an owner or admin of its company; the server refuses
 * everyone else. A person who created the bot but cannot remove it
 * (`canRemove: false`) is not promised a removal: the dialog says who can
 * remove it, and its action closes the screen and leaves the bot as it is.
 */
export function cancelBotConfirmCopy(input: { name: string; companyLabel?: string | null; canRemove?: boolean }): {
  title: string;
  body: string;
  confirm: string;
  keep: string;
} {
  const name = input.name.trim() || "this bot";
  const company = (input.companyLabel ?? "").trim();
  if (input.canRemove === false) {
    return {
      title: `You can't remove ${name}`,
      body: `${name} has already been created${company ? ` in ${company}` : ""}. Only an owner or admin of this company can remove a bot. Ask one of them to remove ${name}.`,
      confirm: "Close",
      keep: "Keep waiting",
    };
  }
  return {
    title: `Cancel ${name}?`,
    body: `${name} will be removed${company ? ` from ${company}` : ""}, along with its computer and its files. This can't be undone.`,
    confirm: `Remove ${name}`,
    keep: `Keep ${name}`,
  };
}

export const OPEN_BOT_REMOVALS_STORAGE_KEY = "hq.chat.botRemovals.v1";
export const REMOVED_BOTS_STORAGE_KEY = "hq.chat.removedBots.v1";

const PROBLEMS: readonly BotRemovalProblem[] = ["error", "still-removing", "not-allowed", "plan-bot", "unknown-bot"];

/**
 * Cancelled bots that still exist, kept across restarts so a removal the app
 * was in the middle of is asked again and a bot that was not removed stays
 * visible. Only bots known by id are kept.
 */
export function loadOpenBotRemovals(
  storage: Pick<Storage, "getItem"> | null | undefined,
): BotRemoval[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(OPEN_BOT_REMOVALS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: BotRemoval[] = [];
    for (const entry of parsed) {
      const item = record(entry);
      const agentUid = text(item?.agentUid);
      const phase = text(item?.phase);
      if (!item || !agentUid || (phase !== "removing" && phase !== "failed")) continue;
      const problem = PROBLEMS.find((value) => value === item.problem) ?? null;
      out.push({
        ...beginBotRemoval({
          name: text(item.name),
          companyUid: text(item.companyUid),
          agentUid,
          channelId: text(item.channelId),
          brain: text(item.brain),
          hadRow: item.hadRow === true,
          now: typeof item.startedAt === "number" ? item.startedAt : undefined,
        }),
        phase,
        problem: phase === "failed" ? problem ?? "error" : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveOpenBotRemovals(
  removals: readonly BotRemoval[],
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  const open = removals
    .filter((removal) => removal.agentUid && (removal.phase === "removing" || removal.phase === "failed"))
    .slice(0, 50)
    .map(({ name, companyUid, agentUid, channelId, brain, phase, hadRow, startedAt, problem }) => ({
      name, companyUid, agentUid, channelId, brain, phase, hadRow, startedAt, problem,
    }));
  try {
    storage?.setItem(OPEN_BOT_REMOVALS_STORAGE_KEY, JSON.stringify(open));
  } catch {
    // best-effort
  }
}

/** Bots the server confirmed removed. Their conversation stays off the list. */
export function loadRemovedBots(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(REMOVED_BOTS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  } catch {
    return [];
  }
}

export function rememberRemovedBot(
  agentUids: readonly string[],
  agentUid: string,
  storage: Pick<Storage, "setItem"> | null | undefined,
): string[] {
  const uid = agentUid.trim();
  if (!uid || agentUids.includes(uid)) return [...agentUids];
  const next = [uid, ...agentUids].slice(0, 200);
  try {
    storage?.setItem(REMOVED_BOTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
  return next;
}

type RemovalStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The cancelled bots that still exist, for the account.
 *
 * They used to be kept per company scope. A removal begun with the sidebar
 * on one scope was then not found by the sidebar for another, and the bot
 * stayed alive until the first scope was shown again. They are kept for the
 * account now. `legacy` is the per-scope place they used to be written to:
 * what is still there is taken over once and cleared, so a removal that was
 * under way before this change is not lost.
 */
export function loadAccountBotRemovals(
  account: RemovalStorage | null | undefined,
  legacy: RemovalStorage | null | undefined,
): BotRemoval[] {
  const kept = loadOpenBotRemovals(account);
  const old = legacy ? loadOpenBotRemovals(legacy) : [];
  if (!old.length) return kept;
  const merged = [...kept, ...old.filter((entry) => !kept.some((other) => other.agentUid === entry.agentUid))];
  saveOpenBotRemovals(merged, account);
  saveOpenBotRemovals([], legacy);
  return merged;
}

/** The bots confirmed removed, for the account. `legacy` as in `loadAccountBotRemovals`. */
export function loadAccountRemovedBots(
  account: RemovalStorage | null | undefined,
  legacy: RemovalStorage | null | undefined,
): string[] {
  const kept = loadRemovedBots(account);
  const old = legacy ? loadRemovedBots(legacy) : [];
  if (!old.length) return kept;
  const merged = [...new Set([...kept, ...old])].slice(0, 200);
  try {
    account?.setItem(REMOVED_BOTS_STORAGE_KEY, JSON.stringify(merged));
    legacy?.setItem(REMOVED_BOTS_STORAGE_KEY, "[]");
  } catch {
    // best-effort
  }
  return merged;
}
