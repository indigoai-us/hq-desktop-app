/**
 * What the server says about one bot's Slack, read from its status answer.
 *
 * Shared by the Slack card (connection-card-model.ts) and the Connect Slack
 * modal (slack-connect-model.ts), so the two can never read the same answer
 * two ways. Pure: no Svelte, no network. Every field may be missing.
 *
 * The links here are the only ones in the flow that come from the server.
 * They are opened in the browser, so each is kept only when it is an https
 * link to Slack itself. Anything else is treated as not there.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What a bot's Slack setup is waiting for, while it is not connected. */
export type SlackPendingStage = "approve" | "token" | "finishing";

/** One bot's Slack row (`agent.channels.slack`), reduced to what the app acts on. */
export interface SlackRow {
  /** The app still has to be approved in Slack. */
  installPending: boolean;
  /** Where the person approves it. Null when the server sent no usable link. */
  installUrl: string | null;
  /** The server is waiting for the app-level token. */
  tokenPending: boolean;
  /**
   * The server is still giving the person access to the app's page in Slack.
   * The token cannot be made until that is done.
   */
  accessPending: boolean;
  /** The app's page in Slack where the token is made. Null until the server sends it. */
  appPageUrl: string | null;
  /** This bot's kind of Slack connection needs an app-level token at some point. */
  usesToken: boolean;
}

function slackUrl(value: unknown): URL | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    return host === "slack.com" || host.endsWith(".slack.com") ? url : null;
  } catch {
    return null;
  }
}

/** The link where a person approves the app, when it is a Slack link. */
export function slackInstallUrl(value: unknown): string | null {
  return slackUrl(value)?.toString() ?? null;
}

/**
 * The app's Basic Information page in Slack, where an app-level token is
 * made: the app's page with `/general` at the end, never with two slashes.
 */
export function slackAppPageUrl(value: unknown): string | null {
  const url = slackUrl(value);
  if (!url) return null;
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return /\/general$/.test(base) ? base : `${base}/general`;
}

/** Read one Slack channel config: the status row, or the answer to an attach. */
export function readSlackRow(config: unknown): SlackRow | null {
  if (!isRecord(config)) return null;
  const rawInstall = text(config.installUrl);
  const tokenUrl = text(config.appTokenPendingUrl);
  const accessFlag =
    config.appTokenAccessPending === true || text(config.appTokenAccessPending) !== "";
  const installPending = rawInstall !== "" || text(config.workspace) === "pending-install";
  return {
    installPending,
    installUrl: slackInstallUrl(rawInstall),
    tokenPending: tokenUrl !== "" || accessFlag,
    // Once the page link is here the wait for access is over.
    accessPending: accessFlag && tokenUrl === "",
    appPageUrl: slackAppPageUrl(tokenUrl),
    usesToken: tokenUrl !== "" || accessFlag || text(config.connectionMode) === "socket",
  };
}

function agentOf(json: unknown): Record<string, unknown> | null {
  const root = isRecord(json) ? json : null;
  if (!root) return null;
  return isRecord(root.agent) ? root.agent : root;
}

/** A bot's Slack row from its status answer, or null when it has none. */
export function slackRowFromStatus(json: unknown): SlackRow | null {
  const agent = agentOf(json);
  const channels = isRecord(agent?.channels) ? agent.channels : null;
  return readSlackRow(channels?.slack);
}

/** The Slack row in the answer to an attach (`{ config, followUpUrl }`). */
export function slackRowFromAttach(json: unknown): SlackRow | null {
  return isRecord(json) ? readSlackRow(json.config) : null;
}

/** A Slack id as Slack writes them: capital letters and digits, e.g. T0ACME, U0NOVA. */
const SLACK_ID = /^[A-Z0-9]{2,32}$/;

/**
 * Where a person opens the bot's direct message in Slack, once it is
 * installed: Slack's web client, which hands over to the desktop app when it
 * is there. Built here from the row's ids, never taken from a server link.
 * Null until the row has both a well-formed team id and bot user id. The
 * app opens only http(s) links, so this is never a `slack://` link.
 */
