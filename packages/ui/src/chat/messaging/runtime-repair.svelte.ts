/**
 * Runs the button on a runtime repair card and keeps each card's state.
 *
 * One controller per app window. It holds every card's state by message, so a
 * card that scrolls out of view, or a conversation that is left and opened
 * again, comes back in the state it was in: the same message row turns from
 * the problem into "You're all set", and no new message is posted.
 *
 * Every action ends with a check of the tool (`hq bot probe`). Only a passing
 * check turns the card to fixed. Anything else puts the card back on its
 * problem with one plain line from the app; what the host or the CLI said is
 * logged, never drawn.
 */

import {
  parseProbeResult,
  repairFailureNote,
  repairProbeNote,
  type ProbeResult,
  type RepairAction,
  type RepairCardState,
  type RepairPayload,
  type RepairRuntime,
  type UpdatePath,
} from "./runtime-repair-model.js";

export interface RuntimeRepairDeps {
  /** Open the tool's own browser sign-in and wait until it reports signed in. True when it did. */
  signIn(runtime: RepairRuntime): Promise<boolean>;
  /** Update the tool through the app's own install path. True when the install finished. */
  update(runtime: RepairRuntime): Promise<boolean>;
  /** `hq bot set-model <bot> <model|default>`. True when the CLI took it. */
  setModel(botName: string, model: string): Promise<boolean>;
  /** `hq bot probe --runtime <r> [--model <m>]`, as the CLI answered it. */
  probe(runtime: RepairRuntime, model?: string): Promise<unknown>;
  /**
   * Send a message to the bot as the person. The conversation passes its own
   * send with each press (it shows the message at once); this one is used
   * when it does not.
   */
  send?(text: string): Promise<void>;
  /**
   * The model the bot is set to, so the check runs the turn the bot would
   * (a tool can answer on its default model and still be too old for the
   * bot's). Absent or undefined: the tool's default.
   */
  botModel?(botName: string): string | null | undefined;
  /** Whether the app can update this tool itself. Absent: it can. */
  canUpdate?(runtime: RepairRuntime): boolean;
  /** Called once a card turns fixed (the host restarts bots paused on the tool). */
  onfixed?(payload: RepairPayload, action: RepairAction): void | Promise<void>;
  /**
   * Called once when a sign-in made somewhere else (another screen, or the
   * tool's own login outside the app) turned signed-out cards fixed, so the
   * host can restart the bots paused on that tool.
   */
  onsignedin?(runtime: RepairRuntime): void | Promise<void>;
  /** Clock, injected for tests. */
  now?(): number;
}

/**
 * Least time between two unforced sign-in checks of one tool. A check runs a
 * real turn of the tool, so focusing the window over and over does not run
 * one each time. A sign-in reported by another screen always checks.
 */
export const SIGN_IN_RECHECK_MIN_MS = 20_000;

/** Window event a screen sends when a coding tool's sign-in finished there (`detail.runtime`). */
export const RUNTIME_SIGNED_IN_EVENT = "hq:runtime-signed-in";

/**
 * Say that a coding tool's sign-in finished on this screen, so repair cards
 * still saying it is signed out check again and turn fixed in place.
 */
export function announceRuntimeSignedIn(runtime: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RUNTIME_SIGNED_IN_EVENT, { detail: { runtime } }));
}

/** The tool a {@link RUNTIME_SIGNED_IN_EVENT} names, or null when it names none this app repairs. */
export function signedInRuntimeOf(event: Event): RepairRuntime | null {
  const runtime = (event as CustomEvent<{ runtime?: unknown }>).detail?.runtime;
  return runtime === "claude" || runtime === "codex" || runtime === "grok" ? runtime : null;
}

/** What Try again sends when the failed message cannot be found. */
export const TRY_AGAIN_TEXT = "try again";

function warn(message: string, error?: unknown): void {
  console.warn(`[runtime-repair] ${message}`, error ?? "");
}

