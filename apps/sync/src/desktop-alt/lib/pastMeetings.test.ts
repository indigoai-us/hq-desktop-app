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
  sourceLabel: 'Personal · Local' as const,
  personUid: 'prs_fixture',
};

const desktopSdkSource = parsePersonalMeetingTranscript(
  'companies/indigo/sources/meetings/sdk-recording-1.md',
  '---\nid: "meeting:sdk-recording-1"\nchannel: "meeting"\nsource_id: "sdk-recording-1"\nsource_ref: "sources/meetings/sdk-recording-1.md"\ntitle: "Desktop recording — 2026-10-02"\norigin: "recall.ai"\ncompany_id: "cmp_fixture"\nperson_uid: "prs_fixture"\nmeeting_platform: "desktop-sdk"\ncalendar_event_id: null\nscheduled_start_time: null\ncreated_at: "2026-10-02T11:00:00.000Z"\nupdated_at: "2026-10-02T11:01:00.000Z"\ningested_at: "2026-10-02T11:01:00.000Z"\nrecall_recording_id: "sdk-recording-1"\ncapture_source: "hq-sync-desktop-sdk"\nbot_status: "completed"\n---\n\n## Transcript\n',
);

describe('Past meetings rows', () => {
  it('keeps the current bot-only list when personal transcripts are disabled', () => {
    expect(buildPastMeetingRows([bot], [transcript], false)).toEqual([
      expect.objectContaining({ kind: 'bot', bot }),
    ]);
  });

  it('shows a local personal transcript with no ScheduledBot when enabled', () => {
    expect(buildPastMeetingRows([], [transcript], true, 'prs_fixture')).toEqual([
      expect.objectContaining({ kind: 'personal', transcript }),
    ]);
  });

  it('fails closed for local personal notes without an exact signed-in person uid', () => {
    expect(buildPastMeetingRows([], [{ ...transcript, personUid: 'prs_colleague' }], true, 'prs_fixture')).toEqual([]);
    expect(buildPastMeetingRows([], [{ ...transcript, personUid: null }], true, 'prs_fixture')).toEqual([]);
    expect(buildPastMeetingRows([], [transcript], true)).toEqual([]);
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
      personUid: null,
      conversationId: null,
      sourceIdStored: true,
      provisional: false,
      sessionStatus: null,
      sourceLabel: 'Personal · Local',
    });
  });

  it('parses provisional and session status markers for filtering', () => {
    expect(
      parsePersonalMeetingTranscript(
        'personal/sources/meetings/native-active.md',
        '---\nsource_id: "native-active"\nchannel: "meeting"\nperson_uid: "prs_fixture"\nvisibility: "personal"\nstorage: "local"\nprovisional: true\nsession_status: "active"\n---\n',
      ),
    ).toEqual(expect.objectContaining({ provisional: true, sessionStatus: 'active' }));
  });

  it('omits active, paused, and provisional transcript projections', () => {
    const rows = buildPastMeetingRows(
      [],
      [
        { ...transcript, sourceId: 'active', sessionStatus: 'active' },
        { ...transcript, sourceId: 'paused', sessionStatus: 'paused' },
        { ...transcript, sourceId: 'provisional', provisional: true },
        { ...transcript, sourceId: 'ended', sessionStatus: 'ended' },
      ],
      true,
      'prs_fixture',
    );
    expect(rows.map((row) => row.kind === 'personal' ? row.transcript.sourceId : row.key)).toEqual(['ended']);
  });

  it('shows a synced desktop SDK recording without a ScheduledBot and dedupes its recording id', () => {
    expect(desktopSdkSource).toEqual({
      sourceId: 'sdk-recording-1',
      title: 'Desktop recording — 2026-10-02',
      createdAt: '2026-10-02T11:00:00.000Z',
      botId: null,
      recordingId: 'sdk-recording-1',
      personUid: 'prs_fixture',
      conversationId: null,
      sourceIdStored: true,
      provisional: false,
      sessionStatus: null,
      sourceLabel: 'Desktop recording',
    });
    expect(buildPastMeetingRows([], [desktopSdkSource!], true, 'prs_fixture')).toEqual([
      expect.objectContaining({ kind: 'personal', transcript: desktopSdkSource }),
    ]);
    expect(
      buildPastMeetingRows(
        [{ ...bot, botId: 'sdk-recording-1' }],
        [{ ...desktopSdkSource!, sourceId: 'source-alias' }],
        true,
        'prs_fixture',
      ).map((row) => row.kind),
    ).toEqual(['bot']);
  });

  it('keeps synced desktop SDK recordings hidden when the flag is off', () => {
    expect(buildPastMeetingRows([bot], [desktopSdkSource!], false)).toEqual([
      expect.objectContaining({ kind: 'bot', bot }),
    ]);
  });

  it('shows only this person’s company desktop SDK sources and fails closed without identity', () => {
    const colleagueSource = { ...desktopSdkSource!, personUid: 'prs_colleague' };
    const rows = buildPastMeetingRows(
      [],
      [colleagueSource, desktopSdkSource!],
      true,
      'prs_fixture',
    );

    expect(rows).toEqual([
      expect.objectContaining({ kind: 'personal', transcript: desktopSdkSource }),
    ]);
    expect(buildPastMeetingRows([], [desktopSdkSource!], true)).toEqual([]);
    expect(
      buildPastMeetingRows(
        [],
        [{ ...desktopSdkSource!, personUid: null }],
        true,
        'prs_fixture',
      ),
    ).toEqual([]);
  });
});
