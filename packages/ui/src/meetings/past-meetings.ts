export interface PersonalMeetingTranscript {
  sourceId: string;
  title: string;
  createdAt: string | null;
  botId?: string | null;
  recordingId?: string | null;
  personUid?: string | null;
  conversationId?: string | null;
  sourceIdStored?: boolean;
  legacyAccountVerified?: boolean;
  provisional?: boolean;
  sessionStatus?: string | null;
  sourceLabel: 'Personal · Local' | 'Desktop recording';
}

export interface ScheduledBotLike {
  botId: string;
  status?: string | null;
  sourceLanded?: boolean | null;
  scheduledStartTime?: string | null;
  createdAt?: string | null;
}

export type PastMeetingRow<T extends ScheduledBotLike = ScheduledBotLike> =
  | { kind: 'bot'; key: string; bot: T; timestamp: number }
  | {
      kind: 'personal';
      key: string;
      transcript: PersonalMeetingTranscript;
      timestamp: number;
    };

/** Keeps only the signed-in person's complete, flag-enabled transcript rows. */
export function buildPastMeetingRows<T extends ScheduledBotLike>(
  recordedBots: T[],
  transcripts: PersonalMeetingTranscript[],
  personalTranscriptsEnabled: boolean,
  currentPersonUid: string | null = null,
): PastMeetingRow<T>[] {
  const botRows: PastMeetingRow<T>[] = recordedBots.map((bot) => ({
    kind: 'bot',
    key: `bot:${bot.botId}`,
    bot,
    timestamp: dateTimestamp(bot.scheduledStartTime ?? bot.createdAt),
  }));
  if (!personalTranscriptsEnabled) return botRows;

  const botIds = new Set(recordedBots.map((bot) => bot.botId));
  const signedInPersonUid = currentPersonUid?.trim() || null;
  const personalRows: PastMeetingRow<T>[] = transcripts
    .filter((transcript) => {
      const transcriptPersonUid = transcript.personUid?.trim();
      const isOwnedByPerson =
        !!signedInPersonUid && transcriptPersonUid === signedInPersonUid;
      const isVerifiedLegacyRow =
        !transcriptPersonUid && transcript.legacyAccountVerified === true;
      if (!isOwnedByPerson && !isVerifiedLegacyRow) {
        return false;
      }
      const status = transcript.sessionStatus?.trim().toLowerCase();
      if (transcript.provisional === true || status === 'active' || status === 'paused') {
        return false;
      }
      const identifiers = [transcript.botId, transcript.recordingId, transcript.sourceId];
      return !identifiers.some((identifier) => identifier && botIds.has(identifier));
    })
    .map((transcript) => ({
      kind: 'personal',
      key: `personal:${transcript.sourceId}`,
      transcript,
      timestamp: dateTimestamp(transcript.createdAt),
    }));
  return [...botRows, ...personalRows].sort((a, b) => b.timestamp - a.timestamp);
}

/** Parse a local transcript and verify legacy rows against the native writer's account-bound ID. */
export async function parsePersonalMeetingTranscriptForAccount(
  path: string,
  frontmatter: string,
  accountId: string | null,
): Promise<PersonalMeetingTranscript | null> {
  const transcript = parsePersonalMeetingTranscript(path, frontmatter);
  if (!transcript || transcript.personUid?.trim()) return transcript;
  const account = accountId?.trim();
  const conversationId = transcript.conversationId?.trim();
  if (!account || !conversationId || !transcript.sourceIdStored) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${account}\0${conversationId}`),
    );
    const expectedSourceId = `native-${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}`;
    return transcript.sourceId === expectedSourceId
      ? { ...transcript, legacyAccountVerified: true }
      : null;
  } catch {
    console.warn('Could not verify legacy personal meeting ownership.');
    return null;
  }
}

function dateTimestamp(value: string | null | undefined): number {
  if (!value) return -Infinity;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? -Infinity : timestamp;
}

/** Parse local personal notes and synced hq-pro desktop SDK meeting sources. */
export function parsePersonalMeetingTranscript(
  path: string,
  text: string,
): PersonalMeetingTranscript | null {
  const match = /^(?:personal|companies\/[a-z0-9_-]+)\/sources\/meetings\/([^/]+)\.md$/i.exec(path);
  if (!match) return null;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!frontmatter) return null;
  const fields = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(value);
        if (typeof decoded === 'string') value = decoded;
      } catch {
        console.warn('Could not decode a personal transcript frontmatter scalar.');
      }
    }
    fields.set(field[1], value);
  }
  const isPersonalLocal =
    fields.get('visibility') === 'personal' && fields.get('storage') === 'local';
  const isDesktopSdk =
    fields.get('meeting_platform') === 'desktop-sdk' &&
    fields.get('capture_source') === 'hq-sync-desktop-sdk';
  if (fields.get('channel') !== 'meeting' || (!isPersonalLocal && !isDesktopSdk)) return null;
  const storedSourceId = fields.get('source_id')?.trim() || null;
  const sourceId = storedSourceId || match[1];
  if (!sourceId) return null;
  return {
    sourceId,
    title: fields.get('title')?.trim() || 'Personal meeting',
    createdAt: fields.get('created_at') || fields.get('updated_at') || null,
    botId: fields.get('bot_id') || fields.get('recall_bot_id') || null,
    recordingId:
      fields.get('recording_id') ||
      fields.get('recall_recording_id') ||
      (isDesktopSdk ? sourceId : null),
    personUid: fields.get('person_uid') || null,
    conversationId: fields.get('conversation_id') || null,
    sourceIdStored: storedSourceId !== null,
    provisional: fields.get('provisional') === 'true',
    sessionStatus: fields.get('session_status') || null,
    sourceLabel: isDesktopSdk ? 'Desktop recording' : 'Personal · Local',
  };
}
