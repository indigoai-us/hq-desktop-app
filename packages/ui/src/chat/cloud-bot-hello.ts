/**
 * The hello request a new cloud bot gets, composed from what the app can
 * read: the bot's status (whether its files are still downloading, whether
 * it is in Slack, its company) and the company's connection list (the apps
 * brief the bot chooses cards from, with the company's Slack integration
 * connection left out: Slack is said as the bot's own state). The shell
 * sends what this returns.
 *
 * One status call and one list call, the person as the caller. A status or
 * list that cannot be read costs nothing but its section: the hello still
 * goes, with no apps section, and the files are taken as still downloading.
 *
 * The two answers are handed back as read (`status`, `connections`). They are
 * the same two reads the connection cards under the bot's first message are
 * drawn from, so the shell keeps them and that message draws its cards at
 * once, with no second pair of requests first.
 */

import type { PlatformAdapter } from "@hq/platform";
import { agentChatReadiness, buildAgentHelloRequest } from "./agent-channel.js";
import { companyUidFromStatus, slackFactsFromStatus, type BotConnectionRecord } from "./messaging/connection-card-model.js";
import { companyAppsBrief, readCompanyConnections } from "./messaging/integration-cards-model.js";

export interface ComposedCloudBotHello {
  /** The request body, for the bot-only lane. */
  body: string;
  /** The bot's company, when its status said. */
  companyUid: string | null;
  /**
   * The apps brief as sent: null when there is no apps section (the list
   * could not be read, or the company's only connections are its Slack
   * integration, which the brief leaves out), "" when nothing is connected.
   */
  companyApps: string | null;
  /** The bot's status answer as the server sent it. Null when it could not be read. */
  status: unknown | null;
  /** The company's connection list as the server sent it. Null when it was not read or could not be. */
  connections: unknown | null;
}

/**
 * Read the status, then the list, then write the request. `companyUidHint`
 * stands in when the status does not name the company (the open row's).
 */
export async function composeCloudBotHello(
  adapter: Pick<PlatformAdapter, "agents" | "integrations">,
  input: {
    agentUid: string;
    personName: string | null | undefined;
    record?: BotConnectionRecord | null;
    companyUidHint?: string | null;
  },
): Promise<ComposedCloudBotHello> {
  let filesStillDownloading = true;
  let statusValue: unknown = null;
  try {
    const result = await adapter.agents.getStatus(input.agentUid);
    if (result.ok) {
      statusValue = result.value;
      filesStillDownloading = agentChatReadiness(result.value).catchingUp;
    }
  } catch {
    // Say the files are still downloading; that is the usual case this early.
  }
  const companyUid = companyUidFromStatus(statusValue) ?? (input.companyUidHint?.trim() || null);
  let companyApps: string | null = null;
  let connections: unknown | null = null;
  if (companyUid) {
    try {
      const list = await adapter.integrations?.listConnections?.(companyUid);
      if (list?.ok) {
        connections = list.value ?? null;
        const facts = readCompanyConnections(list.value);
        const brief = companyAppsBrief({ facts, record: input.record ?? null });
        // An empty brief means "nothing is connected" only when the list is
        // empty. When the company's connections are all its Slack integration
        // (left out of the brief), "The company has no connected apps yet."
        // would be untrue: the request then carries no apps section at all.
        companyApps = brief === "" && facts !== null && facts.connections.length > 0 ? null : brief;
      }
    } catch {
      companyApps = null;
      connections = null;
    }
  }
  // The bot's own Slack, from its own status. Not known when the status could not be read.
  const inSlack = statusValue != null ? slackFactsFromStatus(statusValue).state === "connected" : null;
  return {
    body: buildAgentHelloRequest({ personName: input.personName, filesStillDownloading, companyApps, inSlack }),
    companyUid,
    companyApps,
    status: statusValue,
    connections,
  };
}
