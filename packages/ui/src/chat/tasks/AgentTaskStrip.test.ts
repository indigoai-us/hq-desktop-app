import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source contract for the task strip and its wiring into ConversationView. No
 * component-render harness exists, so — like story-card.test.ts — we pin the
 * things a regression would silently break: the strip renders nothing when
 * empty, it is a status region, it is mounted between the message list and
 * the composer, and its controller is disposed with the conversation.
 */
const strip = readFileSync(
  resolve(process.cwd(), 'src/chat/tasks/AgentTaskStrip.svelte'),
  'utf8',
);
const channelView = readFileSync(
  resolve(process.cwd(), 'src/chat/ConversationView.svelte'),
  'utf8',
);

describe('AgentTaskStrip source contract', () => {
  it('renders nothing at all when there are no tasks', () => {
    expect(strip).toContain('{#if shown.length > 0}');
  });

  it('is a polite status region, not a message', () => {
    expect(strip).toContain('role="status"');
    expect(strip).toContain('aria-live="polite"');
  });

  it('renders one TaskChip per task, keyed by id', () => {
    expect(strip).toContain('{#each shown as task (task.id)}');
    expect(strip).toContain('visibleTasks(tasks, now())');
    expect(strip).toContain('<TaskChip {task} />');
  });

  it('uses no hardcoded hex colors', () => {
    expect(strip).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('exposes a stable test hook', () => {
    expect(strip).toContain('data-testid="agent-task-strip"');
  });
});

describe('ConversationView wiring', () => {
  it('mounts the strip between the message list and the composer', () => {
    const strip = channelView.indexOf('<AgentTaskStrip');
    const composer = channelView.indexOf('<div class="conv-composer">');
    expect(strip).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(strip);
  });

  it('feeds the strip from the controller, never from a command directly', () => {
    expect(channelView).toContain('tasks={taskCtl?.tasks ?? []}');
    expect(channelView).not.toContain('invoke(');
    expect(channelView).toContain('api.listChannelAgentTasks');
    expect(channelView).toContain('api.listAgentTasks');
  });

  it('disposes the task controller with the conversation', () => {
    expect(channelView).toContain('ctl.dispose()');
    expect(channelView).toContain('new TaskFeedController(');
  });
});
