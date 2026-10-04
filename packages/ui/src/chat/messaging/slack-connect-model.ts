/**
 * Connecting a cloud bot to Slack from the Slack card's modal: the pure model.
 *
 * It turns what the server says about the bot's Slack, plus what the modal
 * has done so far, into the step the person is on. No Svelte, no network.
 *
 * THE FLOW. Pressing Connect Slack on the card opens the modal, and that
 * press is the intent: the modal asks the server at once to set the bot up
 * in Slack (this creates a real Slack app, so it is asked once per bot). The
 * person approves the bot in Slack. For most bots Slack then needs one token
 * that only a person can make on Slack's site; the server says when it wants
 * it. Then the server finishes the setup on the bot's computer, which takes
 * a minute or two. It does not wait for the bot's file sync.
 *
 * WHAT IS TRUE comes from the server every time: the bot's status answer.
 * "Connected" is the same test the Slack card uses (`slackFactsFromStatus`),
 * so the card and the modal cannot disagree.
 *
 * Every sentence a person reads in the flow is in this file.
 */

import type { CardModalStepState, CardModalSteps } from "./card-modal.js";
import { slackFactsFromStatus } from "./connection-card-model.js";
import {
  slackBotUrlFromStatus,
  slackCapabilityFromStatus,
  slackRowFromAttach,
  slackRowFromStatus,
  slackRowStage,
  slackSetupWaitFromSteps,
  type SlackRow,
  type SlackSetupWait,
} from "./slack-status.js";

export type SlackConnectStage = "approve" | "token" | "finishing" | "connected" | "blocked";

/** Why the modal cannot move the connection forward by itself. */
export type SlackBlockedReason = "not-admin" | "company-not-connected" | "own-app" | "config-dead" | "app-switch";

/** The console page a blocked state can open. The shell builds the link. */
export type SlackConsolePage = "integrations" | "slack-setup";

/** A wait this long in the last step gets a calmer line. Nothing fails. */
export const SLACK_FINISHING_SLOW_MS = 3 * 60_000;

/**
 * How long after the server accepted the token a status answer that still
 * asks for it is taken to be an old answer. After this the answer is believed.
 */
export const SLACK_TOKEN_ACCEPT_GRACE_MS = 30_000;

// ── Server codes ─────────────────────────────────────────────────────────

export const SLACK_ATTACH_ALREADY_CONNECTED = "SLACK_ATTACH_ALREADY_CONNECTED";
export const SLACK_FACTORY_ROTATE_UNAVAILABLE = "SLACK_FACTORY_ROTATE_UNAVAILABLE";
export const SLACK_CHANNEL_ATTACH_FAILED = "CHANNEL_ATTACH_FAILED";
export const SLACK_FACTORY_ROOT_MISSING = "FACTORY_ROOT_MISSING";
export const SLACK_PASTE_REQUIRED = "SLACK_PASTE_REQUIRED";
export const SLACK_LEGACY_CONFIG_TOKEN_DEAD = "LEGACY_FACTORY_CONFIG_TOKEN_DEAD";
export const SLACK_ATTACH_APP_SWITCH_NOT_WIRED = "SLACK_ATTACH_APP_SWITCH_NOT_WIRED";
export const SLACK_APP_TOKEN_INVALID = "SLACK_APP_TOKEN_INVALID";
export const SLACK_APP_TOKEN_REJECTED = "SLACK_APP_TOKEN_REJECTED";
export const SLACK_APP_TOKEN_NOT_AWAITED = "SLACK_APP_TOKEN_NOT_AWAITED";
export const SLACK_APP_TOKEN_VERIFY_UNAVAILABLE = "SLACK_APP_TOKEN_VERIFY_UNAVAILABLE";

// ── Sentences ────────────────────────────────────────────────────────────

export const SLACK_ATTACH_RETRY_SENTENCE = "Slack did not answer. Try again.";
export const SLACK_TOKEN_REJECTED_SENTENCE =
  "Slack did not accept that token. Check that it starts with xapp- and has the connections:write scope.";
