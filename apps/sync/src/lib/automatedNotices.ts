export interface AutomatedAgentJoinCandidate {
  kind: string;
  body: string;
  fromPersonUid?: string | null;
  details?: string | null;
  prompt?: string | null;
}

function normalizedNoticeBody(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Identify the exact server-authored agent membership announcement.
 *
 * The copy alone is not authoritative: a human can quote the same words.
 * Require both the rigid server template and a trusted agent identity carried
 * by the durable DM event. Rich DMs are excluded because join announcements
 * never carry details or prompts.
 */
export function automatedAgentJoinNoticeKey(
  candidate: AutomatedAgentJoinCandidate,
): string | null {
  if (candidate.kind !== 'dm') return null;
  const sender = candidate.fromPersonUid?.trim().toLocaleLowerCase() ?? '';
  if (!sender.startsWith('agt_') && !sender.startsWith('agent_')) return null;
  if (candidate.details?.trim() || candidate.prompt?.trim()) return null;

  const body = normalizedNoticeBody(candidate.body);
  if (!/^🤖\s+.+?\s+\(an agent\)\s+just joined\s+.+\.\s*$/iu.test(body)) {
    return null;
  }
  return body.toLocaleLowerCase();
}
