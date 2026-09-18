/**
 * Soft, human copy for composer failures. Server text is kept verbatim and
 * given a friendly prefix — never dump a bare machine code.
 */

/**
 * Server outcomes a retry can never fix: the request itself is the problem, so
 * the sender has to change the message (drop a name, trim the list) before it
 * can ever land. A composer that offers "tap to retry" for one of these sends
 * the user into a loop that always fails — see the mention-denial codes in
 * hq-pro-core notify-dm (INVALID_MENTIONS / MENTION_PARTICIPANT_NOT_VISIBLE /
 * MENTION_PARTICIPANT_NOT_FOUND / CHANNEL_MENTION_INVITE_FORBIDDEN).
 */
const TERMINAL_SEND_CODES = [
  "INVALID_MENTIONS",
  "MENTION_PARTICIPANT_NOT_FOUND",
  "MENTION_PARTICIPANT_NOT_VISIBLE",
  "CHANNEL_MENTION_INVITE_FORBIDDEN",
  "OUTPOST_MENTION_MEMBER_ADDITION_FORBIDDEN",
] as const;

/** Mention denials: the message named someone this channel will not accept. */
const MENTION_DENIAL_PATTERN =
  /MENTION_PARTICIPANT_NOT_VISIBLE|not active in this company|MENTION_PARTICIPANT_NOT_FOUND|mentioned participant was not found|CHANNEL_MENTION_INVITE_FORBIDDEN|mention-invite/i;

export function isTerminalSendError(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  return TERMINAL_SEND_CODES.some((code) => text.includes(code));
}

/** True when the failure is specifically about who the message tagged. */
export function isMentionSendError(raw: string): boolean {
  return MENTION_DENIAL_PATTERN.test(raw.trim());
}

/**
 * The composer message for a failed send, naming the @mentions when the server
 * rejected the message because of who it tagged.
 *
 * The server answers a mention denial with a code and a sentence, never with
 * the offending uid, so the client cannot single one name out. Listing the
 * names that were in the message is the most precise honest answer: it points
 * at the fixable part instead of a bare "Failed".
 */
export function formatComposerSendError(
  raw: string,
  hadFiles: boolean,
  mentionNames: readonly string[] = [],
): string {
  const text = raw.trim();
  if (/failed to fetch|networkerror|^load failed$/i.test(text)) {
    return hadFiles ? "Could not upload the file" : "Could not send the message";
  }
  if (/CHANNEL_NOT_FOUND|channel not found/i.test(text)) {
    return "Couldn't send — this channel isn't available right now. Try reopening it.";
  }
  const named = mentionNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const who =
    named.length === 1
      ? `@${named[0]}`
      : named.length > 1
        ? named.map((name) => `@${name}`).join(", ")
        : "";
  if (/CHANNEL_MENTION_INVITE_FORBIDDEN|mention-invite/i.test(text)) {
    return who
      ? `Couldn't send — only the channel owner can tag someone who isn't a member yet (${who}). Remove the name and send again.`
      : "Couldn't send — only the channel owner can mention someone who isn't a member yet.";
  }
  if (
    /MENTION_PARTICIPANT_NOT_FOUND|mentioned participant was not found/i.test(
      text,
    )
  ) {
    return who
      ? `Couldn't send — ${who} couldn't be found. Remove the name and send again.`
      : "Couldn't send — that @mention couldn't be resolved.";
  }
  if (/MENTION_PARTICIPANT_NOT_VISIBLE|not active in this company/i.test(text)) {
    if (named.length === 1) {
      return `Couldn't send — ${who} isn't in this company, so they can't be tagged here. Remove the name and send again.`;
    }
    return named.length > 1
      ? `Couldn't send — one of these isn't in this company and can't be tagged here: ${who}. Remove the name and send again.`
      : "Couldn't send — that person isn't active in this company.";
  }
  if (/INVALID_MENTIONS/i.test(text)) {
    const stripped = text.replace(/^\[[A-Z0-9_]+\]\s*/i, "").trim();
    return stripped
      ? `Couldn't send — ${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`
      : "Couldn't send — one of the @mentions isn't valid.";
  }
  if (
    text.startsWith("Could not upload ") ||
    text.startsWith("Couldn't attach ") ||
    text.startsWith("Couldn't send") ||
    text.startsWith("Could not send")
  ) {
    return text;
  }
  // Strip machine codes like "[CHANNEL_NOT_FOUND] …" if a human message remains.
  const stripped = text.replace(/^\[[A-Z0-9_]+\]\s*/i, "").trim();
  if (stripped && !/^[A-Z0-9_]+$/.test(stripped)) {
    return stripped.startsWith("Couldn't") || stripped.startsWith("Could not")
      ? stripped
      : `Couldn't send — ${stripped}`;
  }
  return hadFiles
    ? "Could not send the attachment"
    : "Could not send the message";
}