export const SLACK_TOKEN_RETRY_SENTENCE = "Could not check the token with Slack. Try again.";
export const SLACK_TOKEN_SHAPE_SENTENCE = "That does not look like the right token. It starts with xapp-.";
export const SLACK_APPROVE_DETAIL = "Slack opens in your browser. Click Allow, then come back here.";
export const SLACK_APPROVE_NO_LINK_DETAIL = "Waiting for the link from Slack. This screen updates by itself.";
export const SLACK_TOKEN_CHECKING = "Checking the token with Slack.";
export const SLACK_STARTING = "Setting things up in Slack.";
/** The last step while the setup's audit has stopped on something of its own. */
export const SLACK_AUDIT_WAIT_SENTENCE = "HQ is finishing the setup on the bot's machine. This can take a few minutes.";
/** The one thing a person types on Slack's page. The modal offers it with a Copy button. */
export const SLACK_TOKEN_SCOPE = "connections:write";
/** How long the Copy button says "Copied" (ms). */
export const SLACK_COPIED_MS = 2_000;

function botOf(botName: string | null | undefined): string {
  return botName?.trim() || "your bot";
}

export function slackConnectTitle(botName: string): string {
  return `Connect ${botOf(botName)} to Slack`;
}

/** `token`: why there is a token step at all, in one line. */
export function slackTokenWhySentence(botName: string): string {
  return `Slack needs a token so ${botOf(botName)} can listen for messages. Slack only lets a person create it.`;
}

export type SlackTokenStepKey = "open" | "scope" | "paste";

export interface SlackTokenStep {
  key: SlackTokenStepKey;
  /** One line. The `scope` step's line is followed by the scope itself, with a Copy button. */
  text: string;
}

/** The three things a person does to make the token, as they see them on Slack's page. */
export function slackTokenSteps(botName: string): SlackTokenStep[] {
  const bot = botOf(botName);
  return [
    { key: "open", text: `Open ${bot}'s app page` },
    { key: "scope", text: "Under App-Level Tokens, click Generate Token and Scopes. Add the scope" },
    { key: "paste", text: "Paste the token here." },
  ];
}

/**
 * Whether a value is, after trimming, the whole of an app-level token as
 * Slack writes them: `xapp-` and then letters, digits and dashes. A value
 * that is can be sent the moment it is pasted. Looser values (anything else
 * that starts with `xapp-`) still go through Connect and {@link checkSlackAppToken}.
 */
export function isWholeSlackAppToken(value: string): boolean {
  return /^xapp-[A-Za-z0-9-]{10,}$/.test(value.trim());
}

export function slackAccessPendingSentence(botName: string): string {
  return `HQ is giving you access to ${botOf(botName)}'s app in Slack. This can take up to 15 minutes. This screen updates by itself.`;
}

export function slackFinishingSentence(botName: string, slow: boolean): string {
  const bot = botOf(botName);
  return slow
    ? `Still connecting. You can close this. The Slack card updates when ${bot} is in Slack.`
    : `Connecting ${bot} to Slack. This usually takes a minute or two.`;
}

/**
 * The line under the last step: the audit's line when the status says the
 * audit has stopped, else the ordinary line for how long it has been. The
 * bot's file sync never changes it.
 */
export function slackLastStepSentence(botName: string, wait: SlackSetupWait | null, slow: boolean): string {
  if (wait?.kind === "audit") return SLACK_AUDIT_WAIT_SENTENCE;
  return slackFinishingSentence(botName, slow);
}

export function slackConnectedSentence(botName: string): string {
  return `${botOf(botName)} is in Slack. Invite it to a channel or send it a direct message.`;
}

export interface SlackBlockedCopy {
  sentence: string;
  /** The one button of the state, or null when all a person can do is close. */
  action: { label: string; page: SlackConsolePage } | null;
}

export function slackBlockedCopy(reason: SlackBlockedReason, botName: string): SlackBlockedCopy {
  const bot = botOf(botName);
  switch (reason) {
    case "not-admin":
      return { sentence: "Only a company owner or admin can connect a bot to Slack.", action: null };
    case "company-not-connected":
      return {
        sentence: `Your company's Slack is not connected to HQ yet. A company admin connects it once in HQ Integrations, then you can add ${bot} here.`,
        action: { label: "Open HQ Integrations", page: "integrations" },
      };
    case "own-app":
      return {
        sentence: "Your company connects bots with its own Slack app. That setup is on the web for now.",
        action: { label: "Open Slack setup", page: "slack-setup" },
      };
    case "config-dead":
    case "app-switch":
      return { sentence: `${bot} could not be added to Slack from here. Contact HQ support.`, action: null };
  }
}

