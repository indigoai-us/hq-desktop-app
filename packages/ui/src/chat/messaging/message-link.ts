export const MESSAGE_LINK_ORIGIN = "https://work.hq.computer";

export interface MessageLinkParts {
  companyUid: string;
  conversationId: string;
  eventId: string;
}

export interface ParsedMessageLink {
  companyUid: string | null;
  conversationId: string;
  eventId: string;
}

function segment(value: string): string {
  return encodeURIComponent(value.trim());
}

/** Long form shared with the phone app; carries the company so it opens in the right one. */
export function buildMessageLink(parts: MessageLinkParts): string {
  return `${MESSAGE_LINK_ORIGIN}/conversation/${segment(parts.companyUid)}/${segment(
    parts.conversationId,
  )}/message/${segment(parts.eventId)}`;
}

/** Short form: no company, opens in the active one. */
export function buildShortMessageLink(
  parts: Pick<MessageLinkParts, "conversationId" | "eventId">,
): string {
  return `${MESSAGE_LINK_ORIGIN}/c/${segment(parts.conversationId)}/${segment(parts.eventId)}`;
}

/** `chn_…` is a channel; any other conversation id is the other person of a DM. */
export function isChannelConversationId(conversationId: string): boolean {
  return conversationId.startsWith("chn_");
}

export function parseMessageLink(raw: string): ParsedMessageLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  const segs: string[] = [];
  if (scheme === "hq:") {
    if (url.hostname) segs.push(url.hostname);
  } else if (!(scheme === "https:" && url.hostname.toLowerCase() === "work.hq.computer")) {
    return null;
  }
  try {
    for (const part of url.pathname.split("/")) {
      if (part) segs.push(decodeURIComponent(part));
    }
  } catch {
    return null;
  }
  if (
    segs.length === 5 &&
    segs[0]!.toLowerCase() === "conversation" &&
    segs[3] === "message"
  ) {
    return { companyUid: segs[1]!, conversationId: segs[2]!, eventId: segs[4]! };
  }
  if (segs.length === 3 && segs[0]!.toLowerCase() === "c") {
    return { companyUid: null, conversationId: segs[1]!, eventId: segs[2]! };
  }
  return null;
}
