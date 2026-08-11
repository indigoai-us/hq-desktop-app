import { describe, expect, it } from 'vitest';
import {
  EDITABLE_PROJECT_STATUSES,
  EDITABLE_PROJECT_STATUS_LABEL,
  toEditableStatus,
} from '../../src/desktop-alt/lib/projects-model';
import {
  escapeHtml,
  renderInline,
  renderMarkdown,
  safeHref,
} from '../../src/desktop-alt/lib/markdown';
import { readRepoFile } from './harness';

/**
 * US-009 — Project detail view + README markdown.
 *
 * Source-contract style (matching the desktop-alt harness): assert the pure
 * markdown helper is safe + correct, the editable-status model is wired, and the
 * ProjectDetailView.svelte + CompanyBoardPanel.svelte sources wire the header metadata,
 * README markdown render, the read-only status control, and the project-open
 * flow that reaches the detail view.
 */

describe('desktop-alt markdown helper (US-009)', () => {
  it('rebuilds the narrow README HTML subset without passing source attributes through', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    // Inline images never initiate a renderer-side request. Their safe alt text
    // remains readable while source attributes and handlers are discarded.
    const html = renderMarkdown('Hello <img src=x alt="Map" onerror=alert(1)>');
    expect(html).toContain('<p>Hello Map</p>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(1)');
  });

  it('renders headings, lists, code, and emphasis to safe tags', () => {
    const html = renderMarkdown(
      ['# Title', '', '- one', '- two', '', '```', 'code()', '```', '', '**bold** and *em*'].join('\n'),
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<pre><code>code()</code></pre>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
  });

  it('renders ordered lists and inline code', () => {
    const html = renderMarkdown('1. first\n2. second');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(renderInline('use `npm run build`')).toContain('<code>npm run build</code>');
  });

  it('only allows safe link schemes (blocks javascript:)', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeHref('/relative/path')).toBe('/relative/path');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();

    // A javascript: link in markdown degrades to escaped label text — no anchor.
    const html = renderInline('[click](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click');
  });
});

describe('desktop-alt editable project status (US-009)', () => {
  it('exposes the five editable statuses with labels', () => {
    expect(EDITABLE_PROJECT_STATUSES).toEqual([
      'planned',
      'prd_created',
      'in_progress',
      'completed',
      'archived',
    ]);
    for (const s of EDITABLE_PROJECT_STATUSES) {
      expect(EDITABLE_PROJECT_STATUS_LABEL[s]).toBeTruthy();
    }
  });

  it('maps raw board statuses onto the editable enum (default planned)', () => {
    expect(toEditableStatus('active')).toBe('in_progress');
    expect(toEditableStatus('complete')).toBe('completed');
    expect(toEditableStatus('archived')).toBe('archived');
    expect(toEditableStatus('')).toBe('planned');
    expect(toEditableStatus('something-unknown')).toBe('planned');
  });
});

