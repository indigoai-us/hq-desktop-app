import { describe, expect, it } from 'vitest';
import {
  BOARD_POLL_MS,
  buildStatusLine,
  buildStoryActivity,
  buildStoryPanelModel,
  deriveBoardColumns,
  findLiveSessionForStory,
  type BoardSessionInput,
  type BoardStoryInput,
  type BoardStorySignal,
} from './board-model';

const project = {
  id: 'hq-desktop-app',
  title: 'HQ Desktop',
  name: 'HQ Desktop',
  company: 'indigo',
  prdPath: 'companies/indigo/projects/hq-desktop-app/prd.json',
};

function story(
  partial: Partial<BoardStoryInput> & { id: string },
): BoardStoryInput {
  return {
    title: partial.title ?? partial.id,
    description: partial.description ?? '',
    acceptanceCriteria: partial.acceptanceCriteria ?? [],
    passes: partial.passes ?? false,
    ...partial,
  };
}

function liveSession(
  overrides: Partial<BoardSessionInput> = {},
): BoardSessionInput {
  return {
    project: 'hq-desktop-app',
    company: 'indigo',
    cwd: '/work/hq-desktop-app',
    status: 'running',
    tool: 'claude',
    model: 'opus',
    ...overrides,
  };
}

describe('board-model (US-006 Board tab)', () => {
  it('exports BOARD_POLL_MS for interval refresh', () => {
    expect(BOARD_POLL_MS).toBe(15_000);
  });

  describe('deriveBoardColumns', () => {
    it('maps passes → DONE with SHIPPED status', () => {
      const columns = deriveBoardColumns(
        [story({ id: 'US-001', title: 'Done story', passes: true })],
        [],
        null,
        project,
      );
      const done = columns.find((c) => c.id === 'done');
      expect(done?.cards).toHaveLength(1);
      expect(done?.cards[0]?.statusLine).toBe('SHIPPED');
      expect(done?.cards[0]?.label).toBe('US-001 · Done story');
      expect(done?.title).toBe('DONE');
    });

    it('maps shipped signal → DONE even when passes is false', () => {
      const signals: Record<string, BoardStorySignal> = {
        'US-002': { shipped: true },
      };
      const columns = deriveBoardColumns(
        [story({ id: 'US-002', passes: false })],
        [],
        signals,
        project,
      );
      expect(columns.find((c) => c.id === 'done')?.cards.map((c) => c.storyId)).toEqual([
        'US-002',
      ]);
    });

    it('maps PR open / reviewer → REVIEW', () => {
      const stories = [
        story({ id: 'US-003', title: 'PR review' }),
        story({ id: 'US-004', title: 'Human review' }),
      ];
      const signals: Record<string, BoardStorySignal> = {
        'US-003': { prOpen: true, ciGreen: true },
        'US-004': { reviewer: 'Ada' },
      };
      const columns = deriveBoardColumns(stories, [], signals, project);
      const review = columns.find((c) => c.id === 'review');
      expect(review?.title).toBe('REVIEW');
      expect(review?.cards.map((c) => c.storyId).sort()).toEqual(['US-003', 'US-004']);
      expect(review?.cards.find((c) => c.storyId === 'US-003')?.statusLine).toBe(
        'PR OPEN · CI GREEN',
      );
      expect(review?.cards.find((c) => c.storyId === 'US-004')?.statusLine).toBe(
        'ADA REVIEWING',
      );
    });

    it('maps live agent + queued → IN PROGRESS (live first)', () => {
      const stories = [
        story({ id: 'US-005', title: 'Queued' }),
        story({ id: 'US-006', title: 'Active' }),
      ];
      const sessions = [
        liveSession({
          storyId: 'US-006',
          progressPercent: 42,
          cwd: '/work/hq-desktop-app/US-006',
        }),
      ];
      const columns = deriveBoardColumns(stories, sessions, null, project);
      const inProgress = columns.find((c) => c.id === 'in_progress');
      expect(inProgress?.title).toBe('IN PROGRESS');
      expect(inProgress?.cards.map((c) => c.storyId)).toEqual(['US-006', 'US-005']);
      expect(inProgress?.cards[0]?.statusLine).toBe('AGENT RUNNING · 42%');
      expect(inProgress?.cards[0]?.hasLiveAgent).toBe(true);
      expect(inProgress?.cards[1]?.statusLine).toBe('QUEUED');
      expect(inProgress?.cards[1]?.hasLiveAgent).toBe(false);
    });

    it('moves a card to DONE when pass-state flips true', () => {
      const base = [story({ id: 'US-010', title: 'Flip me', passes: false })];
      const before = deriveBoardColumns(base, [], null, project);
      expect(before.find((c) => c.id === 'in_progress')?.cards).toHaveLength(1);
      expect(before.find((c) => c.id === 'done')?.cards).toHaveLength(0);

      const after = deriveBoardColumns(
        [story({ id: 'US-010', title: 'Flip me', passes: true })],
        [],
        null,
        project,
      );
      expect(after.find((c) => c.id === 'in_progress')?.cards).toHaveLength(0);
      expect(after.find((c) => c.id === 'done')?.cards.map((c) => c.storyId)).toEqual([
        'US-010',
      ]);
      expect(after.find((c) => c.id === 'done')?.cards[0]?.statusLine).toBe('SHIPPED');
    });
  });

  describe('buildStatusLine vocabulary', () => {
    it('emits AGENT RUNNING with and without progress', () => {
      expect(
        buildStatusLine({
          liveSession: liveSession({ progressPercent: 42 }),
        }),
      ).toBe('AGENT RUNNING · 42%');
      expect(
        buildStatusLine({
          liveSession: liveSession({ progressPercent: null }),
        }),
      ).toBe('AGENT RUNNING');
    });

    it('emits reviewer, PR/CI, SHIPPED, and QUEUED forms', () => {
      expect(buildStatusLine({ signal: { reviewer: 'corey' } })).toBe(
        'COREY REVIEWING',
      );
      expect(buildStatusLine({ signal: { prOpen: true, ciGreen: true } })).toBe(
        'PR OPEN · CI GREEN',
      );
      expect(buildStatusLine({ signal: { prOpen: true, ciGreen: false } })).toBe(
        'PR OPEN · CI RED',
      );
      expect(buildStatusLine({ signal: { prOpen: true } })).toBe('PR OPEN');
      expect(buildStatusLine({ passes: true })).toBe('SHIPPED');
      expect(buildStatusLine({ signal: { shipped: true } })).toBe('SHIPPED');
      expect(buildStatusLine({})).toBe('QUEUED');
    });
  });

  describe('buildStoryPanelModel', () => {
    it('builds AC checklist with x/y and story-level pass semantics', () => {
      const open = buildStoryPanelModel(
        story({
          id: 'US-006',
          title: 'Board tab',
          description: 'Show the board',
          acceptanceCriteria: ['Columns', 'Panel', 'Poll'],
          passes: false,
        }),
        project,
        { name: 'HQ Desktop', branchName: 'feature/hq-desktop-v2-chat' },
        [],
      );
      expect(open.acTotal).toBe(3);
      expect(open.acComplete).toBe(0);
      expect(open.acCountLabel).toBe('0/3');
      expect(open.acceptanceCriteria.every((c) => c.done === false)).toBe(true);
      expect(open.fields.branch).toBe('feature/hq-desktop-v2-chat');
      expect(open.fields.project).toBe('HQ Desktop');
      expect(open.fields.assignee).toBe('—');
      expect(open.statusBadge).toBe('QUEUED');

      const done = buildStoryPanelModel(
        story({
          id: 'US-006',
          title: 'Board tab',
          acceptanceCriteria: ['Columns', 'Panel', 'Poll'],
          passes: true,
        }),
        project,
        { branchName: 'main' },
        [],
      );
      // Story-level pass: all criteria done (checked + struck), no per-criterion state.
      expect(done.acComplete).toBe(3);
      expect(done.acCountLabel).toBe('3/3');
      expect(done.acceptanceCriteria.every((c) => c.done === true)).toBe(true);
      expect(done.statusBadge).toBe('SHIPPED');
      expect(done.fields.status).toBe('SHIPPED');
    });

    it('supports partial AC fixtures (2 of 4 struck) and review vocabulary', () => {
      const panel = buildStoryPanelModel(
        story({
          id: 'US-010',
          title: 'Partial AC',
          description: 'Fixture with mixed criteria.',
          acceptanceCriteria: [
            { text: 'One', done: true },
            { text: 'Two', done: true },
            { text: 'Three', done: false },
            { text: 'Four', done: false },
          ],
        }),
        project,
        { branchName: 'feat/v2-chat-shell' },
        [liveSession({ storyId: 'US-010', progressPercent: 42 })],
      );
      expect(panel.acComplete).toBe(2);
      expect(panel.acTotal).toBe(4);
      expect(panel.acCountLabel).toBe('2/4');
      expect(panel.acceptanceCriteria.filter((c) => c.done)).toHaveLength(2);
      expect(panel.description).toContain('mixed criteria');
      expect(panel.statusBadge).toBe('AGENT RUNNING · 42%');
      expect(panel.fields.branch).toBe('feat/v2-chat-shell');

      expect(buildStatusLine({ signal: { reviewer: 'Marcus' } })).toBe('MARCUS REVIEWING');
      expect(buildStatusLine({ signal: { reviewer: 'Design' } })).toBe('DESIGN REVIEW');
      expect(buildStatusLine({ signal: { prOpen: true, ciGreen: true } })).toBe(
        'PR OPEN · CI GREEN',
      );
    });

    it('sets assignee from live agent when running', () => {
      const panel = buildStoryPanelModel(
        story({ id: 'US-007', title: 'Work' }),
        project,
        { branchName: 'feat' },
        [liveSession({ storyId: 'US-007', tool: 'codex', model: 'gpt' })],
      );
      expect(panel.fields.assignee).toBe('codex · gpt');
      expect(panel.statusBadge).toBe('AGENT RUNNING');
    });
  });

  describe('buildStoryActivity', () => {
    it('filters system-event messages by story id (case-insensitive), newest-last', () => {
      const activity = buildStoryActivity(
        [
          {
            eventId: 'e1',
            createdAt: '2026-08-11T10:00:00Z',
            messageKind: 'system',
            body: 'Started US-006 board',
            systemEvent: { v: 1, type: 'run_started', title: 'Run started', summary: 'US-006' },
          },
          {
            eventId: 'e2',
            createdAt: '2026-08-11T12:00:00Z',
            messageKind: 'system',
            systemEvent: {
              v: 1,
              type: 'run_progress',
              title: 'Progress',
              summary: 'working us-006 panel',
            },
          },
          {
            eventId: 'e3',
            createdAt: '2026-08-11T11:00:00Z',
            messageKind: 'text',
            body: 'human chat about US-006',
          },
          {
            eventId: 'e4',
            createdAt: '2026-08-11T09:00:00Z',
            messageKind: 'system',
            systemEvent: { v: 1, type: 'run_started', title: 'Other', summary: 'US-001 only' },
          },
        ],
        'US-006',
      );
      expect(activity.map((a) => a.id)).toEqual(['e1', 'e2']);
      expect(activity[0]?.at).toBe('2026-08-11T10:00:00Z');
      expect(activity[1]?.at).toBe('2026-08-11T12:00:00Z');
      expect(activity[0]?.text).toMatch(/US-006|Run started/i);
    });
  });

  describe('findLiveSessionForStory', () => {
    it('matches by session.storyId and by extracted id from cwd', () => {
      expect(
        findLiveSessionForStory(
          'US-006',
          [liveSession({ storyId: 'US-006' })],
          project,
        )?.storyId,
      ).toBe('US-006');
      expect(
        findLiveSessionForStory(
          'US-008',
          [
            liveSession({
              storyId: null,
              cwd: '/tmp/worktrees/US-008/src',
              project: 'hq-desktop-app',
            }),
          ],
          project,
        )?.cwd,
      ).toContain('US-008');
    });
  });
});
