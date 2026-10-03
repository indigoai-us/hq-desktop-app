import type { ScheduledBotLike } from '../../lib/meetingAttribution';

export interface PersonalMeetingTranscript {
  sourceId: string;
  title: string;
  createdAt: string | null;
  botId?: string | null;
  recordingId?: string | null;
}

export type PastMeetingRow<T extends ScheduledBotLike = ScheduledBotLike> =
  | { kind: 'bot'; key: string; bot: T; timestamp: number }
  | {
      kind: 'personal';
      key: string;
      transcript: PersonalMeetingTranscript;
      timestamp: number;
    };

/** Keeps local personal transcripts out of Past meetings while the rollout flag is off. */
export function buildPastMeetingRows<T extends ScheduledBotLike>(
  recordedBots: T[],
  transcripts: PersonalMeetingTranscript[],
  personalTranscriptsEnabled: boolean,
): PastMeetingRow<T>[] {
  const botRows: PastMeetingRow<T>[] = recordedBots.map((bot) => ({
    kind: 'bot',
    key: `bot:${bot.botId}`,
    bot,
    timestamp: dateTimestamp(bot.scheduledStartTime ?? bot.createdAt),
  }));
  if (!personalTranscriptsEnabled) return botRows;

  const botIds = new Set(recordedBots.map((bot) => bot.botId));
  const personalRows: PastMeetingRow<T>[] = transcripts
    .filter((transcript) => {
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

function dateTimestamp(value: string | null | undefined): number {
  if (!value) return -Infinity;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? -Infinity : timestamp;
}

/** Parse the frontmatter written by the local personal transcript projector. */
export function parsePersonalMeetingTranscript(
  path: string,
  text: string,
): PersonalMeetingTranscript | null {
  const match = /^personal\/sources\/meetings\/([^/]+)\.md$/i.exec(path);
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
  if (
    fields.get('channel') !== 'meeting' ||
    fields.get('visibility') !== 'personal' ||
    fields.get('storage') !== 'local'
  ) return null;
  const sourceId = fields.get('source_id') || match[1];
  if (!sourceId) return null;
  return {
    sourceId,
    title: fields.get('title')?.trim() || 'Personal meeting',
    createdAt: fields.get('created_at') || fields.get('updated_at') || null,
    botId: fields.get('bot_id') || null,
    recordingId: fields.get('recording_id') || null,
  };
}
