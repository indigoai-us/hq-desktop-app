/**
 * What the app does when the company's connection list shows an app whose
 * card on this device still says "connecting".
 *
 * The record of a Connect press lives in localStorage and can outlive the
 * press by days. A record that is not the answer to a press made just now
 * must never give a bot a private connection: the person did not ask for
 * that. So the bot is let in with no second press only when the connection
 * is provably the answer to the press (see `connectionAnswersPress`): the
 * press is recent, the connection was made after it, and its listed domain
 * is exactly the card's. Everything else forgets the record, which leaves
 * the card on its explicit "Let {bot} use it" button.
 */

import type { AppCardRecord, BotConnectionRecord } from "../chat/messaging/connection-card-model.js";
import {
  botCanUse,
  connectionAnswersPress,
  type CompanyConnection,
  type CompanyConnections,
} from "../chat/messaging/integration-cards-model.js";

/**
 * - `grant`: share the connection with the bot now, then tell the bot.
 * - `announce`: the bot can already use it (open to everyone): tell the bot.
 * - `forget`: do nothing for the bot. The record of the press is dropped.
 */
export type AppConnectFinish = "grant" | "announce" | "forget";

export interface AppConnectFinishInput {
  /** What this device remembers about the card, by its domain. */
  entry: AppCardRecord | null | undefined;
  /** The connection the list shows for the card's domain. */
  connection: CompanyConnection | null | undefined;
  /** The card's domain. */
  domain: string;
  /** The company's list, for who is looking at it. */
  company: Pick<CompanyConnections, "viewerUid"> | null | undefined;
  /** The bot's record on this device, for what was already shared. */
  record: BotConnectionRecord | null | undefined;
  now: number;
}

/**
 * Decide it. Pure. Any doubt is `forget`: a press with no usable time, a time
 * in the future, a press older than the wait, a connection made before the
 * press or with a date that cannot be read, a domain that is not exactly the
 * card's, a connection someone else made, or a viewer the list does not name.
 */
export function appConnectFinish(input: AppConnectFinishInput): AppConnectFinish {
  const { entry, connection, domain, company, record, now } = input;
  if (!entry || !connection) return "forget";
  if (typeof entry.since !== "number" || !Number.isFinite(entry.since) || entry.since > now) return "forget";
  if (!connectionAnswersPress(entry, connection, domain, now)) return "forget";
  const viewerUid = company?.viewerUid ?? "";
  if (viewerUid === "" || connection.createdBy !== viewerUid) return "forget";
  return botCanUse(connection, record) ? "announce" : "grant";
}
