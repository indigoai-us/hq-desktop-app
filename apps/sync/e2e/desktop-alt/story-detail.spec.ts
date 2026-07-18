import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-008 / DESKTOP-006 — story detail in-workspace panel.
 *
 * Source-contract (non-render) harness, matching the existing desktop-alt spec
 * style (board-surface.spec.ts). Asserts that StoryPanel wires the
 * docked-panel affordances (close button, Escape — no backdrop), the section
 * content (read-only AC + progress, dependency chips, labels, notes, files),
 * Open in Claude Code, and that ProjectDetailView opens/closes the panel
 * through selection state with a stable task rail.
 */

describe('desktop-alt story detail (US-008 / DESKTOP-006)', () => {
  const panel = readRepoFile(
    'src/desktop-alt/v4/StoryPanel.svelte',
  );
  const page = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');

  it('declares the US-008 props contract', () => {
    // story (Story | null), project, prdPath, onclose, and dependency/status callbacks.
    expect(panel).toContain('story: Story | null');
    expect(panel).toContain('project: Project | null');
    expect(panel).toContain('prdPath: string');
    expect(panel).toContain('onclose: () => void');
    expect(panel).toContain('onselectDependency?: (storyId: string) => void');
    expect(panel).toContain('onStoryPassesChange?: (storyId: string, passes: boolean) => void');
    // Renders nothing when story is null.
    expect(panel).toContain('{#if story}');
  });

  it('is an in-workspace docked panel with close affordances (no dimmed backdrop)', () => {
    // DESKTOP-005/006: no modal backdrop — task detail stays inside the project workspace.
    expect(panel).not.toContain('class="story-backdrop"');
    expect(panel).not.toMatch(/class=["']story-backdrop["']/);
    expect(panel).not.toMatch(/<div[^>]*story-backdrop/);
    expect(panel).toContain('class="story-panel"');
    expect(panel).toContain('data-testid="v4-story-panel"');
    expect(panel).toContain('embedded');
    expect(panel).toContain('is-embedded');

    // Closes on: explicit X button and Escape (no backdrop click path).
    expect(panel).toContain('aria-label="Close story"');
    expect(panel).toContain('onclick={onclose}');
    expect(panel).toContain("event.key === 'Escape'");
    expect(panel).toContain('onkeydown={story ? handleKeydown : undefined}');
  });

  it('renders acceptance criteria as a read-only group with progress', () => {
    expect(panel).toContain("import { setStoryPasses } from '../lib/projects-store.svelte'");
    expect(panel).toContain('class="status-control"');
    expect(panel).toContain('Acceptance criteria');
    expect(panel).toContain('class="progress-track"');
    expect(panel).toContain('style={`width: ${progress}%`}');
    // The checklist iterates the acceptance criteria (read-only marks).
    expect(panel).toContain('{#each acItems as item, index (index)}');
    expect(panel).toContain('data-testid="ac-readonly-note"');
    expect(panel).not.toContain('toggleCriterion');
  });

  it('renders dependency chips as a clickable reselect callback', () => {
    expect(panel).toContain('{#if deps.length > 0}');
    expect(panel).toContain('class="chip-row"');
    expect(panel).toContain('{#each deps as dep (dep)}');
    expect(panel).toContain('onclick={() => onselectDependency?.(dep)}');
  });

  it('renders label chips, description, files, notes, and footer actions', () => {
    expect(panel).toContain('{#each labels as label (label)}');
    expect(panel).toContain('LabelChip');
    expect(panel).toContain('{#if story.description}');
    expect(panel).toContain('<p>{story.description}</p>');
    expect(panel).toContain('{#if notes}');
    // Monospace files list + Open in Claude Code.
    expect(panel).toContain('class="file-list"');
    expect(panel).toContain('{#each files as file (file)}');
    expect(panel).toContain('OpenFileInClaudeCode');
    expect(panel).toContain('Open PRD');
    expect(panel).toContain('Run story');
    expect(panel).toContain('onclick={() => void openPrd()}');
    expect(panel).toContain('onclick={() => void runStory()}');
    expect(panel).toContain("invoke('open_in_editor', { path: prdPath })");
    expect(panel).toContain('buildClaudeCodeUrl({ folder: config.hqFolderPath ?? \'\', prompt })');
    expect(panel).toContain("invoke('open_claude_code_link', { url })");
  });

  it('keeps the panel token-driven (no hardcoded hex)', () => {
    const styleBlock = panel.split('<style>')[1] ?? '';
    // The only allowed literal colors are the neutral black scrim/shadow rgba()s,
    // which carry no hex. Assert there are no hex literals at all.
    expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('wires the panel into ProjectDetailView through parent selection state with a task rail', () => {
    // DESKTOP-006: StoryPanel is docked inside ProjectDetailView with a compact rail.
    expect(page).toContain('onselectStory={openStory}');
    expect(page).toContain('selectedStory={selectedStory}');
    expect(page).toContain('oncloseStory={closeStory}');
    expect(page).toContain('onselectDependency={selectStoryById}');
    expect(page).toContain('{onStoryPassesChange}');
    const detail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
    expect(detail).toContain('onselect={onselectStory}');
    expect(detail).toContain('<StoryPanel');
    expect(detail).toContain('story={selectedStory}');
    expect(detail).toContain('embedded');
    expect(detail).toContain('data-testid="project-task-rail"');
    expect(detail).toContain('data-testid="project-task-workspace"');
    // Leaving the project / going back clears the open story.
    expect(page).toContain('selectedStoryId = null');
  });
});
