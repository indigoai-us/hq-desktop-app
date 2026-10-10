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

  readonly #deps: RuntimeRepairDeps;
  readonly #running = new Set<string>();

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
        return back(probe.class);
      }
      if (action === "tryAgain") {
        const text = (options.retryText ?? "").trim() || TRY_AGAIN_TEXT;
        const send = options.send ?? deps.send;
        if (!send) return back(null);
        await send(text);
      }
      this.#set(eventId, { phase: "fixed", action });
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
