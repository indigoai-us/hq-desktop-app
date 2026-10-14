// Kept out of profile-pane-model so the shell can name a bot without
// pulling the lazy agent stepper into its static import graph.

/** Conversation-title placeholders that never name a bot (QA-087). */
const PLACEHOLDER_SUBJECT_NAMES = new Set(["direct message", "group message"]);

/**
 * The bot's display name for a profile opened by UID: the first candidate that
 * is a real name. Conversation placeholders ("Direct message") and the raw UID
 * are skipped, so a DM header can never title the pane after itself. Returns
 * "" when nothing is known yet; the pane then shimmers until the refresh lands.
 */
export function botSubjectName(
  uid: string,
  candidates: ReadonlyArray<string | null | undefined>,
): string {
  const id = uid.trim();
  for (const raw of candidates) {
    const name = (raw ?? "").trim();
    if (!name || name === id) continue;
    if (PLACEHOLDER_SUBJECT_NAMES.has(name.toLowerCase())) continue;
    return name;
  }
  return "";
}

/**
 * The company a profile opened from a conversation is viewed in (QA-087).
 * A 1:1 DM row usually has no company of its own, so a bot reached through a
 * company's Bots page Message keeps that company as its viewing company
 * instead of falling back to a generic "Company" label.
 */
export function profileViewingCompanyUid(
  rowCompanyUid: string | null | undefined,
  personUid: string | null | undefined,
  dmOrigins: Readonly<Record<string, string>>,
): string | null {
  const own = rowCompanyUid?.trim();
  if (own) return own;
  const uid = personUid?.trim();
  return (uid && dmOrigins[uid]?.trim()) || null;
}
