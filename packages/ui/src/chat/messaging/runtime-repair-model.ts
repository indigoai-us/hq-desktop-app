/**
 * Runtime repair cards in a local bot's direct message: the pure model.
 *
 * When a local bot cannot answer because of its coding tool (signed out, too
 * old, set to a model the tool cannot run, or a one-off failure) hq-cli posts
 * a reply whose body is a plain sentence and whose `repair` payload says what
 * went wrong (see {@link RepairPayload}). The app draws that reply as one
 * card in the connection card's look (RuntimeRepairCard.svelte) with one
 * button that fixes the problem, and the same card turns into "You're all
 * set" once a check of the tool passes.
 *
 * Every word on the card is the app's own, chosen by the payload's closed
 * fields. Nothing the bot or the CLI wrote as free text is ever shown: the
 * `detail` of a probe and any host error are logged, never drawn. A message
 * without a valid payload is drawn exactly as before, as its plain text.
 *
 * Pure (no Svelte, no host imports) so every state and sentence is unit
 * tested here.
 */

import { brandMarkFor, type BrandMark } from "./app-brand-marks.js";

/** Payload version this app understands. Any other version draws the plain text. */
export const REPAIR_PAYLOAD_VERSION = 1;

export type RepairClass = "signed-out" | "cli-outdated" | "model-unsupported" | "transient";
export type RepairRuntime = "claude" | "codex" | "grok";
export type RepairAction = "signIn" | "update" | "switchModel" | "tryAgain";

const CLASSES: readonly RepairClass[] = ["signed-out", "cli-outdated", "model-unsupported", "transient"];
const RUNTIMES: readonly RepairRuntime[] = ["claude", "codex", "grok"];
const ACTIONS: readonly RepairAction[] = ["signIn", "update", "switchModel", "tryAgain"];

/** The action each class offers first. A payload that names another is still drawn with this one. */
export const PRIMARY_ACTION: Readonly<Record<RepairClass, RepairAction>> = {
  "signed-out": "signIn",
  "cli-outdated": "update",
  "model-unsupported": "switchModel",
  transient: "tryAgain",
};

/**
 * The `repair` payload hq-cli puts on a local bot's reply (contract v1).
 * `botName` is the bot's handle (what `hq bot set-model` takes), never shown.
 */
export interface RepairPayload {
  v: 1;
  kind: "runtime-repair";
  class: RepairClass;
  runtime: RepairRuntime;
  action: RepairAction;
  botName: string;
  /** Event id of the person's message that failed, to send again. */
  retryOf?: string;
  /** A model the tool can run, for "Use a supported model". Absent: the tool's default. */
  suggestedModel?: string;
}

/** A bot handle: lowercase letters, digits and single hyphens (bots.rs `validate_name`). */
const BOT_HANDLE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
/** A model id, the shape `hq bot set` takes (bots.rs `validate_set_model`), for example "opus[1m]". */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;
/** An event id as the server writes it: no spaces, bounded. */
const EVENT_ID = /^[A-Za-z0-9._:#-]{1,128}$/;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Read a `repair` payload. Anything malformed (wrong version or kind, an
 * unknown class, runtime or action, a bot handle or model id of the wrong
 * shape) answers null, and the message is drawn as plain text.
 */
export function parseRepairPayload(raw: unknown): RepairPayload | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const rec = record(value);
  if (!rec) return null;
  if (rec.v !== REPAIR_PAYLOAD_VERSION || rec.kind !== "runtime-repair") return null;
  const cls = oneOf(rec.class, CLASSES);
  const runtime = oneOf(rec.runtime, RUNTIMES);
  const action = oneOf(rec.action, ACTIONS);
  const botName = typeof rec.botName === "string" ? rec.botName.trim() : "";
  if (!cls || !runtime || !action || !BOT_HANDLE.test(botName)) return null;
  const out: RepairPayload = { v: 1, kind: "runtime-repair", class: cls, runtime, action, botName };
  if (rec.retryOf !== undefined && rec.retryOf !== null) {
    if (typeof rec.retryOf !== "string" || !EVENT_ID.test(rec.retryOf.trim())) return null;
    out.retryOf = rec.retryOf.trim();
  }
  if (rec.suggestedModel !== undefined && rec.suggestedModel !== null) {
    if (typeof rec.suggestedModel !== "string" || !MODEL_ID.test(rec.suggestedModel.trim())) return null;
    out.suggestedModel = rec.suggestedModel.trim();
  }
  return out;
}

