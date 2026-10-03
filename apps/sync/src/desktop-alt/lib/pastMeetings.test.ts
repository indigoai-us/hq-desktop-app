import { describe, expect, it } from 'vitest';
import { buildPastMeetingRows, parsePersonalMeetingTranscript } from './pastMeetings';
import type { ScheduledBotLike } from '../../lib/meetingAttribution';

const bot: ScheduledBotLike = {
  botId: 'bot-1',
  status: 'completed',
  meetingTitle: 'Scheduled review',
  scheduledStartTime: '2026-10-02T10:00:00.000Z',
};
const transcript = {
  sourceId: 'native-1',
  title: 'Personal notes',
  createdAt: '2026-10-02T11:00:00.000Z',
};

describe('Past meetings rows', () => {
  it('keeps the current bot-only list when personal transcripts are disabled', () => {
    expect(buildPastMeetingRows([bot], [transcript], false)).toEqual([
      expect.objectContaining({ kind: 'bot', bot }),
    ]);
  });

  it('shows a local personal transcript with no ScheduledBot when enabled', () => {
    expect(buildPastMeetingRows([], [transcript], true)).toEqual([
      expect.objectContaining({ kind: 'personal', transcript }),
    ]);
  });

  it('keeps scheduled-bot rows in both flag states', () => {
    for (const enabled of [false, true]) {
      expect(buildPastMeetingRows([bot], [], enabled)).toEqual([
        expect.objectContaining({ kind: 'bot', bot }),
      ]);
    }
  });

  it('does not duplicate a personal recording already represented by its bot row', () => {
    expect(
      buildPastMeetingRows(
        [bot],
        [{ ...transcript, sourceId: bot.botId }],
        true,
      ).map((row) => row.kind),
    ).toEqual(['bot']);
  });

  it('ignores markdown without the personal meeting markers', () => {
    expect(
      parsePersonalMeetingTranscript(
        'personal/sources/meetings/notes.md',
        '---\ntitle: "Unrelated note"\n---\n',
      ),
    ).toBeNull();
  });

  it('reads only transcript metadata from a personal meetings markdown file', () => {
    expect(
      parsePersonalMeetingTranscript(
        'personal/sources/meetings/native-1.md',
        '---\nsource_id: "native-1"\nchannel: "meeting"\nvisibility: "personal"\nstorage: "local"\ntitle: "Planning"\ncreated_at: "2026-10-02T11:00:00.000Z"\n---\n\n## Transcript\n',
      ),
    ).toEqual({
      sourceId: 'native-1',
      title: 'Planning',
      createdAt: '2026-10-02T11:00:00.000Z',
      botId: null,
      recordingId: null,
    });
  });
});