// ── Reading what the server answered ─────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failureCode(result: Record<string, unknown>): string {
  return typeof result.code === "string" ? result.code.trim() : "";
}

/** A 403 or a 404: the server's answer to a caller who is not an owner or admin. */
function notAllowed(result: Record<string, unknown>, code: string): boolean {
  return result.status === 403 || result.status === 404 || code === "http-403" || code === "http-404";
}

/**
 * Whether a failed status read means the person may not manage this bot. The
 * server answers a member with a 404 (it never confirms the bot exists).
 */
export function slackStatusDenied(result: unknown): boolean {
  if (!isRecord(result) || result.ok !== false) return false;
  return notAllowed(result, failureCode(result));
}

export type SlackAttachAnswer =
  /** The server set the bot up. `attached` is its answer, kept until the status says the same. */
  | { kind: "attached"; attached: unknown }
  /** Not an error: the bot already has Slack. Read the status and go on from it. */
  | { kind: "continue" }
  /** Nothing was created. The person can try again. */
  | { kind: "retry"; sentence: string }
  | { kind: "blocked"; reason: SlackBlockedReason };

/** Read the answer to `agents.attachSlack`. A request that threw is `null`. */
export function readSlackAttachAnswer(result: unknown): SlackAttachAnswer {
  if (!isRecord(result)) return { kind: "retry", sentence: SLACK_ATTACH_RETRY_SENTENCE };
  if (result.ok === true) return { kind: "attached", attached: result.value };
  const code = failureCode(result);
  switch (code) {
    case SLACK_ATTACH_ALREADY_CONNECTED:
      return { kind: "continue" };
    case SLACK_FACTORY_ROOT_MISSING:
      return { kind: "blocked", reason: "company-not-connected" };
    case SLACK_PASTE_REQUIRED:
      return { kind: "blocked", reason: "own-app" };
    case SLACK_LEGACY_CONFIG_TOKEN_DEAD:
      return { kind: "blocked", reason: "config-dead" };
    case SLACK_ATTACH_APP_SWITCH_NOT_WIRED:
      return { kind: "blocked", reason: "app-switch" };
    case SLACK_FACTORY_ROTATE_UNAVAILABLE:
    case SLACK_CHANNEL_ATTACH_FAILED:
      return { kind: "retry", sentence: SLACK_ATTACH_RETRY_SENTENCE };
  }
  if (notAllowed(result, code)) return { kind: "blocked", reason: "not-admin" };
  // The network, or a failure this version does not know: nothing was created.
  return { kind: "retry", sentence: SLACK_ATTACH_RETRY_SENTENCE };
}

export type SlackTokenAnswer =
  | { kind: "accepted" }
  /** The server was not waiting for a token. Read the status and go on from it. */
  | { kind: "continue" }
  /** Slack refused this token. The pasted value is cleared. */
  | { kind: "rejected"; sentence: string }
  /** The token could not be checked. The value stays in the field for the retry. */
  | { kind: "retry"; sentence: string }
  | { kind: "blocked"; reason: SlackBlockedReason };

/** Read the answer to `agents.submitSlackAppToken`. A request that threw is `null`. */
export function readSlackTokenAnswer(result: unknown): SlackTokenAnswer {
  if (!isRecord(result)) return { kind: "retry", sentence: SLACK_TOKEN_RETRY_SENTENCE };
  if (result.ok === true) return { kind: "accepted" };
  const code = failureCode(result);
  if (code === SLACK_APP_TOKEN_INVALID || code === SLACK_APP_TOKEN_REJECTED) {
    return { kind: "rejected", sentence: SLACK_TOKEN_REJECTED_SENTENCE };
  }
  if (code === SLACK_APP_TOKEN_NOT_AWAITED) return { kind: "continue" };
  if (code === SLACK_APP_TOKEN_VERIFY_UNAVAILABLE) return { kind: "retry", sentence: SLACK_TOKEN_RETRY_SENTENCE };
  if (notAllowed(result, code)) return { kind: "blocked", reason: "not-admin" };
  return { kind: "retry", sentence: SLACK_TOKEN_RETRY_SENTENCE };
}

