import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * TaskChip is Svelte and the repo has no component-render harness, so we test
 * its SOURCE CONTRACT the same way story-card.test.ts does: design tokens only,
 * no hardcoded hex, a real focus ring, a callback prop, and status text taken
 * from the shared label map rather than written inline.
 */
const source = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/components/TaskChip.svelte'),
  'utf8',
);

describe('TaskChip source contract', () => {
  it('uses design tokens and no hardcoded hex colors', () => {
    expect(source).toContain('var(--');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('carries a visible focus ring', () => {
    expect(source).toContain(':focus-visible');
    expect(source).toContain('var(--v4-focus-ring)');
  });

  it('emits selection through a callback prop, not an event', () => {
    expect(source).toContain('onselect?: (task: AgentTask) => void');
    expect(source).toContain('onselect?.(task)');
  });

  it('is a real button only when it is actually interactive', () => {
    expect(source).toContain("this={interactive ? 'button' : 'span'}");
    expect(source).toContain("type={interactive ? 'button' : undefined}");
  });

  it('takes its status wording from the shared map, never inline strings', () => {
    expect(source).toContain('AGENT_TASK_STATUS_LABEL[task.status]');
    expect(source).not.toMatch(/>\s*(Queued|Done|Failed)\s*</);
  });

  it('colours the status dot from the v4 tone tokens', () => {
    for (const token of ['--v4-ok', '--v4-warn', '--v4-error', '--v4-unread', '--v4-idle']) {
      expect(source).toContain(token);
    }
  });

  it('names the task and its status for assistive tech', () => {
    expect(source).toContain('aria-label');
  });

  it('exposes a stable test hook', () => {
    expect(source).toContain('data-testid="task-chip"');
  });

  it('documents why the generated mark is safe to inline', () => {
    // {@html} is only acceptable here because the markup is generated from a
    // hashed catalogue address and never interpolates task-supplied text.
    expect(source).toContain('{@html mark.svg}');
    expect(source).toMatch(/No task field/i);
  });
});
