export interface AutomatedAgentJoinCandidate {
  kind: string;
  body: string;
  fromPersonUid?: string | null;
  fromEmail?: string | null;
  fromDisplayName?: string | null;
  details?: string | null;
  prompt?: string | null;
}

function normalizedNoticeBody(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Identify the exact server-authored agent membership announcement.
 *
 * The copy alone is not authoritative: a human can quote the same words.
 * Prefer the trusted agent identity carried by durable DM events. Legacy
 * notification-history rows predate person UIDs, so they may fall back to the
 * exact server template plus a display name matching the announced agent. An
 * explicit human UID always wins and is never compacted. Rich DMs are excluded
 * because join announcements never carry details or prompts.
 */
export function automatedAgentJoinNoticeKey(
  candidate: AutomatedAgentJoinCandidate,
): string | null {
  if (candidate.kind !== "dm") return null;
  const sender = candidate.fromPersonUid?.trim().toLocaleLowerCase() ?? "";
  const agentUid = sender.startsWith("agt_") || sender.startsWith("agent_");
  if (sender && !agentUid) return null;
  if (candidate.details?.trim() || candidate.prompt?.trim()) return null;

  const body = normalizedNoticeBody(candidate.body);
  const match = body.match(
    /^🤖\s+(.+?)\s+\(an agent\)\s+just joined\s+.+\.\s*$/iu,
  );
  if (!match) return null;
  const trustedEmail =
    candidate.fromEmail
      ?.trim()
      .toLocaleLowerCase()
      .endsWith("@agents.getindigo.ai") ?? false;
  const announcedName = normalizedNoticeBody(match[1]).toLocaleLowerCase();
  const displayName = normalizedNoticeBody(
    candidate.fromDisplayName ?? "",
  ).toLocaleLowerCase();
  if (!agentUid && !trustedEmail && displayName !== announcedName) return null;
  return body.toLocaleLowerCase();
}