export class RuntimeRepairController {
  /** Card state by message event id. Absent: offered. */
  states = $state<Record<string, RepairCardState>>({});
  /**
   * Tools the app updated but whose check still said "too old": the bot runs
   * a copy installed outside HQ, which HQ cannot update. Their cards show the
   * one plain step instead of Update.
   */
  manualUpdate = $state<Partial<Record<RepairRuntime, true>>>({});

  /**
   * When a check last passed right after a sign-in, by tool (ms, this
   * computer's clock). A bot paused on a sign-in since before this has been
   * signed in again here even while its own status still says expired.
   */
  signedInAt = $state<Partial<Record<RepairRuntime, number>>>({});

  readonly #deps: RuntimeRepairDeps;
  readonly #running = new Set<string>();
  /** Every repair card drawn in this window, by message event id. */
  readonly #cards = new Map<string, RepairPayload>();
  /** Tools with a sign-in check running now. */
  readonly #rechecking = new Set<RepairRuntime>();
  /** Tools whose reported sign-in arrived while a check was running: checked again after it. */
  readonly #forcedPending = new Set<RepairRuntime>();
  /** When each tool's last unforced sign-in check started. */
  readonly #lastRecheck = new Map<RepairRuntime, number>();

  constructor(deps: RuntimeRepairDeps) {
    this.#deps = deps;
  }

  stateFor(eventId: string): RepairCardState {
    return this.states[eventId] ?? { phase: "offered" };
  }

