import { describe, expect, it } from 'vitest';

import {
  SESSION_AGENT_UID,
  SESSION_MEMBERS,
  SESSION_SELF_UID,
  activityClassForTool,
  foldSessionEvents,
} from './transcript-adapter';
import { SESSION_EVENT_KINDS, type SessionEvent } from './session-events';
import { WS_ACTIVITY_CLASSES, WS_ACTIVITY_STATUSES } from './session-types';

const started: SessionEvent = {
  kind: 'started',
  sessionId: 'sess-1',
  tool: 'claude',
  model: 'opus',
  cwd: '/repo',
  tools: ['Bash', 'Read'],
  commands: [{ name: 'plan', description: 'Plan the work' }],
};

describe('foldSessionEvents — members', () => {
  it('describes exactly two participants: the operator and a local agent', () => {
    expect(SESSION_MEMBERS.map((m) => m.uid)).toEqual([SESSION_SELF_UID, SESSION_AGENT_UID]);
    const [you, agent] = SESSION_MEMBERS;
    expect(you!.kind).toBe('human');
    expect(agent!.kind).toBe('agent');
    expect(agent!.runtime).toBe('local');
  });
});

describe('foldSessionEvents — purity and determinism', () => {
  it('returns an empty transcript for an empty stream', () => {
    expect(foldSessionEvents([])).toEqual({ messages: [], activity: [], pending: [] });
  });

  it('folds the same events to the same transcript, and never mutates the input', () => {
    const events: SessionEvent[] = [started, { kind: 'textDelta', text: 'hi' }];
    const snapshot = JSON.stringify(events);
    const a = foldSessionEvents(events);
    const b = foldSessionEvents(events);
    expect(a).toEqual(b);
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it('assigns monotonic UTC timestamps from the supplied session start', () => {
    const { messages } = foldSessionEvents(
      [started, { kind: 'assistantMessage', text: 'done' }],
      { startedAt: '2026-07-24T09:00:00.000Z', stepMs: 1000 },
    );
    expect(messages.map((m) => m.createdAt)).toEqual([
      '2026-07-24T09:00:00.000Z',
      '2026-07-24T09:00:01.000Z',
    ]);
  });
});

describe('foldSessionEvents — every event kind is handled', () => {
  const oneOfEach: SessionEvent[] = [
    started,
    { kind: 'textDelta', text: 'partial' },
    { kind: 'thinkingDelta', text: 'weighing options' },
    { kind: 'assistantMessage', text: 'final answer' },
    { kind: 'toolCall', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
    { kind: 'toolResult', id: 't1', isError: false, content: 'ok' },
    {
      kind: 'permissionRequest',
      requestId: 'p1',
      toolName: 'Write',
      input: { file_path: '/repo/a.ts' },
      suggestions: [{ behavior: 'allow' }],
    },
    {
      kind: 'questionRequest',
      requestId: 'q1',
      questions: [
        {
          id: 'q1a',
          header: 'Scope',
          text: 'Which package?',
          options: [{ label: 'sync' }, { label: 'ui', description: 'shared' }],
          multiSelect: false,
        },
      ],
    },
    { kind: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0.0123, durationMs: 4200 },
    { kind: 'rateLimit', message: 'slow down', resetsAt: '2026-07-24T10:00:00.000Z' },
    { kind: 'truncated', dropped: 7 },
    { kind: 'turnDone', status: 'success', sessionId: 'sess-1' },
    { kind: 'error', message: 'boom', code: 'E42' },
    { kind: 'exited', code: 0 },
  ];

  it('covers the full enum in this fixture', () => {
    expect([...new Set(oneOfEach.map((e) => e.kind))].sort()).toEqual(
      [...SESSION_EVENT_KINDS].sort(),
    );
  });

  it('produces only known activity classes and statuses', () => {
    const { activity } = foldSessionEvents(oneOfEach);
    expect(activity.length).toBeGreaterThan(0);
    for (const item of activity) {
      expect(WS_ACTIVITY_CLASSES).toContain(item.cls);
      expect(WS_ACTIVITY_STATUSES).toContain(item.status);
      expect(item.agentUid).toBe(SESSION_AGENT_UID);
    }
  });

  it('routes started, rateLimit, turnDone, error and exited to system rows', () => {
    const { messages } = foldSessionEvents(oneOfEach);
    const system = messages.filter((m) => m.kind === 'system').map((m) => m.body);
    expect(system).toHaveLength(5);
    expect(system[0]).toContain('Started claude (opus) in /repo');
    expect(system[1]).toContain('Rate limited: slow down');
    expect(system[1]).toContain('2026-07-24T10:00:00.000Z');
    expect(system[2]).toBe('Turn complete.');
    expect(system[3]).toBe('Error (E42): boom');
    expect(system[4]).toBe('Session exited (code 0).');
  });

  it('emits a thought row, a tool row, a usage row and a suppressed row', () => {
    const { activity } = foldSessionEvents(oneOfEach);
    const byClass = Object.fromEntries(activity.map((a) => [a.cls, a]));
    expect(byClass.thought?.detail).toBe('weighing options');
    expect(byClass['shell-command']?.object).toBe('ls -la');
    expect(byClass['tool-status']?.outcome).toBe('100 in · 20 out · $0.0123 · 4200 ms');
    expect(byClass.suppressed?.suppressedCount).toBe(7);
  });
});

describe('foldSessionEvents — text streaming', () => {
  it('coalesces consecutive textDelta into one streaming assistant message', () => {
    const { messages } = foldSessionEvents([
      { kind: 'textDelta', text: 'Hel' },
      { kind: 'textDelta', text: 'lo ' },
      { kind: 'textDelta', text: 'world' },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: 'message',
      authorUid: SESSION_AGENT_UID,
      body: 'Hello world',
      streaming: true,
    });
  });

  it('finalizes the streaming row on assistantMessage instead of adding a second row', () => {
    const { messages } = foldSessionEvents([
      { kind: 'textDelta', text: 'Hel' },
      { kind: 'textDelta', text: 'lo' },
      { kind: 'assistantMessage', text: 'Hello world' },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe('Hello world');
    expect(messages[0]!.streaming).toBe(false);
  });

  it('starts a fresh row after a finalized message', () => {
    const { messages } = foldSessionEvents([
      { kind: 'textDelta', text: 'one' },
      { kind: 'assistantMessage', text: 'one' },
      { kind: 'textDelta', text: 'two' },
    ]);
    expect(messages.map((m) => m.body)).toEqual(['one', 'two']);
    expect(messages.map((m) => m.streaming)).toEqual([false, true]);
  });

  it('keeps a sub-agent stream in its own row rather than splicing it into the answer', () => {
    const { messages } = foldSessionEvents([
      { kind: 'textDelta', text: 'root ' },
      { kind: 'textDelta', text: 'nested', parentToolUseId: 't9' },
      { kind: 'textDelta', text: 'answer' },
    ]);
    expect(messages.map((m) => m.body)).toEqual(['root answer', 'nested']);
  });

  it('closes an unfinished stream at the turn boundary', () => {
    const { messages } = foldSessionEvents([
      { kind: 'textDelta', text: 'half' },
      { kind: 'turnDone', status: 'interrupted' },
    ]);
    expect(messages[0]!.streaming).toBe(false);
    expect(messages[1]!.body).toBe('Turn interrupted.');
  });

  it('reports the turn error when one is supplied', () => {
    const { messages } = foldSessionEvents([
      { kind: 'turnDone', status: 'error', error: 'model refused' },
    ]);
    expect(messages[0]!.body).toBe('Turn error: model refused.');
  });
});

describe('foldSessionEvents — thinking', () => {
  it('coalesces thinking deltas into one quiet row per turn', () => {
    const { activity } = foldSessionEvents([
      { kind: 'thinkingDelta', text: 'first ' },
      { kind: 'thinkingDelta', text: 'second' },
      { kind: 'turnDone', status: 'success' },
      { kind: 'thinkingDelta', text: 'next turn' },
    ]);
    const thoughts = activity.filter((a) => a.cls === 'thought');
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0]!.detail).toBe('first second');
    expect(thoughts[1]!.detail).toBe('next turn');
    expect(thoughts[0]!.id).not.toBe(thoughts[1]!.id);
  });
});

describe('foldSessionEvents — tool calls', () => {
  it('maps tool names onto presentation classes', () => {
    expect(activityClassForTool('Bash')).toBe('shell-command');
    expect(activityClassForTool('Edit')).toBe('file-edit');
    expect(activityClassForTool('Write')).toBe('file-edit');
    expect(activityClassForTool('Read')).toBe('generic-tool');
    expect(activityClassForTool('Grep')).toBe('generic-tool');
    expect(activityClassForTool('Glob')).toBe('generic-tool');
    expect(activityClassForTool('mcp__linear__create_issue')).toBe('generic-tool');
    expect(activityClassForTool('SomethingBrandNew')).toBe('generic-tool');
  });

  it('opens a tool row as executing and closes it in place on success', () => {
    const { activity } = foldSessionEvents([
      { kind: 'toolCall', id: 't1', name: 'Edit', input: { file_path: '/repo/x.ts' } },
      { kind: 'toolResult', id: 't1', isError: false, content: 'applied' },
    ]);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      id: 'tool-t1',
      cls: 'file-edit',
      status: 'done',
      object: '/repo/x.ts',
      detail: 'Edit',
      outcome: 'applied',
    });
  });

  it('marks a failed tool result as failed', () => {
    const { activity } = foldSessionEvents([
      { kind: 'toolCall', id: 't2', name: 'Bash', input: { command: 'false' } },
      { kind: 'toolResult', id: 't2', isError: true, content: 'exit 1' },
    ]);
    expect(activity[0]!.status).toBe('failed');
    expect(activity[0]!.outcome).toBe('exit 1');
  });

  it('leaves a call with no result executing — agents never go dark', () => {
    const { activity } = foldSessionEvents([
      { kind: 'toolCall', id: 't3', name: 'Read', input: { file_path: '/a' } },
    ]);
    expect(activity[0]!.status).toBe('executing');
  });

  it('still renders a result whose call fell outside the window', () => {
    const { activity } = foldSessionEvents([
      { kind: 'toolResult', id: 'orphan', isError: false, content: 'ok' },
    ]);
    expect(activity[0]).toMatchObject({ id: 'tool-orphan', cls: 'generic-tool', status: 'done' });
  });

  it('falls back to the tool name when the input has no summarizable field', () => {
    const { activity } = foldSessionEvents([
      { kind: 'toolCall', id: 't4', name: 'mcp__x__y', input: { weird: 1 } },
    ]);
    expect(activity[0]!.object).toBe('mcp__x__y');
  });
});

describe('foldSessionEvents — pending decisions', () => {
  it('mirrors a permission request as a waiting-approval row and a pending card', () => {
    const { activity, pending } = foldSessionEvents([
      {
        kind: 'permissionRequest',
        requestId: 'p1',
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        suggestions: [{ behavior: 'allow', updatedInput: {} }],
      },
    ]);
    expect(activity[0]).toMatchObject({
      id: 'perm-p1',
      cls: 'permission',
      status: 'waiting-approval',
      object: 'rm -rf build',
      detail: 'Bash',
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      type: 'permission',
      requestId: 'p1',
      toolName: 'Bash',
      activityId: 'perm-p1',
    });
  });

  it('turns a question request into a pending card with no activity row', () => {
    const { activity, pending } = foldSessionEvents([
      {
        kind: 'questionRequest',
        requestId: 'q1',
        questions: [
          {
            id: 'a',
            header: 'Target',
            text: 'Where should this land?',
            options: [{ label: 'main' }, { label: 'branch', description: 'safer' }],
            multiSelect: true,
          },
        ],
      },
    ]);
    expect(activity).toHaveLength(0);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: 'question', requestId: 'q1' });
    expect(pending[0]!.type === 'question' && pending[0]!.questions[0]!.multiSelect).toBe(true);
  });
});