/**
 * The repair payload a message row carries.
 *
 * TRANSPORT. hq-pro's `POST /v1/notify/dm` keeps only the fields it names and
 * drops any other, so a `metadata` field never arrives. The one structured
 * field it stores and hands back on every DM read is `richContent`
 * (`{ v: 1, blocks: [...] }`, any block `kind`). So hq-cli sends the payload
 * as a `runtime-repair` block in the message's `richContent`, with the plain
 * sentence as the body. Only the wire field is read: a block written into
 * the body text is never a repair card. A `metadata.repair` is also read, so
 * a server that one day passes metadata through needs no app change.
 * Null when there is none or it is malformed.
 */
export function repairPayloadForMessage(
  message: { richContent?: unknown; metadata?: unknown } | null | undefined,
): RepairPayload | null {
  if (!message) return null;
  const rich = record(message.richContent);
  if (rich && Array.isArray(rich.blocks)) {
    for (const block of rich.blocks) {
      if (record(block)?.kind === "runtime-repair") return parseRepairPayload(block);
    }
  }
  const meta = record(message.metadata);
  if (meta && meta.repair !== undefined) return parseRepairPayload(meta.repair);
  return null;
}

/** The coding tool's name as people know it. */
export const RUNTIME_LABEL: Readonly<Record<RepairRuntime, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
};

/** The domain whose bundled mark heads the card; null draws the generic glyph. */
const RUNTIME_DOMAIN: Readonly<Record<RepairRuntime, string | null>> = {
  claude: "anthropic.com",
  codex: null,
  grok: null,
};

/**
 * Where a card is.
 *
 *   offered   the problem, with its buttons
 *   working   an action is running (`working` says which)
 *   fixed     the check passed: "You're all set"
 */
export type RepairPhase = "offered" | "working" | "fixed";

/**
 * How the Update button can update the tool on this computer.
 *
 *   app      HQ installs the tool itself (its own copy), no password needed
 *   manual   HQ cannot update the copy the bot runs (installed outside HQ);
 *            the card says how in one plain step instead of a button that
 *            would not help
 */
export type UpdatePath = "app" | "manual";

/** One card's state as the host keeps it, by message. */
export interface RepairCardState {
  phase: RepairPhase;
  /** The action running (working) or that fixed it (fixed). */
  action?: RepairAction;
  /** A plain line after an action did not fix it. App copy only. */
  note?: string;
}

/** Everything the card draws. Every string is the app's. */
export interface RepairCardView {
  repairClass: RepairClass;
  phase: RepairPhase;
  /** Wallpaper slot (one per class, kept through working and fixed). */
  art: RepairClass;
  logo: { mark: BrandMark | null };
  title: string;
  line: string;
  /** Header mark: the spinner label while working, the green word once fixed. */
  mark: string | null;
  primaryLabel: string | null;
  primaryAction: RepairAction | null;
  secondaryLabel: string | null;
  secondaryAction: RepairAction | null;
  /** A plain line after an action did not fix it. */
  note: string | null;
}

/** The name the card uses for the bot: its display name, else its handle, else "Your bot". */
export function repairBotName(displayName: string | null | undefined, payload: RepairPayload): string {
  const shown = (displayName ?? "").trim();
  return shown || payload.botName || "Your bot";
}

const WORKING_MARK: Readonly<Record<RepairAction, string>> = {
  signIn: "Signing in…",
  update: "Updating…",
  switchModel: "Switching…",
  tryAgain: "Trying again…",
};

const FIXED_MARK: Readonly<Record<RepairAction, string>> = {
  signIn: "Signed in",
  update: "Updated",
  switchModel: "Model switched",
  tryAgain: "Working",
};

/** The one plain step shown in place of Update when HQ cannot update the tool itself. */
export function manualUpdateLine(runtime: RepairRuntime): string {
  const tool = RUNTIME_LABEL[runtime];
  return `${tool} was installed outside HQ. Update ${tool} the way you installed it, then press Try again.`;
}

/** A plain line for an action that ran but did not fix the problem. Never the host's own words. */
export function repairFailureNote(action: RepairAction, runtime: RepairRuntime, stillClass: RepairClass | null): string {
  const tool = RUNTIME_LABEL[runtime];
  switch (action) {
    case "signIn":
      return stillClass === "signed-out" || stillClass === null
        ? `${tool} is still signed out. Try again.`
        : `Signed in, but ${tool} still can't reply. Try again.`;
    case "update":
      return `${tool} could not be updated. Try again.`;
    case "switchModel":
      return `The model could not be switched. Try again.`;
    case "tryAgain":
      return `${tool} still can't reply. Try again in a moment.`;
  }
}

/**
 * A plain line for a check that ran after an action and still found a
 * problem, chosen by what the check found rather than by the action: an
 * update that leaves the bot on a model the tool cannot run says that, not
 * "could not be updated". An unknown class falls back to the action's note.
 */