export function slackBotUrlFromStatus(json: unknown): string | null {
  const agent = agentOf(json);
  const channels = isRecord(agent?.channels) ? agent.channels : null;
  const row = isRecord(channels?.slack) ? channels.slack : null;
  if (!row) return null;
  const teamId = text(row.teamId);
  const botUserId = text(row.botUserId);
  if (!SLACK_ID.test(teamId) || !SLACK_ID.test(botUserId)) return null;
  return `https://app.slack.com/client/${teamId}/${botUserId}`;
}

/** What the server reports the bot can receive in Slack (`inboundCapability`). */
export function slackCapabilityFromStatus(json: unknown): string {
  const agent = agentOf(json);
  const diagnostics = isRecord(agent?.channelDiagnostics) ? agent.channelDiagnostics : null;
  const slack = isRecord(diagnostics?.slack) ? diagnostics.slack : null;
  return text(slack?.inboundCapability);
}

/** What a row that is not connected is waiting for. */
export function slackRowStage(row: SlackRow): SlackPendingStage {
  if (row.installPending) return "approve";
  if (row.tokenPending) return "token";
  return "finishing";
}

// ── The last step: what the server is waiting on ─────────────────────────
//
// Once Slack has the app and the token, the server still has to finish the
// setup on the bot's computer before messages flow. That does not wait for
// the bot's file sync: the audit no longer gates on the sync, and a bot made
// in the desktop app is set up chat-first, so the runtime install runs before
// the first full download ends. Seen 2026-10-03 in a live walkthrough: Slack
// connected while the sync had barely started. So the modal and the card say
// nothing about the sync. The one wait they name is the setup's audit, when
// it has stopped on something of its own.

/** One step of the server's setup list (`setupState.steps[]`). */
export interface SetupStep {
  name: string;
  status: string;
  lastError: string | null;
}

/** The setup steps in a status answer, names and statuses lower-cased. Empty when there are none. */
export function setupStepsFromStatus(json: unknown): SetupStep[] {
  const root = isRecord(json) ? json : null;
  if (!root) return [];
  const agent = isRecord(root.agent) ? root.agent : root;
  const setup = isRecord(root.setupState) ? root.setupState : isRecord(agent.setupState) ? agent.setupState : null;
  const steps = Array.isArray(setup?.steps) ? setup.steps : [];
  return steps.filter(isRecord).map((step) => ({
    name: text(step.name).toLowerCase(),
    status: text(step.status).toLowerCase(),
    lastError: text(step.lastError) || null,
  }));
}

/**
 * What the last step is waiting on, when the status says:
 *   - `audit`: the setup's audit has stopped on something of its own. The
 *     server retries it by itself.
 */
export type SlackSetupWait = { kind: "audit" };

/**
 * An audit error that names the file sync. Older servers reported the sync
 * this way while the audit still waited on it. The sync does not hold Slack
 * up, so this is no wait at all.
 */
function isSyncAuditError(lastError: string | null): boolean {
  return lastError !== null && /component-sync/i.test(lastError);
}

/**
 * Whether the status has Slack's config stored and nothing left for the
 * person to do: a team id, no install pending, no token pending, and the
 * bot still cannot receive. Only then is the last step's wait the server's.
 */
function slackConfigStoredNotReceiving(json: unknown): boolean {
  const agent = agentOf(json);
  const channels = isRecord(agent?.channels) ? agent.channels : null;
  const slack = isRecord(channels?.slack) ? channels.slack : null;
  if (!slack || text(slack.teamId) === "") return false;
  const row = readSlackRow(slack);
  if (!row || row.installPending || row.tokenPending) return false;
  const capability = slackCapabilityFromStatus(json);
  return capability !== "ok" && capability !== "socket-mode";
}

/**
 * Read what the last step is waiting on from the setup steps. Null when the
 * status says nothing of the kind, or when Slack is not at the last step.
 *
 * Only the audit's own error is a wait. An audit error that names
 * `component-sync`, a `runtime-install` that is still `pending`, and a first
 * download that is still live are all the ordinary last step: null, so the
 * surfaces show their ordinary connecting line.
 */
export function slackSetupWaitFromSteps(json: unknown): SlackSetupWait | null {
  if (!slackConfigStoredNotReceiving(json)) return null;
  const audit = setupStepsFromStatus(json).find((step) => step.name === "audit") ?? null;
  if (audit?.lastError && !isSyncAuditError(audit.lastError)) return { kind: "audit" };
  return null;
}