describe('desktop-alt project detail view source contract (US-009)', () => {
  const detail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
  const board = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');

  it('wires the header metadata: title, description, company, progress, indicators', () => {
    expect(detail).toContain('data-testid="project-detail-view"');
    expect(detail).toContain('projectDisplayName(project)');
    expect(detail).toContain('detail-description');
    expect(detail).toContain('data-testid="company-badge"');
    // Progress uses US-004's projectProgress.
    expect(detail).toContain('projectProgress');
    expect(detail).toContain('data-testid="detail-progress"');
    // Content indicators for PRD + README presence.
    expect(detail).toContain('data-testid="indicator-prd"');
    expect(detail).toContain('data-testid="indicator-readme"');
  });

  it('reads + renders the README as markdown in-app', () => {
    // README reader: the US-009 Rust command via the local-projects adapter.
    expect(detail).toContain('loadLocalProjectReadme');
    expect(detail).toContain('project.prdPath');
    // Markdown render via the dependency-free helper, into a markdown body.
    expect(detail).toContain('renderMarkdown');
    expect(detail).toContain('data-testid="readme-markdown"');
    expect(detail).toContain('{@html readmeHtml}');
    // The adapter calls the registered Rust command with the camelCased arg.
    const adapter = readRepoFile('src/desktop-alt/lib/local-projects.ts');
    expect(adapter).toContain("invoke<string | null>('get_local_project_readme', { prdPath })");
  });

  it('presents a status control with the editable statuses', () => {
    expect(detail).toContain('data-testid="status-control"');
    expect(detail).toContain('data-testid="status-trigger"');
    expect(detail).toContain('EDITABLE_PROJECT_STATUSES');
    expect(detail).toContain('toEditableStatus');
    // US-010 made this control writable (it was read-only under US-009). The
    // writable contract is asserted in project-status-write.spec.ts; here we just
    // confirm the menu still iterates the editable statuses into options.
    expect(detail).toContain('{#each EDITABLE_PROJECT_STATUSES as status (status)}');
    expect(detail).toContain('data-testid="status-option-{status}"');
  });

  it('embeds the StoryKanban (reachable via Tasks tab) and owns the back affordance', () => {
    expect(detail).toContain('import StoryKanban');
    expect(detail).toContain('<StoryKanban');
    expect(detail).toContain('data-testid="tab-overview"');
    expect(detail).toContain('data-testid="tab-board"');
    expect(detail).toContain('data-testid="detail-back"');
    // DESKTOP-005: Tasks is the default primary surface.
    expect(detail).toContain("tab = $state<Tab>('tasks')");
  });

  it('routes the project-open flow through the detail view', () => {
    // CompanyBoardPanel drills into ProjectDetailView (not straight into StoryKanban).
    expect(board).toContain('import ProjectDetailView');
    expect(board).toContain('<ProjectDetailView');
    expect(board).toContain('onback={backToList}');
    expect(board).toContain('onselectStory={openStory}');
    // Stories still load for the embedded board; task panel docks inside detail.
    expect(board).toContain('loadLocalProjectStories');
    expect(board).toContain('selectedStory={selectedStory}');
    expect(detail).toContain('<StoryPanel');
  });

  it('keeps the detail view token-driven (no hardcoded hex except shadow rgba)', () => {
    const styleBlock = detail.split('<style>')[1] ?? '';
    // Strip the one allowed rgba() box-shadow (a neutral black drop shadow, not a
    // themeable surface color) before asserting no hex literals remain.
    const withoutShadows = styleBlock.replace(/rgba\([^)]*\)/g, '');
    expect(withoutShadows).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('desktop-alt project detail V2 (US-007)', () => {
  const detail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
  const store = readRepoFile('src/desktop-alt/lib/projects-store.svelte.ts');
  const localProjects = readRepoFile('src/desktop-alt/lib/local-projects.ts');

  it('renders the four workspace tabs and the writable status dropdown persists via set_local_project_status', () => {
    expect(detail).toContain('data-testid="tab-overview"');
    expect(detail).toContain('data-testid="tab-board"');
    expect(detail).toContain('data-testid="tab-files"');
    expect(detail).toContain('data-testid="tab-activity"');
    expect(detail).toContain('data-testid="status-menu"');
    // The status write path reaches the registered Rust command.
    expect(detail).toContain('setProjectStatus');
    expect(store).toContain('saveLocalProjectStatus');
    expect(localProjects).toContain("'set_local_project_status'");
  });

  it('preserves the Open in Claude Code / PRD / README actions', () => {
    expect(detail).toContain('data-testid="open-project-claude"');
    expect(detail).toContain('data-testid="open-project-prd"');
    expect(detail).toContain('data-testid="open-project-readme"');
    // PRD/README open into the in-workspace Files preview, not an external app.
    expect(detail).toContain("openProjectDoc('prd.json')");
    expect(detail).toContain("openProjectDoc('README.md')");
  });

  it('Files tab shows the scoped project tree + preview empty state', () => {
    expect(detail).toContain('data-testid="detail-files"');
    expect(detail).toContain('<CompanyFileTree');
    expect(detail).toContain('<FilePreviewPane');
    expect(detail).toContain(
      'Select a project file to read it without leaving the workspace.',
    );
  });

  it('Activity tab lists project-matched sessions with model, runtime, elapsed, and cwd (mission-control-local)', () => {
    expect(detail).toContain('data-testid="detail-activity"');
    expect(detail).toContain(
      'Live sessions matched to this project · contextual, not a global dashboard',
    );
    // Session cards carry the e2e-required fields.
    expect(detail).toContain('data-testid="project-session-card"');
    expect(detail).toContain('data-testid="session-model"');
    expect(detail).toContain('data-testid="session-runtime"');
    expect(detail).toContain('data-testid="session-elapsed"');
    expect(detail).toContain('data-testid="session-cwd"');
    // Matching helper: cwd/repo/project-token matching over the LOCAL fleet
    // (sessions store is fed by list_agent_sessions → local Claude/Codex readers).
    expect(detail).toContain('liveSessionsForProject(project, sessions)');
    expect(detail).toContain('sessionActivityCardView');
    const model = readRepoFile('src/desktop-alt/lib/projects-model.ts');
    expect(model).toContain('export function sessionActivityCardView');
    const sessionsStoreSrc = readRepoFile('src/desktop-alt/lib/sessions-store.svelte.ts');
    expect(sessionsStoreSrc).toContain("invoke<MissionControlSnapshot>('list_agent_sessions')");
  });

  it('task board keeps the V2 column captions with dependency-waiting sublabels', () => {
    const model = readRepoFile('src/desktop-alt/lib/projects-model.ts');
    expect(model).toContain("'not-started': 'Ready or waiting to begin'");
    expect(model).toContain("complete: 'Task-level checks passed'");
    expect(model).toContain("'Waiting on dependencies'");
    const kanban = readRepoFile('src/desktop-alt/components/StoryKanban.svelte');
    expect(kanban).toContain('data-testid="view-toggle-board"');
    expect(kanban).toContain('data-testid="view-toggle-list"');
    expect(kanban).toContain('TASK_COLUMN_CAPTION');
  });
});