export function repairProbeNote(found: RepairClass | null, action: RepairAction, runtime: RepairRuntime): string {
  const tool = RUNTIME_LABEL[runtime];
  switch (found) {
    case "signed-out":
      return `${tool} is still signed out. Try again.`;
    case "cli-outdated":
      return `${tool} is still too old. Try again.`;
    case "model-unsupported":
      return `${tool} still can't run the model the bot is set to. Use a supported model.`;
    case "transient":
      return `${tool} still can't reply. Try again in a moment.`;
    default:
      return repairFailureNote(action, runtime, null);
  }
}

/**
 * The card for a payload in a state. `updatePath` says whether Update is a
 * button (the app updates the tool) or a plain step (it cannot).
 */
export function repairCardView(
  payload: RepairPayload,
  state: RepairCardState,
  botDisplayName: string | null | undefined,
  updatePath: UpdatePath = "app",
): RepairCardView {
  const bot = repairBotName(botDisplayName, payload);
  const tool = RUNTIME_LABEL[payload.runtime];
  const base = {
    repairClass: payload.class,
    phase: state.phase,
    art: payload.class,
    logo: { mark: brandMarkFor(RUNTIME_DOMAIN[payload.runtime]) },
    note: null as string | null,
  };

  if (state.phase === "fixed") {
    return {
      ...base,
      title: "You’re all set",
      line: "Send me anything.",
      mark: FIXED_MARK[state.action ?? PRIMARY_ACTION[payload.class]],
      primaryLabel: null,
      primaryAction: null,
      secondaryLabel: null,
      secondaryAction: null,
    };
  }

  if (state.phase === "working") {
    const action = state.action ?? PRIMARY_ACTION[payload.class];
    const label = WORKING_MARK[action];
    const line =
      action === "signIn"
        ? "Finish in the browser window that just opened."
        : action === "update"
          ? `Updating ${tool}. ${bot} replies as soon as it’s done.`
          : action === "switchModel"
            ? `Switching ${bot} to a model ${tool} supports.`
            : `Checking ${tool}. ${bot} replies as soon as it can.`;
    return {
      ...base,
      title: tool,
      line,
      mark: label,
      primaryLabel: label,
      primaryAction: null,
      secondaryLabel: null,
      secondaryAction: null,
    };
  }

  const note = state.note?.trim() ? state.note.trim() : null;
  switch (payload.class) {
    case "signed-out":
      return {
        ...base,
        note,
        title: `${tool} is signed out`,
        line: `${bot} needs ${tool} to reply. Sign in and ${bot} picks up your message.`,
        mark: null,
        primaryLabel: "Sign in",
        primaryAction: "signIn",
        secondaryLabel: null,
        secondaryAction: null,
      };
    case "cli-outdated":
      if (updatePath === "manual") {
        return {
          ...base,
          note,
          title: `${tool} needs an update`,
          line: manualUpdateLine(payload.runtime),
          mark: null,
          primaryLabel: "Try again",
          primaryAction: "tryAgain",
          secondaryLabel: null,
          secondaryAction: null,
        };
      }
      return {
        ...base,
        note,
        title: `${tool} needs an update`,
        line: `This version of ${tool} is too old for ${bot}. The update takes about a minute.`,
        mark: null,
        primaryLabel: "Update",
        primaryAction: "update",
        secondaryLabel: null,
        secondaryAction: null,
      };
    case "model-unsupported":
      return {
        ...base,
        note,
        title: `${bot}’s model isn’t available`,
        line: `${tool} on this Mac can’t run the model ${bot} is set to. Switch to one it supports, or update.`,
        mark: null,
        primaryLabel: "Use a supported model",
        primaryAction: "switchModel",
        secondaryLabel: updatePath === "app" ? `Update ${tool}` : null,
        secondaryAction: updatePath === "app" ? "update" : null,
      };
    case "transient":
      return {
        ...base,
        note,
        title: `${bot} couldn’t reply`,
        line: `Something interrupted ${tool}. Your message is saved.`,
        mark: null,
        primaryLabel: "Try again",
        primaryAction: "tryAgain",
        secondaryLabel: null,
        secondaryAction: null,
      };
  }
}

/** What `hq bot probe --json` answers, read defensively. */
export interface ProbeResult {
  ok: boolean;
  /** The failure class when not ok; null when unknown. */
  class: RepairClass | null;
}

/** Read a probe answer. Anything that is not `{ ok: true }` is a failure. */
export function parseProbeResult(raw: unknown): ProbeResult {
  const rec = record(raw);
  if (!rec) return { ok: false, class: null };
  if (rec.ok === true) return { ok: true, class: null };
  return { ok: false, class: oneOf(rec.class, CLASSES) };
}
