/**
 * Message search and the requests the app writes to a bot.
 *
 * When a bot finishes setting up, or a tool is connected for it, the app
 * sends the bot a request on the bot-only lane ("Automatic message from HQ:
 * ..."). The person never sees it in the conversation. The server's message
 * search has no such rule: it indexes the request for both sides, so a search
 * could show the person a message they never wrote and cannot find in the
 * thread (review B-3).
 *
 * This leaves those hits out of the results. A hit is left out only when its
 * text opens with the app's own lead AND it is the app's request:
 *
 *   - it is marked for the bot only (`audience: "agent"`), or
 *   - it was sent from this person's side (`direction: "out"`, or a sender
 *     that is the viewer).
 *
 * A message from the bot or from another person is never left out when the
 * hit says who sent it.
 *
 * The desktop host does not say: its search command returns neither the
 * sender nor the direction. For such a hit the conversation decides. In a
 * direct message with a bot there are two sides, the person and the bot, and
 * the conversation already leaves out every row that opens with the lead,
 * whoever wrote it (`inlineReplyRows`). A hit for that row would open a
 * thread that does not show it, so it is left out here too. Anywhere else
 * (a channel, a group, a direct message with a person) a hit that does not
 * say who sent it is kept.
 */

import { AGENT_HELLO_REQUEST_LEAD, isAgentUid } from "../agent-channel.js";
import type { MessageSearchHit } from "../sidebar-model.js";

/** What a host may add to a hit. The server sends `direction`; some hosts drop it. */
type SearchHitWithSender = MessageSearchHit & {
  audience?: string | null;
  direction?: string | null;
  fromPersonUid?: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function opensWithLead(hit: MessageSearchHit): boolean {
  return [hit.body, hit.snippet].some((value) => text(value).startsWith(AGENT_HELLO_REQUEST_LEAD));
}

/** True when this hit is a request the app wrote to a bot for this person. */
export function isHiddenRequestHit(hit: MessageSearchHit, viewerUid?: string | null): boolean {
  if (!opensWithLead(hit)) return false;
  const known = hit as SearchHitWithSender;
  if (text(known.audience).toLowerCase() === "agent") return true;

  const sender = text(known.fromPersonUid);
  if (sender) return sender === text(viewerUid);

  const direction = text(known.direction).toLowerCase();
  if (direction === "out") return true;
  if (direction === "in") return false;

  // The hit does not say who sent it. Only a direct message with a bot is
  // read as the app's request (see the note at the top of this file).
  return hit.scope === "dm" && isAgentUid(text(hit.counterpartyUid));
}

/** The hits a person is shown: all of them but the app's own requests to a bot. */
export function withoutHiddenRequestHits<T extends MessageSearchHit>(
  hits: readonly T[],
  viewerUid?: string | null,
): T[] {
  return hits.filter((hit) => !isHiddenRequestHit(hit, viewerUid));
}
