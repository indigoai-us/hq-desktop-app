import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-006 — Desktop: Board tab (source contracts).
 *
 * Grep-the-source specs: lock BoardTab wiring into ChannelView, column model,
 * status vocabulary, story panel testids, poll interval, and story-level pass
 * semantics.
 */

const boardModel = readRepoFile('src/desktop-alt/chat/board-model.ts');
const boardTab = readRepoFile('src/desktop-alt/chat/BoardTab.svelte');
const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
const boardModelTest = readRepoFile('src/desktop-alt/chat/board-model.test.ts');

describe('US-006: Board tab wiring', () => {
  it('wires BoardTab into ChannelView board branch with project-tab-board testid', () => {
    expect(channelView).toContain("import BoardTab from '../../desktop-alt/chat/BoardTab.svelte'");
    expect(channelView).toContain("projectTab === 'board'");
    expect(channelView).toContain('<BoardTab');
    expect(channelView).toContain('onOpenInChannel');
    expect(channelView).toContain("projectTab = 'chat'");
    // Root testid lives on BoardTab so existing contracts keep passing.
    expect(boardTab).toContain('data-testid="project-tab-board"');
    expect(channelView).not.toContain('Project board lands in a later story.');
  });

  it('keeps files-tab placeholder untouched', () => {
    expect(channelView).toContain('data-testid="project-tab-files"');
    expect(channelView).toContain('Project files land in a later story.');
  });
});

describe('US-006: board columns + status vocabulary', () => {
  it('defines IN PROGRESS / REVIEW / DONE columns', () => {
    expect(boardModel).toContain("'in_progress'");
    expect(boardModel).toContain("'review'");
    expect(boardModel).toContain("'done'");
    expect(boardModel).toContain('IN PROGRESS');
    expect(boardModel).toContain('REVIEW');
    expect(boardModel).toContain('DONE');
    expect(boardModel).toContain('deriveBoardColumns');
    expect(boardTab).toContain('board-columns');
    expect(boardTab).toContain('data-testid="board-card"');
  });

  it('documents column mapping (DONE / REVIEW / IN PROGRESS) in JSDoc', () => {
    expect(boardModel).toContain('**DONE**');
    expect(boardModel).toContain('**REVIEW**');
    expect(boardModel).toContain('**IN PROGRESS**');
    expect(boardModel).toContain('story.passes');
    expect(boardModel).toContain('shipped');
    expect(boardModel).toContain('prOpen');
    expect(boardModel).toContain('sessionMatchesProject');
    expect(boardModel).toContain('isPortfolioLiveStatus');
  });

  it('includes status-line vocabulary strings', () => {
    expect(boardModel).toContain('AGENT RUNNING · ${progress}%');
    expect(boardModel).toContain('AGENT RUNNING');
    expect(boardModel).toContain('DESIGN REVIEW');
    expect(boardModel).toContain('PR OPEN · CI GREEN');
    expect(boardModel).toContain('PR OPEN · CI RED');
    expect(boardModel).toContain("'PR OPEN'");
    expect(boardModel).toContain("'SHIPPED'");
    expect(boardModel).toContain("'QUEUED'");
  });
});

describe('US-006: story panel + poll + pass semantics', () => {
  it('renders story panel testids and footer actions', () => {
    expect(boardTab).toContain('data-testid="board-story-panel"');
    expect(boardTab).toContain('Open in channel');
    expect(boardTab).toContain('View changes');
    expect(boardTab).toContain('ACCEPTANCE CRITERIA');
    expect(boardTab).toContain('ACTIVITY');
    expect(boardTab).toContain('>STATUS<');
    expect(boardTab).toContain('>ASSIGNEE<');
    expect(boardTab).toContain('>PROJECT<');
    expect(boardTab).toContain('>BRANCH<');
    expect(boardModel).toContain('buildStoryPanelModel');
    expect(boardModel).toContain('buildStoryActivity');
  });

  it('uses BOARD_POLL_MS interval refresh', () => {
    expect(boardModel).toContain('export const BOARD_POLL_MS');
    expect(boardModel).toMatch(/BOARD_POLL_MS\s*=\s*15_?000/);
    expect(boardTab).toContain('BOARD_POLL_MS');
    expect(boardTab).toContain('setInterval');
    expect(boardTab).toContain('clearInterval');
  });

  it('encodes story-level pass semantics (no per-criterion state)', () => {
    expect(boardModel).toContain('story-level pass semantics');
    expect(boardModel).toContain('NO per-criterion state or writes');
    expect(boardModel).toMatch(/acComplete\s*=\s*passes\s*\?\s*acTotal\s*:\s*0/);
    expect(boardModelTest).toContain('story-level pass');
    expect(boardTab).toContain('class:done={item.done}');
    expect(boardTab).toContain('text-decoration: line-through');
  });

  it('board model stays pure (no Svelte / Tauri)', () => {
    expect(boardModel).not.toContain('@tauri-apps/api');
    expect(boardModel).not.toContain('invoke(');
    expect(boardModel).not.toContain('svelte');
  });
});
