import { describe, expect, it } from 'vitest';
import {
  storyLiveRunView,
  type PortfolioSessionRef,
  type Story,
} from '../../src/desktop-alt/lib/projects-model';
import { V4_ROW_STACK_GAP_PX, V4_TYPE_SCALE } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-006 — Stable task detail.
 *
 * Source contracts for: compact project task rail while detail is open,
 * complete field coverage, read-only acceptance criteria from story.passes,
 * Open in Claude Code file actions, no modal/backdrop, project context
 * preserved on close, keyboard rail selection, naked hairline canvas,
 * five type roles + 3px stacks, real matched agent activity only.
 */

describe('DESKTOP-006: stable task detail', () => {
  const detail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
  const panel = readRepoFile('src/desktop-alt/v4/StoryPanel.svelte');
  const projects = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');
  const board = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');

  const baseStory = (overrides: Partial<Story> = {}): Story => ({
    id: 'DESKTOP-006',
    title: 'Stable task detail',
    description: 'Stable rail + detail workspace',
    acceptanceCriteria: [
      'Selected task stays visible in compact rail',
      'Full field coverage when present',
      'Read-only AC inherits story.passes',
      'Open in Claude Code file actions remain',
    ],
    passes: false,
    labels: ['desktop'],
    dependsOn: ['DESKTOP-005'],
    priority: 1,
    notes: 'No modal backdrop',
    files: ['apps/sync/src/desktop-alt/v4/StoryPanel.svelte'],
    ...overrides,
  });

  const session = (overrides: Partial<PortfolioSessionRef> = {}): PortfolioSessionRef => ({
    project: 'hq-desktop-app',
    company: 'indigo',
    cwd: '/Users/x/HQ/companies/indigo/projects/hq-desktop-app',
    status: 'running',
    startedAt: '2026-07-18T12:00:00Z',
    lastActivityAt: '2026-07-18T12:05:00Z',
    source: 'execute-task DESKTOP-006',
    ...overrides,
  });

  it('keeps the selected task visible in a compact project task rail while detail is open', () => {
    expect(detail).toContain('data-testid="project-task-workspace"');
    expect(detail).toContain('data-testid="project-task-rail"');
    expect(detail).toContain('data-testid="task-rail-row"');
    expect(detail).toContain('data-testid="project-task-detail-slot"');
    expect(detail).toContain('class="task-workspace"');
    expect(detail).toContain('class="project-task-rail"');
    expect(detail).toContain('is-selected');
    expect(detail).toContain('aria-selected={isSelected}');
    // Split replaces board while detail is open; board returns when closed.
    expect(detail).toContain('{#if selectedStory}');
    expect(detail).toContain('data-testid="detail-board"');
    expect(detail).toContain('closeTaskDetail');
    expect(detail).toContain('data-testid="task-rail-close"');
  });

  it('does not use a modal, dim backdrop, or detached slide-over for task detail', () => {
    expect(detail).not.toContain('class="story-backdrop"');
    expect(detail).not.toContain('detail-backdrop');
    expect(detail).not.toContain('aria-modal="true"');
    expect(panel).not.toMatch(/class=["']story-backdrop["']/);
    expect(panel).not.toMatch(/<div[^>]*story-backdrop/);
    expect(panel).not.toContain('detail-backdrop');
    expect(panel).not.toContain('aria-modal="true"');
    expect(panel).toContain('embedded');
    expect(panel).toContain('is-embedded');
    expect(panel).toContain('data-testid="v4-story-panel"');
    // Parents still dock via ProjectDetailView selection, not a sibling modal.
    expect(projects).toContain('selectedStory={selectedStory}');
    expect(projects).toContain('oncloseStory={closeStory}');
    expect(projects).not.toContain('<StoryPanel');
    expect(board).toContain('selectedStory={selectedStory}');
    expect(board).not.toContain('<StoryPanel');
  });

  it('preserves full task field coverage when fields exist', () => {
    expect(panel).toContain('data-testid="task-detail-id"');
    expect(panel).toContain('data-testid="task-detail-title"');
    expect(panel).toContain('data-testid="task-detail-status"');
    expect(panel).toContain('data-testid="task-detail-description"');
    expect(panel).toContain('data-testid="task-detail-acceptance"');
    expect(panel).toContain('data-testid="task-detail-dependencies"');
    expect(panel).toContain('data-testid="task-detail-labels"');
    expect(panel).toContain('data-testid="task-detail-notes"');
    expect(panel).toContain('data-testid="task-detail-files"');
    expect(panel).toContain('{#if story.description}');
    expect(panel).toContain('{#if notes}');
    expect(panel).toContain('{#if files.length > 0}');
    expect(panel).toContain('{#if deps.length > 0}');
    expect(panel).toContain('{#if labels.length > 0}');
    expect(panel).toContain('priority');
    expect(panel).toContain('statusLabel');
  });

  it('renders acceptance criteria as a read-only group from story-level passes', () => {
    expect(panel).toContain('data-testid="ac-checklist"');
    expect(panel).toContain('data-testid="ac-readonly-note"');
    expect(panel).toContain('data-testid="ac-progress-count"');
    expect(panel).toContain('acComplete');
    expect(panel).toContain('currentPasses');
    // No independently toggleable criterion checkboxes.
    expect(panel).not.toContain('toggleCriterion');
    expect(panel).not.toContain('aria-pressed={currentPasses}');
    expect(panel).not.toContain('onclick={toggleCriterion}');
    expect(panel).toContain('class="ac-mark"');
    expect(panel).toContain(
      'These criteria complete together when the task-level pass state changes',
    );
    // Task-level status control remains (story.passes), not per-criterion.
    expect(panel).toContain('setStoryPasses');
    expect(panel).toContain('data-testid="task-status-control"');
  });

  it('preserves Open in Claude Code file actions and copy actions', () => {
    expect(panel).toContain('OpenFileInClaudeCode');
    expect(panel).toContain("import OpenFileInClaudeCode from '../components/OpenFileInClaudeCode.svelte'");
    expect(panel).toContain('<OpenFileInClaudeCode {file} folder={hqFolderPath}');
    expect(panel).toContain("invoke('open_claude_code_link'");
    expect(panel).toContain('buildClaudeCodeUrl');
    expect(panel).toContain('data-testid="copy-story-id"');
    expect(panel).toContain('navigator.clipboard.writeText');
    expect(panel).toContain('Open PRD');
    expect(panel).toContain('Run story');
    expect(panel).toContain("invoke('open_in_editor'");
  });

  it('keeps project breadcrumb/tabs/status context; close returns to board without losing project', () => {
    expect(detail).toContain('data-testid="project-breadcrumb"');
    expect(detail).toContain('data-testid="workspace-tabs"');
    expect(detail).toContain('data-testid="status-control"');
    expect(detail).toContain('data-testid="project-toolbar-actions"');
    // Close only clears the story selection — project props remain.
    expect(detail).toContain('oncloseStory?.()');
    expect(detail).toContain('data-testid="task-rail-close"');
    expect(panel).toContain('data-testid="task-detail-close"');
    expect(panel).toContain("event.key === 'Escape'");
    expect(panel).toContain('onclose()');
    // Board/list still present when no selection.
    expect(detail).toContain('<StoryKanban');
    expect(detail).toContain('onselect={onselectStory}');
  });

  it('supports keyboard selection, visible focus, and safe responsive collapse', () => {
    expect(detail).toContain('handleRailKeydown');
    expect(detail).toContain("event.key === 'ArrowDown'");
    expect(detail).toContain("event.key === 'ArrowUp'");
    expect(detail).toContain("event.key === 'Home'");
    expect(detail).toContain("event.key === 'End'");
    expect(detail).toContain('tabindex={isSelected ? 0 : -1}');
    expect(detail).toContain('.task-rail-row:focus-visible');
    expect(detail).toContain('data-testid="task-rail-close"');
    expect(detail).toContain('aria-label="Close task detail"');
    expect(panel).toContain('data-testid="task-detail-close"');
    // Responsive collapse: stack rail above detail at narrow widths.
    expect(detail).toContain('@container project-detail (max-width: 560px)');
    expect(detail).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(detail).toContain('position: sticky');
  });

  it('uses a naked detail canvas with hairline sections; rounded only for controls/selection/live', () => {
    expect(panel).toContain('background: transparent');
    expect(panel).toContain('border-top: 1px solid var(--v4-hairline)');
    expect(panel).toContain('.live-monitor');
    expect(panel).toContain('border-radius: 6px');
    expect(panel).toContain('border-radius: var(--v4-radius-button)');
    // Selection rounding lives on the rail row, not section cards.
    expect(detail).toContain('.task-rail-row');
    expect(detail).toMatch(/\.task-rail-row\s*\{[\s\S]*?border-radius:\s*6px;/);
  });

  it('uses five type roles and 3px title/meta slots; preserves reduced motion/transparency', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(panel).toContain('--type-detail');
    expect(panel).toContain('--type-body');
    expect(panel).toContain('--type-secondary');
    expect(panel).toContain('--type-metadata');
    expect(panel).toContain('var(--v4-row-stack-gap, 3px)');
    expect(panel).toContain('title-stack');
    expect(detail).toContain('var(--v4-row-stack-gap, 3px)');
    expect(panel).toContain('@media (prefers-reduced-motion: reduce)');
    expect(panel).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(detail).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('shows live agent activity only from real matched sessions — no invented events or alarms', () => {
    const now = Date.parse('2026-07-18T12:10:00Z');
    const view = storyLiveRunView(baseStory(), [session()], now);
    expect(view).not.toBeNull();
    expect(view!.phase).toBe('Running');
    expect(view!.workers).toBe(1);
    expect(view!.subagents).toBeNull();
    expect(storyLiveRunView(baseStory({ id: 'OTHER-1' }), [session()], now)).toBeNull();
    expect(storyLiveRunView(baseStory(), [session({ status: 'ended' })], now)).toBeNull();

    expect(panel).toContain('storyLiveRunView');
    expect(panel).toContain('data-testid="task-agent-activity"');
    expect(panel).toContain('data-testid="task-agent-activity-empty"');
    expect(panel).toContain('No active run');
    expect(panel).toContain('subagents unavailable');
    expect(panel).toContain('signal unavailable');
    expect(panel).not.toContain('alert-threshold');
    expect(panel).not.toContain('is-alerting');
    expect(detail).toContain('sessions={sessions}');
  });
});
