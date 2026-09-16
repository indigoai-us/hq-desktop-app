/**
 * "Sign in again" for a local bot's coding tool.
 *
 * A vendor CLI can keep a saved-but-dead login: `claude auth status` still
 * says signed in while every model call fails to authenticate. The CLI half
 * (`hq bot list --json`) marks such bots with `runtimeSignIn.state ===
 * "expired"`; the bot pauses and retries on its own about once a minute.
 *
 * This helper runs the whole recovery: force the vendor sign-in (sign out,
 * then the browser flow — the CLI owns login, HQ never sees a URL or token),
 * wait until it reports connected, then restart every bot paused on that
 * runtime so it retries now instead of up to a minute later.
 */
import type { LocalBotRow, SessionProviderId } from "@hq/platform";
import { localBotRuntimeLabel } from "./local-bots.js";

export type BotRuntimeId = LocalBotRow["runtime"];

/** True when the bot is paused because its coding tool needs a new sign-in. */
export function botNeedsSignIn(bot: LocalBotRow | null | undefined): boolean {
  return bot?.runtimeSignIn?.state === "expired";
}

/** The runtime whose sign-in expired (the report's own, else the bot's). */
export function expiredRuntimeOf(bot: LocalBotRow): BotRuntimeId {
  return bot.runtimeSignIn?.runtime ?? bot.runtime;
}

/** Bots paused on `runtime`'s sign-in. */
export function botsNeedingSignIn(bots: readonly LocalBotRow[], runtime: BotRuntimeId): LocalBotRow[] {
  return bots.filter((bot) => botNeedsSignIn(bot) && expiredRuntimeOf(bot) === runtime);
}

/** Every runtime some local bot reports an expired sign-in for. */
export function runtimesNeedingSignIn(bots: readonly LocalBotRow[]): BotRuntimeId[] {
  const out: BotRuntimeId[] = [];
  for (const bot of bots) {
    if (!botNeedsSignIn(bot)) continue;
    const runtime = expiredRuntimeOf(bot);
    if (!out.includes(runtime)) out.push(runtime);
  }
  return out;
}

/** Plain copy for a paused bot's conversation. */
export function signInAgainCopy(bot: LocalBotRow): { lead: string; action: string; waiting: string } {
  const tool = localBotRuntimeLabel(expiredRuntimeOf(bot));
  return {
    lead: `${tool} needs you to sign in again before ${bot.name} can keep working.`,
    action: `Sign in to ${tool}`,
    waiting: `Finish signing in in your browser — ${bot.name} will pick up where it left off.`,
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message?: string };
interface LoginState {
  state?: string;
  message?: string;
}

export interface SignInAgainDeps {
  sessions: {
    loginStart?(tool: SessionProviderId, opts?: { force?: boolean }): Promise<Outcome<unknown>>;
    loginStatus?(tool: SessionProviderId): Promise<Outcome<unknown>>;
  };
  bots?: {
    list(): Promise<Outcome<{ bots: LocalBotRow[] }>>;
    start(name: string): Promise<Outcome<unknown>>;
    stop(name: string): Promise<Outcome<unknown>>;
  } | null;
  /**
   * The host's start gate, so this recovery obeys the same rule as every
   * other start. A host that omits it starts every paused bot unconditionally.
   */
  gate?: RestartGate;
  /** Called once the browser sign-in is open and HQ is waiting on it. */
  onwaiting?: () => void;
  /** Stop waiting (the view went away). */
  cancelled?: () => boolean;
  pollMs?: number;
  timeoutMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type SignInAgainResult =
  | { ok: true; restarted: string[]; restartFailed: string[]; skipped: string[] }
  | { ok: false; reason: string; cancelled?: boolean };

const POLL_MS = 1500;
/** Rust gives the vendor flow five minutes; wait a little longer than that. */
const TIMEOUT_MS = 5 * 60_000 + 15_000;

function stateOf(result: Outcome<unknown>): LoginState {
  if (!result.ok) return { state: "error", message: result.message };
  return (result.value ?? {}) as LoginState;
}

/**
 * Force a fresh vendor sign-in for `runtime`, wait for it, then restart the
 * bots paused on it through the host's start gate. Bots are only touched
 * after the sign-in is connected.
 */
export async function signInAgain(runtime: BotRuntimeId, deps: SignInAgainDeps): Promise<SignInAgainResult> {
  const { sessions } = deps;
  const tool = localBotRuntimeLabel(runtime);
  if (!sessions.loginStart || !sessions.loginStatus) {
    return { ok: false, reason: `Sign in to ${tool} from its app, then try again.` };
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? POLL_MS;
  const deadline = now() + (deps.timeoutMs ?? TIMEOUT_MS);
  const cancelled = () => deps.cancelled?.() === true;
  const didNotFinish = `Signing in to ${tool} did not finish. Try again.`;

  let current: LoginState;
  try {
    current = stateOf(await sessions.loginStart(runtime, { force: true }));
  } catch {
    return { ok: false, reason: `Could not open the ${tool} sign-in. Try again.` };
  }
  let told = false;
  while (current.state === "waiting") {
    if (!told) {
      told = true;
      deps.onwaiting?.();
    }
    if (cancelled()) return { ok: false, reason: "", cancelled: true };
    if (now() >= deadline) return { ok: false, reason: didNotFinish };
    await sleep(pollMs);
    if (cancelled()) return { ok: false, reason: "", cancelled: true };
    try {
      current = stateOf(await sessions.loginStatus(runtime));
    } catch {
      return { ok: false, reason: `Could not check the ${tool} sign-in. Try again.` };
    }
  }
  if (current.state !== "connected") return { ok: false, reason: didNotFinish };

  return { ok: true, ...(await restartBotsNeedingSignIn(runtime, deps.bots ?? null, deps.gate ?? {})) };
}

/**
 * The host's start gate, so this recovery obeys the same rule as every other
 * start: a bot whose start already failed definitively is not re-issued, and
 * one that does start has its failure state cleared.
 */
export interface RestartGate {
  /** False → skip this bot entirely (its gate is closed). */
  canStart?(bot: LocalBotRow): boolean;
  /** Called once for each bot whose start actually succeeded. */
  onstarted?(bot: LocalBotRow): void;
}

/**
 * Restart every bot paused on `runtime`'s sign-in so it retries now (a paused
 * bot also retries by itself about once a minute). Reads a fresh list first.
 */
export async function restartBotsNeedingSignIn(
  runtime: BotRuntimeId,
  bots: SignInAgainDeps["bots"],
  gate: RestartGate = {},
): Promise<{ restarted: string[]; restartFailed: string[]; skipped: string[] }> {
  const restarted: string[] = [];
  const restartFailed: string[] = [];
  const skipped: string[] = [];
  if (!bots) return { restarted, restartFailed, skipped };
  let rows: LocalBotRow[] = [];
  try {
    const listed = await bots.list();
    rows = listed.ok ? (listed.value.bots ?? []) : [];
  } catch {
    rows = [];
  }
  for (const bot of botsNeedingSignIn(rows, runtime)) {
    if (gate.canStart && !gate.canStart(bot)) {
      skipped.push(bot.name);
      continue;
    }
    try {
      // Stop may fail on a bot that already exited; start is what matters.
      await bots.stop(bot.name);
      const started = await bots.start(bot.name);
      if (started.ok) {
        restarted.push(bot.name);
        gate.onstarted?.(bot);
      } else {
        restartFailed.push(bot.name);
      }
    } catch {
      restartFailed.push(bot.name);
    }
  }
  return { restarted, restartFailed, skipped };
}