/**
 * Check what was pasted before it is sent: no spaces around or inside it, and
 * it starts with `xapp-`. Returns the token to send, or the sentence to show.
 * The sentence never repeats what was pasted.
 */
export function checkSlackAppToken(pasted: string): { ok: true; token: string } | { ok: false; sentence: string } {
  const token = pasted.trim();
  if (!token.startsWith("xapp-") || token.length <= "xapp-".length || /\s/.test(token)) {
    return { ok: false, sentence: SLACK_TOKEN_SHAPE_SENTENCE };
  }
  return { ok: true, token };
}

// ── The view ─────────────────────────────────────────────────────────────

export interface SlackConnectInput {
  /** The bot's latest status answer, or null while the app has none. */
  status: unknown | null;
  /** The status could not be read because the person may not manage this bot. */
  statusDenied?: boolean;
  /** The answer to the attach this modal made, until the status catches up. */
  attached?: unknown | null;
  botName: string;
  /** The attach request is on its way. */
  attachInFlight?: boolean;
  /** The sentence of an attach that did not work and can be tried again. */
  attachError?: string | null;
  /** A refusal the modal cannot get past. */
  blocked?: SlackBlockedReason | null;
  /** The token is on its way to the server. */
  tokenInFlight?: boolean;
  /** The sentence under the token field. */
  tokenError?: string | null;
  /** When the server accepted the token (ms), or null. */
  tokenAcceptedAt?: number | null;
  /** When this modal first saw the last step waiting (ms), or null. */
  waitingSince?: number | null;
  now: number;
}

export type SlackConnectStepKey = "approve" | "token" | "finishing";

export interface SlackConnectStep {
  key: SlackConnectStepKey;
  /** Counted from 1. */
  number: number;
  state: CardModalStepState;
  text: string;
}

export interface SlackConnectView {
  stage: SlackConnectStage;
  title: string;
  /** The app has a status answer for this bot. */
  statusKnown: boolean;
  /**
   * `approve` with nothing created yet: neither the status nor an attach
   * answer shows Slack for this bot. The modal asks the server to set it up.
   */
  needsAttach: boolean;
  /** The step rows. Empty when blocked. */
  steps: SlackConnectStep[];
  /** The small indicator under the title, or null when there are no steps. */
  indicator: CardModalSteps | null;
  /** `approve`: where the person approves the bot, or null when the server sent no usable link. */
  installUrl: string | null;
  /** `token`: the app's page in Slack, or null. */
  appPageUrl: string | null;
  /** `token`: the server is still giving the person access to that page. No field yet. */
  accessPending: boolean;
  /** `connected`: the bot's direct message in Slack, or null when the status lacks an id. */
  botUrl: string | null;
  /** `finishing`: it has taken more than {@link SLACK_FINISHING_SLOW_MS}. */
  slow: boolean;
  /** `finishing`: what the server is waiting on, when the status says. */
  wait: SlackSetupWait | null;
  /** `finishing`: the line under the last step. */
  finishingSentence: string | null;
  blocked: (SlackBlockedCopy & { reason: SlackBlockedReason }) | null;
  /** A request is on its way: the modal must not be closed under it. */
  busy: boolean;
  attachError: string | null;
  tokenError: string | null;
}

const STEP_TEXT: Record<SlackConnectStepKey, (bot: string) => string> = {
  approve: (bot) => `Approve ${bot} in Slack`,
  token: (bot) => `Create a token for ${bot}`,
  finishing: () => "HQ finishes the setup",
};

const STEP_LABEL: Record<SlackConnectStepKey, string> = {
  approve: "Approve in Slack",
  token: "Add the token",
  finishing: "Connecting",
};

