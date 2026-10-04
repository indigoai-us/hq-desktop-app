/**
 * The hello request a new cloud bot gets, composed from what the app can
 * read: the bot's status (whether its files are still downloading, whether
 * it is in Slack, its company) and the company's connection list (the apps
 * brief the bot chooses cards from). The shell sends what this returns.
 *
 * One status call and one list call, the person as the caller. A status or
 * list that cannot be read costs nothing but its section: the hello still
 * goes, with no apps section, and the files are taken as still downloading.
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
  /** The apps brief as sent: null when the list could not be read, "" when nothing is connected. */
  companyApps: string | null;
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
  if (companyUid) {
    try {
      const list = await adapter.integrations?.listConnections?.(companyUid);
      if (list?.ok) {
        companyApps = companyAppsBrief({
          facts: readCompanyConnections(list.value),
          record: input.record ?? null,
          slackConnected: statusValue != null && slackFactsFromStatus(statusValue).state === "connected",
        });
      }
    } catch {
      companyApps = null;
    }
  }
  return {
    body: buildAgentHelloRequest({ personName: input.personName, filesStillDownloading, companyApps }),
    companyUid,
    companyApps,
  };
}
