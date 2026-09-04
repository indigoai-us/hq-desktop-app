import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source contract for the task strip and its wiring into ChannelView. No
 * component-render harness exists, so — like story-card.test.ts — we pin the
 * things a regression would silently break: the strip renders nothing when
 * empty, it is a status region, it is mounted in the same `belowMessages`
 * slot as the agent-thinking row, and its controller is disposed with the
 * channel it belongs to.
 */
const strip = readFileSync(
  resolve(process.cwd(), 'src/components/messaging/AgentTaskStrip.svelte'),
  'utf8',
);
const channelView = readFileSync(
  resolve(process.cwd(), 'src/components/messaging/ChannelView.svelte'),
  'utf8',
);

describe('AgentTaskStrip source contract', () => {
  it('renders nothing at all when there are no tasks', () => {
    expect(strip).toContain('{#if tasks.length > 0}');
  });

  it('is a polite status region, not a message', () => {
    expect(strip).toContain('role="status"');
    expect(strip).toContain('aria-live="polite"');
  });

  it('renders one TaskChip per task, keyed by id', () => {
    expect(strip).toContain('{#each tasks as task (task.id)}');
    expect(strip).toContain('<TaskChip {task} />');
  });

  it('uses no hardcoded hex colors', () => {
    expect(strip).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('exposes a stable test hook', () => {
    expect(strip).toContain('data-testid="agent-task-strip"');
  });
});

describe('ChannelView wiring', () => {
  it('mounts the strip in the belowMessages slot beside the thinking row', () => {
    const slot = channelView.slice(channelView.indexOf('{#snippet belowMessages()}'));
    const end = slot.indexOf('{/snippet}');
    const body = slot.slice(0, end);
    expect(body).toContain('<AgentThinkingRow');
    expect(body).toContain('<AgentTaskStrip');
  });

  it('feeds the strip from the controller, never from the command directly', () => {
    expect(channelView).toContain('tasks={taskCtl?.tasks ?? []}');
    expect(channelView).not.toContain("invoke<unknown>('list_agent_tasks'");
  });

  it('disposes the task controller with the channel, like the thinking controller', () => {
    expect(channelView).toContain('taskCtl?.dispose()');
    expect(channelView).toContain('new AgentTaskFeedController(');
  });
});