function stepsFor(stage: SlackConnectStage, withToken: boolean, bot: string): SlackConnectStep[] {
  if (stage === "blocked") return [];
  const keys: SlackConnectStepKey[] = withToken ? ["approve", "token", "finishing"] : ["approve", "finishing"];
  const at = stage === "connected" ? keys.length : keys.indexOf(stage as SlackConnectStepKey);
  return keys.map((key, index) => ({
    key,
    number: index + 1,
    state: index < at ? "done" : index === at ? "current" : "todo",
    text: STEP_TEXT[key](bot),
  }));
}

/** Build what the modal draws. Pure: same input, same view. */
export function slackConnectView(input: SlackConnectInput): SlackConnectView {
  const bot = botOf(input.botName);
  const facts = slackFactsFromStatus(input.status);
  const fromStatus = slackRowFromStatus(input.status);
  const fromAttach = slackRowFromAttach(input.attached);
  // The status is the truth. The attach answer stands in only until the
  // status shows the row it made.
  const row: SlackRow | null = fromStatus ?? fromAttach;
  const accepted = typeof input.tokenAcceptedAt === "number" ? input.tokenAcceptedAt : null;
  const acceptedJustNow = accepted !== null && input.now - accepted < SLACK_TOKEN_ACCEPT_GRACE_MS;

  let stage: SlackConnectStage;
  let blockedReason: SlackBlockedReason | null = null;
  // Nothing created yet, as far as the app knows: the first step, and the
  // modal asks the server to set Slack up.
  let needsAttach = false;
  if (facts.state === "connected") {
    stage = "connected";
  } else if (input.blocked) {
    stage = "blocked";
    blockedReason = input.blocked;
  } else if (row) {
    const waitingFor = slackRowStage(row);
    stage = waitingFor === "token" && acceptedJustNow ? "finishing" : waitingFor;
  } else if (facts.state === "pending") {
    // Slack is set up in a form this version cannot read: nothing to do but wait.
    stage = "finishing";
  } else if (input.statusDenied) {
    stage = "blocked";
    blockedReason = "not-admin";
  } else {
    stage = "approve";
    needsAttach = true;
  }

  const capability = slackCapabilityFromStatus(input.status);
  // Until the server has said which kind of Slack connection this bot gets,
  // the list shows the path most bots take, with the token step.
  const withToken =
    needsAttach ||
    Boolean(row?.usesToken) ||
    Boolean(fromAttach?.usesToken) ||
    accepted !== null ||
    capability.startsWith("socket-mode");
  const steps = stepsFor(stage, withToken, bot);
  const current = steps.findIndex((step) => step.state === "current");
  const indicator: CardModalSteps | null =
    steps.length > 0
      ? {
          labels: steps.map((step, index) =>
            stage === "connected" && index === steps.length - 1 ? "Connected" : STEP_LABEL[step.key],
          ),
          current: current >= 0 ? current : steps.length - 1,
        }
      : null;

  const since = input.waitingSince ?? accepted;
  const slow = stage === "finishing" && typeof since === "number" && input.now - since > SLACK_FINISHING_SLOW_MS;
  const wait = stage === "finishing" ? slackSetupWaitFromSteps(input.status) : null;

  return {
    stage,
    title: slackConnectTitle(input.botName),
    statusKnown: input.status != null,
    needsAttach,
    steps,
    indicator,
    // A fresher link in the status wins; the attach answer's link is the fallback.
    installUrl: stage === "approve" ? (row?.installUrl ?? fromAttach?.installUrl ?? null) : null,
    appPageUrl: stage === "token" ? (row?.appPageUrl ?? null) : null,
    accessPending: stage === "token" && Boolean(row?.accessPending),
    botUrl: stage === "connected" ? slackBotUrlFromStatus(input.status) : null,
    slow,
    wait,
    finishingSentence: stage === "finishing" ? slackLastStepSentence(input.botName, wait, slow) : null,
    blocked: blockedReason ? { reason: blockedReason, ...slackBlockedCopy(blockedReason, input.botName) } : null,
    busy: Boolean(input.attachInFlight) || Boolean(input.tokenInFlight),
    attachError: stage === "approve" ? (input.attachError?.trim() || null) : null,
    tokenError: stage === "token" ? (input.tokenError?.trim() || null) : null,
  };
}
