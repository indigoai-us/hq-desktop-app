/**
 * Soft, human copy for composer failures. Server text is kept verbatim and
 * given a friendly prefix — never dump a bare machine code.
 */
export function formatComposerSendError(raw: string, hadFiles: boolean): string {
  const text = raw.trim();
  if (/failed to fetch|networkerror|^load failed$/i.test(text)) {
    return hadFiles ? "Could not upload the file" : "Could not send the message";
  }
  if (/CHANNEL_NOT_FOUND|channel not found/i.test(text)) {
    return "Couldn't send — this channel isn't available right now. Try reopening it.";
  }
  if (/CHANNEL_MENTION_INVITE_FORBIDDEN|mention-invite/i.test(text)) {
    return "Couldn't send — only the channel owner can mention someone who isn't a member yet.";
  }
  if (
    /MENTION_PARTICIPANT_NOT_FOUND|mentioned participant was not found/i.test(
      text,
    )
  ) {
    return "Couldn't send — that @mention couldn't be resolved.";
  }
  if (/MENTION_PARTICIPANT_NOT_VISIBLE|not active in this company/i.test(text)) {
    return "Couldn't send — that person isn't active in this company.";
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
