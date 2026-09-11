/**
 * Source-contract test for the sessions transcript component lift.
 *
 * The lifted components are presentation-pure Svelte 5 and the sync suite runs
 * in a node environment, so this test pins the LIFT ITSELF at the source level:
 * every file landed, the design-fixture umbilical is cut, and the props that
 * were deliberately stripped are actually gone. It is the regression fence
 * against a later edit quietly re-importing the parked workspace module or
 * re-introducing the channel-era deep-link/permission props.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SESSIONS_DIR = fileURLToPath(new URL('../../src/components/sessions/', import.meta.url));

const read = (name: string): string => readFileSync(join(SESSIONS_DIR, name), 'utf8');

const EXPECTED_FILES = [
  'ActivityRow.svelte',
  'AgentBadge.svelte',
  'Avatar.svelte',
  'DayDivider.svelte',
  'MessageRow.svelte',
  'MessageTimeline.svelte',
  'Skeleton.svelte',
  'SystemMessageRow.svelte',
  'TimelineSkeleton.svelte',
  'TypingIndicatorRow.svelte',
  'UnreadDivider.svelte',
  'index.ts',
  'session-events.ts',
  'session-types.ts',
  'sessions-tokens.css',
  'transcript-adapter.ts',
];

describe('sessions component lift — files', () => {
  it.each(EXPECTED_FILES)('%s exists and is non-empty', (name) => {
    expect(read(name).trim().length).toBeGreaterThan(0);
  });
});

describe('sessions component lift — the design-fixture umbilical is cut', () => {
  it('no file under components/sessions imports design-fixtures', () => {
    const offenders = readdirSync(SESSIONS_DIR)
      .filter((name) => /\.(svelte|ts|css)$/.test(name))
      .filter((name) => read(name).includes('design-fixtures'));
    expect(offenders).toEqual([]);
  });

  it('the components that need types import them from ./session-types', () => {
    for (const name of [
      'ActivityRow.svelte',
      'Avatar.svelte',
      'MessageRow.svelte',
      'MessageTimeline.svelte',
      'SystemMessageRow.svelte',
      'TypingIndicatorRow.svelte',
    ]) {
      expect(read(name)).toContain("from './session-types'");
    }
  });

  it('session-types exports the timeline derivation the timeline consumes', () => {
    expect(read('session-types.ts')).toContain('export function buildTimelineItems');
  });

  it('session-types carries no fixture data', () => {
    const source = read('session-types.ts');
    for (const fixture of [
      'channelFixture',
      'membersFixture',
      'messagesFixture',
      'homeFeedFixture',
      'activityFixture',
    ]) {
      expect(source).not.toContain(fixture);
    }
  });
});

describe('sessions component lift — MessageTimeline strips the channel-era seams', () => {
  const source = read('MessageTimeline.svelte');

  it('no longer carries the deep-link landing prop', () => {
    expect(source).not.toContain('scrollToEventId');
  });

  it('no longer names a channel', () => {
    expect(source).not.toContain('channelName');
    expect(source).not.toContain('channelCompany');
  });

  it('takes a session title instead', () => {
    expect(source).toContain('sessionTitle');
    expect(source).toContain('sessionSubtitle');
  });

  it('no longer forwards the message permission mirror', () => {
    expect(source).not.toContain('selfUid');
    expect(source).not.toContain('channelOwnerUid');
  });

  it('keeps the four screen states, buildTimelineItems, and interleaved activity', () => {
    for (const state of ['skeleton', 'empty', 'loading', 'loaded']) {
      expect(source).toContain(state);
    }
    expect(source).toContain('buildTimelineItems');
    expect(source).toContain('activity?: WsTimelineActivity[]');
  });
});

describe('sessions component lift — MessageRow strips the messaging affordances', () => {
  const source = read('MessageRow.svelte');

  it('no longer imports the message edit permission helpers', () => {
    expect(source).not.toContain('messageEdit');
    expect(source).not.toContain('canEditMessage');
    expect(source).not.toContain('canDeleteMessage');
  });

  it('no longer renders reactions or the thread teaser', () => {
    expect(source).not.toContain('ws-reaction-pill');
    expect(source).not.toContain('ws-thread-teaser');
    expect(source).not.toContain('ontogglereaction');
  });

  it('keeps author, avatar, body, time and the streaming affordance', () => {
    expect(source).toContain('<Avatar');
    expect(source).toContain('formatTime(message.createdAt)');
    expect(source).toContain('class="body"');
    expect(source).toContain('ws-stream-caret');
  });
});

describe('sessions component lift — nothing outside the lift came along', () => {
  it('none of the parked shells, panels or controllers were copied', () => {
    const present = new Set(readdirSync(SESSIONS_DIR));
    for (const name of [
      'ActivityFeed.svelte',
      'ThreadPanel.svelte',
      'MessageComposer.svelte',
      'WorkspaceShell.svelte',
      'HomeFeed.svelte',
      'ChannelScreen.svelte',
      'CommandKSearch.svelte',
      'MemberRoster.svelte',
      'PersonaManagerPanel.svelte',
      'AddAgentPanel.svelte',
      'AutomationsPanel.svelte',
      'AgentDoctorPanel.svelte',
    ]) {
      expect(present.has(name)).toBe(false);
    }
    expect([...present].filter((n) => n.endsWith('Controller.svelte.ts'))).toEqual([]);
  });
});