  updatePathFor(runtime: RepairRuntime): UpdatePath {
    if (this.manualUpdate[runtime]) return "manual";
    return this.#deps.canUpdate && !this.#deps.canUpdate(runtime) ? "manual" : "app";
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /**
   * A card on screen. A signed-out card is remembered so a sign-in made
   * anywhere else can turn it fixed in place (see {@link recheckSignIn}).
   */
  track(eventId: string, payload: RepairPayload): void {
    this.#cards.set(eventId, payload);
  }

  /** Signed-out cards of `runtime` (any tool when absent) still showing their problem. */
  #signedOutCards(runtime?: RepairRuntime): Array<[string, RepairPayload]> {
    const out: Array<[string, RepairPayload]> = [];
    for (const [eventId, payload] of this.#cards) {
      if (payload.class !== "signed-out") continue;
      if (runtime && payload.runtime !== runtime) continue;
      if (this.#running.has(eventId) || this.stateFor(eventId).phase !== "offered") continue;
      out.push([eventId, payload]);
    }
    return out;
  }

  /** Note the tool signed in now and turn its waiting signed-out cards fixed. True when any turned. */
  #confirmSignedIn(runtime: RepairRuntime): boolean {
    this.signedInAt = { ...this.signedInAt, [runtime]: this.#now() };
    let turned = false;
    for (const [eventId] of this.#signedOutCards(runtime)) {
      this.#set(eventId, { phase: "fixed", action: "signIn" });
      turned = true;
    }
    return turned;
  }

  /**
   * A sign-in may have finished somewhere other than a card's own button:
   * the coding tools screen, Settings, New Bot, or the tool's own login
   * outside the app. Check each tool that still has a signed-out card (one
   * real check per tool) and turn its cards fixed in place when it passes.
   * A failing check leaves them as they are. `force` skips the spacing
   * between checks; a host that heard of a finished sign-in passes it.
   */
  async recheckSignIn(options: { runtime?: RepairRuntime; force?: boolean } = {}): Promise<void> {
    const byRuntime = new Map<RepairRuntime, RepairPayload>();
    for (const [, payload] of this.#signedOutCards(options.runtime)) {
      if (!byRuntime.has(payload.runtime)) byRuntime.set(payload.runtime, payload);
    }
    await Promise.all(
      [...byRuntime].map(async ([runtime, payload]) => {
        if (this.#rechecking.has(runtime)) {
          // A check started before the sign-in finished may still fail: a
          // reported sign-in checks again once it is done.
          if (options.force) this.#forcedPending.add(runtime);
          return;
        }
        const now = this.#now();
        if (!options.force && now - (this.#lastRecheck.get(runtime) ?? -Infinity) < SIGN_IN_RECHECK_MIN_MS) return;
        this.#lastRecheck.set(runtime, now);
        this.#rechecking.add(runtime);
        try {
          const model = this.#deps.botModel?.(payload.botName)?.trim() || undefined;
          const probe = await this.#probe(runtime, model);
          if (!probe.ok) return;
          if (!this.#confirmSignedIn(runtime)) return;
          try {
            await this.#deps.onsignedin?.(runtime);
          } catch (error) {
            warn("after-sign-in step failed", error);
          }
        } finally {
          this.#rechecking.delete(runtime);
          if (this.#forcedPending.delete(runtime)) await this.recheckSignIn({ runtime, force: true });
        }
      }),
    );
  }

  #set(eventId: string, state: RepairCardState): void {
    this.states = { ...this.states, [eventId]: state };
  }

  async #probe(runtime: RepairRuntime, model?: string): Promise<ProbeResult> {
    try {
      return parseProbeResult(await this.#deps.probe(runtime, model));
    } catch (error) {
      warn("probe failed", error);
      return { ok: false, class: null };
    }
  }

  /**
   * Run one action for the card on `eventId`. `retryText` is the person's
   * failed message, for Try again; `send` is the conversation's own send. A
   * second press while one runs is ignored.
   */
  async run(
    eventId: string,
    payload: RepairPayload,
    action: RepairAction,
    options: { retryText?: string | null; send?: (text: string) => Promise<void> } = {},
  ): Promise<void> {
    if (this.#running.has(eventId) || this.stateFor(eventId).phase === "fixed") return;
    this.#running.add(eventId);
    this.#set(eventId, { phase: "working", action });
    const deps = this.#deps;
    const back = (stillClass: ProbeResult["class"]): void => {
      this.#set(eventId, { phase: "offered", note: repairFailureNote(action, payload.runtime, stillClass) });
    };
    /** Back on the problem the check reported, with the note for that problem. */
    const backAs = (foundClass: ProbeResult["class"]): void => {
      this.#set(eventId, { phase: "offered", note: repairProbeNote(foundClass, action, payload.runtime) });
    };
    try {
      let probeModel: string | undefined = deps.botModel?.(payload.botName)?.trim() || undefined;
      if (action === "signIn") {
        if (!(await deps.signIn(payload.runtime))) return back("signed-out");
      } else if (action === "update") {
        if (!(await deps.update(payload.runtime))) return back(null);
      } else if (action === "switchModel") {
        const model = payload.suggestedModel ?? "default";
        if (!(await deps.setModel(payload.botName, model))) return back(null);
        probeModel = payload.suggestedModel;
      }
      const probe = await this.#probe(payload.runtime, probeModel);
      if (!probe.ok) {
        if (action === "update" && probe.class === "cli-outdated") {
          // The app's own copy is current, yet the bot's is still too old:
          // the bot runs a copy installed outside HQ.
          this.manualUpdate = { ...this.manualUpdate, [payload.runtime]: true };
          this.#set(eventId, { phase: "offered" });
          return;
        }
        // The action ran; what the check found now is what the note says.
        // An update that leaves the model unsupported is not a failed update.
        return backAs(probe.class);
      }
      if (action === "tryAgain") {
        const text = (options.retryText ?? "").trim() || TRY_AGAIN_TEXT;
        const send = options.send ?? deps.send;
        if (!send) return back(null);
        await send(text);
      }
      this.#set(eventId, { phase: "fixed", action });
      // A passing check after a sign-in is the tool's, not only this card's:
      // every other card still saying signed out for it turns fixed too.
      if (action === "signIn") this.#confirmSignedIn(payload.runtime);
      try {
        await deps.onfixed?.(payload, action);
      } catch (error) {
        warn("after-fix step failed", error);
      }
    } catch (error) {
      warn(`${action} failed`, error);
      back(null);
    } finally {
      this.#running.delete(eventId);
    }
  }
}
