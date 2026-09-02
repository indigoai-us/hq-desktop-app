import { describe, expect, it } from 'vitest';

import {
  SESSION_AGENT_UID,
  SESSION_MEMBERS,
  SESSION_SELF_UID,
  describeToolInput,
  foldSessionEvents,
  toolCategory,
  toolGroupSummary,
  type ChatBlock,
  type ToolCallSummary,
  type UserTurn,
} from './transcript-adapter';
import { SESSION_EVENT_KINDS, type SessionEvent } from './session-events';

const started: SessionEvent = {
  kind: 'started',
  sessionId: 'sess-1',
  tool: 'claude',
  model: 'opus',
  cwd: '/repo',
  tools: ['Bash', 'Read'],
  commands: [{ name: 'plan', description: 'Plan the work' }],
};

/** The block types, in order — the shape assertions read off this a lot. */
const types = (blocks: ChatBlock[]): string[] => blocks.map((block) => block.type);

function proseText(blocks: ChatBlock[]): string[] {
  return blocks
    .filter((block): block is Extract<ChatBlock, { type: 'assistantProse' }> =>
      block.type === 'assistantProse',
    )
    .map((block) => block.text);
}

function groups(blocks: ChatBlock[]): Extract<ChatBlock, { type: 'toolGroup' }>[] {
  return blocks.filter(
    (block): block is Extract<ChatBlock, { type: 'toolGroup' }> => block.type === 'toolGroup',
  );
}

function call(overrides: Partial<ToolCallSummary> = {}): ToolCallSummary {
  return {
    id: 'c1',
    name: 'Bash',
    detail: 'ls',
    status: 'ok',
    outcome: '',
    output: '',
    ...overrides,
  };
}

function turn(overrides: Partial<UserTurn> = {}): UserTurn {
  return { id: 't1', text: 'do the thing', atIndex: 0, at: null, ...overrides };
}

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
    expect(foldSessionEvents([])).toEqual({
      blocks: [],
      pending: [],
      lastUsage: null,
      ended: false,
    });
  });

  it('folds the same events to the same blocks, and never mutates the input', () => {
    const events: SessionEvent[] = [started, { kind: 'textDelta', text: 'hi' }];
    const turns = [turn()];
    const snapshot = JSON.stringify({ events, turns });
    const a = foldSessionEvents(events, { userTurns: turns });
    const b = foldSessionEvents(events, { userTurns: turns });
    expect(a).toEqual(b);
    expect(JSON.stringify({ events, turns })).toBe(snapshot);
  });

  it('invents no timestamp for an event that has none', () => {
    const { blocks } = foldSessionEvents([{ kind: 'assistantMessage', text: 'done' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.at).toBeNull();
  });
});

describe('foldSessionEvents — every event kind is handled', () => {
  const oneOfEach: SessionEvent[] = [
    started,
    { kind: 'thinkingDelta', text: 'weighing it up' },
    { kind: 'textDelta', text: 'on ' },
    { kind: 'assistantMessage', text: 'on it' },
    { kind: 'toolCall', id: 'c1', name: 'Bash', input: { command: 'ls' } },
    { kind: 'toolResult', id: 'c1', isError: false, content: 'a\nb' },
    {
      kind: 'permissionRequest',
      requestId: 'p1',
      toolName: 'Write',
      input: { file_path: 'hello.txt' },
      suggestions: [],
    },
    {
      kind: 'questionRequest',
      requestId: 'q1',
      questions: [
        { id: 'q', header: 'Scope', text: 'How far?', options: [{ label: 'All' }], multiSelect: false },
      ],
    },
    { kind: 'usage', inputTokens: 2, outputTokens: 17, costUsd: 0.68 },
    { kind: 'rateLimit', message: 'slow down' },
    { kind: 'truncated', dropped: 9 },
    { kind: 'turnDone', status: 'success' },
    { kind: 'error', message: 'boom', code: 'E1' },
    { kind: 'exited', code: 0 },
  ];

  it('covers the full enum in this fixture', () => {
    const covered = new Set(oneOfEach.map((event) => event.kind));
    expect([...SESSION_EVENT_KINDS].filter((kind) => !covered.has(kind))).toEqual([]);
  });

  it('produces only known block types', () => {
    const known = new Set([
      'userBubble',
      'assistantProse',
      'thinking',
      'toolGroup',
      'permissionCard',
      'questionCard',
      'error',
      'divider',
    ]);
    const { blocks } = foldSessionEvents(oneOfEach, { userTurns: [turn()] });
    for (const block of blocks) expect(known.has(block.type)).toBe(true);
  });
});

describe('foldSessionEvents — the operator’s own turns', () => {
  it('mirrors a sent turn as a bubble, because the event stream carries none', () => {
    // The whole reason `userTurns` exists: there is no user-message event kind.
    expect([...SESSION_EVENT_KINDS]).not.toContain('userMessage');

    const { blocks } = foldSessionEvents([{ kind: 'assistantMessage', text: 'on it' }], {
      userTurns: [turn({ text: 'do the thing', atIndex: 0 })],
    });
    expect(types(blocks)).toEqual(['userBubble', 'assistantProse']);
    expect((blocks[0] as Extract<ChatBlock, { type: 'userBubble' }>).text).toBe('do the thing');
  });

  it('interleaves a later turn at the event index it was sent from', () => {
    const { blocks } = foldSessionEvents(
      [
        { kind: 'assistantMessage', text: 'first' },
        { kind: 'assistantMessage', text: 'second' },
      ],
      {
        userTurns: [
          turn({ id: 'a', text: 'one', atIndex: 0 }),
          turn({ id: 'b', text: 'two', atIndex: 1 }),
        ],
      },
    );
    expect(types(blocks)).toEqual([
      'userBubble',
      'assistantProse',
      'userBubble',
      'assistantProse',
    ]);
  });

  it('shows a turn sent before any reply has arrived — the first-send bubble', () => {
    const { blocks } = foldSessionEvents([], { userTurns: [turn({ text: 'hello' })] });
    expect(types(blocks)).toEqual(['userBubble']);
    expect((blocks[0] as Extract<ChatBlock, { type: 'userBubble' }>).text).toBe('hello');
  });

  it('sorts turns by index rather than trusting the caller’s order', () => {
    const { blocks } = foldSessionEvents([{ kind: 'assistantMessage', text: 'reply' }], {
      userTurns: [
        turn({ id: 'b', text: 'second', atIndex: 1 }),
        turn({ id: 'a', text: 'first', atIndex: 0 }),
      ],
    });
    const bubbles = blocks
      .filter((block) => block.type === 'userBubble')
      .map((block) => (block as Extract<ChatBlock, { type: 'userBubble' }>).text);
    expect(bubbles).toEqual(['first', 'second']);
  });
});

describe('foldSessionEvents — assistant prose', () => {
  it('coalesces consecutive textDelta into one streaming block', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'textDelta', text: 'Hel' },
      { kind: 'textDelta', text: 'lo' },
    ]);
    expect(types(blocks)).toEqual(['assistantProse']);
    const prose = blocks[0] as Extract<ChatBlock, { type: 'assistantProse' }>;
    expect(prose.text).toBe('Hello');
    expect(prose.streaming).toBe(true);
  });

  it('finalizes the streaming block on assistantMessage instead of adding a second', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'textDelta', text: 'Hel' },
      { kind: 'assistantMessage', text: 'Hello there' },
    ]);
    expect(types(blocks)).toEqual(['assistantProse']);
    const prose = blocks[0] as Extract<ChatBlock, { type: 'assistantProse' }>;
    expect(prose.text).toBe('Hello there');
    expect(prose.streaming).toBe(false);
  });

  it('closes an unfinished stream at the turn boundary', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'textDelta', text: 'partial' },
      { kind: 'turnDone', status: 'success' },
    ]);
    expect(proseText(blocks)).toEqual(['partial']);
    expect((blocks[0] as Extract<ChatBlock, { type: 'assistantProse' }>).streaming).toBe(false);
  });

  it('keeps a sub-agent stream out of the top-level answer', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'toolCall', id: 'task-1', name: 'Task', input: { description: 'dig' } },
      { kind: 'textDelta', text: 'sub-agent chatter', parentToolUseId: 'task-1' },
      { kind: 'assistantMessage', text: 'the answer' },
    ]);
    expect(proseText(blocks)).toEqual(['the answer']);
    expect(groups(blocks)[0]!.calls[0]!.output).toBe('sub-agent chatter');
  });

  it('gives an orphaned sub-agent stream a row rather than losing it', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'assistantMessage', text: 'sub-agent output', parentToolUseId: 'gone' },
    ]);
    expect(proseText(blocks)).toEqual([]);
    expect(groups(blocks)[0]!.calls[0]!.output).toBe('sub-agent output');
  });
});

describe('foldSessionEvents — thinking', () => {
  it('shows a live thinking block while nothing has been said yet', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'thinkingDelta', text: 'hmm' },
      { kind: 'thinkingDelta', text: ' ok' },
    ]);
    expect(types(blocks)).toEqual(['thinking']);
    expect((blocks[0] as Extract<ChatBlock, { type: 'thinking' }>).text).toBe('hmm ok');
  });

  it('retires the thinking block the moment the agent says anything', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'thinkingDelta', text: 'hmm' },
      { kind: 'assistantMessage', text: 'here you go' },
    ]);
    expect(types(blocks)).toEqual(['assistantProse']);
  });

  it('retires it at the turn boundary even with nothing said', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'thinkingDelta', text: 'hmm' },
      { kind: 'turnDone', status: 'success' },
    ]);
    expect(blocks).toEqual([]);
  });
});

describe('foldSessionEvents — tool groups', () => {
  it('folds a run of tool calls into ONE row', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'toolCall', id: 'a', name: 'Bash', input: { command: 'ls' } },
      { kind: 'toolResult', id: 'a', isError: false, content: 'ok' },
      { kind: 'toolCall', id: 'b', name: 'Read', input: { file_path: '/x.ts' } },
      { kind: 'toolResult', id: 'b', isError: false, content: 'ok' },
    ]);
    expect(types(blocks)).toEqual(['toolGroup']);
    expect(groups(blocks)[0]!.summary).toBe('Ran 1 command · read 1 file');
    expect(groups(blocks)[0]!.calls).toHaveLength(2);
  });

  it('starts a new group after the agent speaks', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'toolCall', id: 'a', name: 'Bash', input: { command: 'ls' } },
      { kind: 'assistantMessage', text: 'looked around' },
      { kind: 'toolCall', id: 'b', name: 'Bash', input: { command: 'pwd' } },
    ]);
    expect(types(blocks)).toEqual(['toolGroup', 'assistantProse', 'toolGroup']);
  });

  it('stays running until every call in it has a result', () => {
    const open = foldSessionEvents([
      { kind: 'toolCall', id: 'a', name: 'Bash', input: { command: 'sleep 5' } },
    ]);
    expect(groups(open.blocks)[0]!.running).toBe(true);
    expect(groups(open.blocks)[0]!.calls[0]!.status).toBe('running');

    const closed = foldSessionEvents([
      { kind: 'toolCall', id: 'a', name: 'Bash', input: { command: 'sleep 5' } },
      { kind: 'toolResult', id: 'a', isError: false, content: 'done' },
    ]);
    expect(groups(closed.blocks)[0]!.running).toBe(false);
    expect(groups(closed.blocks)[0]!.calls[0]!.status).toBe('ok');
  });

  it('marks a failed result and names the failure on the summary', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'toolCall', id: 'a', name: 'Bash', input: { command: 'boom' } },
      { kind: 'toolResult', id: 'a', isError: true, content: 'exit 1' },
    ]);
    expect(groups(blocks)[0]!.calls[0]!.status).toBe('error');
    expect(groups(blocks)[0]!.summary).toBe('Ran 1 command · 1 failed');
  });

  it('still renders a result whose call fell outside the replay window', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'toolResult', id: 'orphan', isError: false, content: 'late' },
    ]);
    expect(groups(blocks)[0]!.calls[0]!.id).toBe('orphan');
    expect(groups(blocks)[0]!.calls[0]!.outcome).toBe('late');
  });
});

describe('toolGroupSummary', () => {
  it('buckets every tool name it knows', () => {
    expect(toolCategory('Bash')).toBe('command');
    expect(toolCategory('Edit')).toBe('edit');
    expect(toolCategory('Write')).toBe('edit');
    expect(toolCategory('Read')).toBe('read');
    expect(toolCategory('Grep')).toBe('search');
    expect(toolCategory('Glob')).toBe('search');
    expect(toolCategory('WebFetch')).toBe('fetch');
    expect(toolCategory('TodoWrite')).toBe('todo');
    // The safety net: an MCP tool is counted, never dropped.
    expect(toolCategory('mcp__slack__send')).toBe('other');
  });

  it('reads like the reference line', () => {
    const calls = [
      ...Array.from({ length: 8 }, (_, i) => call({ id: `b${i}`, name: 'Bash' })),
      call({ id: 'e1', name: 'Edit', detail: 'a.ts' }),
      ...Array.from({ length: 5 }, (_, i) =>
        call({ id: `r${i}`, name: 'Read', detail: `f${i}.ts` }),
      ),
    ];
    expect(toolGroupSummary(calls)).toBe('Ran 8 commands · edited 1 file · read 5 files');
  });

  it('counts edited FILES, not edit calls', () => {
    expect(
      toolGroupSummary([
        call({ id: '1', name: 'Edit', detail: 'a.ts' }),
        call({ id: '2', name: 'Edit', detail: 'a.ts' }),
        call({ id: '3', name: 'Write', detail: 'b.ts' }),
      ]),
    ).toBe('Edited 2 files');
  });

  it('singularises', () => {
    expect(toolGroupSummary([call()])).toBe('Ran 1 command');
    expect(toolGroupSummary([call({ name: 'Read', detail: 'a' })])).toBe('Read 1 file');
    expect(toolGroupSummary([call({ name: 'Grep', detail: 'x' })])).toBe('Searched 1 time');
  });

  it('names unknown tools rather than reporting nothing', () => {
    expect(toolGroupSummary([call({ name: 'mcp__x__y', detail: '' })])).toBe('Used 1 tool');
  });

  it('reports a size for a group of nothing recognisable', () => {
    expect(toolGroupSummary([])).toBe('0 tools');
  });
});

describe('describeToolInput', () => {
  it('takes the most useful single field', () => {
    expect(describeToolInput({ command: 'ls -la' })).toBe('ls -la');
    expect(describeToolInput({ file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts');
    expect(describeToolInput({ pattern: 'TODO' })).toBe('TODO');
    expect(describeToolInput('literal')).toBe('literal');
  });

  it('collapses to one line and bounds the length', () => {
    expect(describeToolInput({ command: 'a\nb\n  c' })).toBe('a b c');
    expect(describeToolInput({ command: 'x'.repeat(400) }).length).toBeLessThanOrEqual(161);
  });

  it('returns nothing rather than dumping a payload it cannot summarise', () => {
    expect(describeToolInput({ weird: { nested: true } })).toBe('');
  });
});

describe('foldSessionEvents — decisions', () => {
  const permission: SessionEvent = {
    kind: 'permissionRequest',
    requestId: 'p1',
    toolName: 'Write',
    input: { file_path: 'hello.txt' },
    suggestions: [],
  };

  it('renders a permission request inline AND reports it as pending', () => {
    const { blocks, pending } = foldSessionEvents([permission]);
    expect(types(blocks)).toEqual(['permissionCard']);
    const card = blocks[0] as Extract<ChatBlock, { type: 'permissionCard' }>;
    expect(card.requestId).toBe('p1');
    expect(card.toolName).toBe('Write');
    expect(card.resolution).toBeNull();
    expect(pending).toEqual([
      { type: 'permission', requestId: 'p1', toolName: 'Write', input: { file_path: 'hello.txt' }, suggestions: [] },
    ]);
  });

  it('collapses an answered card and drops it from pending', () => {
    const { blocks, pending } = foldSessionEvents([permission], {
      resolutions: { p1: 'Allowed' },
    });
    expect(types(blocks)).toEqual(['permissionCard']);
    expect((blocks[0] as Extract<ChatBlock, { type: 'permissionCard' }>).resolution).toBe(
      'Allowed',
    );
    // The card stays in the transcript as history; only the BLOCK is lifted.
    expect(pending).toEqual([]);
  });

  it('does the same for a question request', () => {
    const question: SessionEvent = {
      kind: 'questionRequest',
      requestId: 'q1',
      questions: [
        { id: 'q', header: 'Scope', text: 'How far?', options: [{ label: 'All' }], multiSelect: false },
      ],
    };
    const open = foldSessionEvents([question]);
    expect(types(open.blocks)).toEqual(['questionCard']);
    expect(open.pending).toHaveLength(1);

    const answered = foldSessionEvents([question], { resolutions: { q1: 'Answered · All' } });
    expect(
      (answered.blocks[0] as Extract<ChatBlock, { type: 'questionCard' }>).resolution,
    ).toBe('Answered · All');
    expect(answered.pending).toEqual([]);
  });
});

describe('foldSessionEvents — what is NOT a row', () => {
  it('opens with nothing at all: `started` is not news', () => {
    expect(foldSessionEvents([started]).blocks).toEqual([]);
  });

  it('says nothing on a successful turn boundary', () => {
    expect(foldSessionEvents([{ kind: 'turnDone', status: 'success' }]).blocks).toEqual([]);
  });

  it('routes usage to the footer summary instead of the stream', () => {
    const { blocks, lastUsage } = foldSessionEvents([
      { kind: 'usage', inputTokens: 2, outputTokens: 17, costUsd: 0.68 },
    ]);
    expect(blocks).toEqual([]);
    expect(lastUsage?.label).toBe('2 in · 17 out · $0.68');
  });

  it('keeps only the LAST usage', () => {
    const { lastUsage } = foldSessionEvents([
      { kind: 'usage', inputTokens: 1, outputTokens: 1 },
      { kind: 'usage', inputTokens: 4, outputTokens: 9 },
    ]);
    expect(lastUsage?.label).toBe('4 in · 9 out');
    expect(lastUsage?.outputTokens).toBe(9);
  });

  it('compacts a long turn’s token counts', () => {
    const { lastUsage } = foldSessionEvents([
      { kind: 'usage', inputTokens: 12_400, outputTokens: 999 },
    ]);
    expect(lastUsage?.label).toBe('12.4k in · 999 out');
  });
});

describe('foldSessionEvents — problems and lifecycle', () => {
  it('renders an error as an inline error line', () => {
    const { blocks } = foldSessionEvents([{ kind: 'error', message: 'boom', code: 'E1' }]);
    expect(types(blocks)).toEqual(['error']);
    const error = blocks[0] as Extract<ChatBlock, { type: 'error' }>;
    expect(error.text).toBe('boom (E1)');
    expect(error.tone).toBe('error');
  });

  it('reports a failed turn but calls an interruption what it is', () => {
    const failed = foldSessionEvents([{ kind: 'turnDone', status: 'error', error: 'nope' }]);
    expect((failed.blocks[0] as Extract<ChatBlock, { type: 'error' }>).text).toBe(
      'Turn failed: nope.',
    );
    const stopped = foldSessionEvents([{ kind: 'turnDone', status: 'interrupted' }]);
    const block = stopped.blocks[0] as Extract<ChatBlock, { type: 'error' }>;
    expect(block.text).toBe('Stopped.');
    expect(block.tone).toBe('warn');
  });

  it('tones a rate limit as a warning, not an error', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'rateLimit', message: 'slow down', resetsAt: '10:00' },
    ]);
    const block = blocks[0] as Extract<ChatBlock, { type: 'error' }>;
    expect(block.tone).toBe('warn');
    expect(block.text).toContain('resets 10:00');
  });

  it('ends the session with a divider and says so on the state', () => {
    const { blocks, ended } = foldSessionEvents([{ kind: 'exited', code: 0 }]);
    expect(types(blocks)).toEqual(['divider']);
    expect((blocks[0] as Extract<ChatBlock, { type: 'divider' }>).label).toBe('Session ended');
    expect(ended).toBe(true);
  });

  it('names dropped history rather than hiding the hole', () => {
    const { blocks } = foldSessionEvents([{ kind: 'truncated', dropped: 9 }]);
    expect((blocks[0] as Extract<ChatBlock, { type: 'divider' }>).label).toBe(
      '9 older events dropped',
    );
  });
});

describe('foldSessionEvents — day dividers use REAL time only', () => {
  const day1 = Date.parse('2026-03-01T23:50:00.000Z');
  const day2 = Date.parse('2026-03-02T00:10:00.000Z');

  it('draws a divider when a real date changes', () => {
    const { blocks } = foldSessionEvents(
      [
        { kind: 'assistantMessage', text: 'late' },
        { kind: 'assistantMessage', text: 'early' },
      ],
      { receivedAt: [day1, day2] },
    );
    expect(types(blocks)).toEqual(['assistantProse', 'divider', 'assistantProse']);
    expect((blocks[1] as Extract<ChatBlock, { type: 'divider' }>).label).toBe('Monday, March 2');
  });

  it('never draws one before the first block', () => {
    const { blocks } = foldSessionEvents([{ kind: 'assistantMessage', text: 'hi' }], {
      receivedAt: [day1],
    });
    expect(types(blocks)).toEqual(['assistantProse']);
  });

  it('draws none for replayed events, which have no honest time', () => {
    // The regression this pins: the old fold synthesized `startedAt + index`,
    // which put every replayed transcript under a fabricated
    // "Thursday, January 1" divider.
    const { blocks } = foldSessionEvents(
      [
        { kind: 'assistantMessage', text: 'a' },
        { kind: 'assistantMessage', text: 'b' },
      ],
      { receivedAt: [null, null] },
    );
    expect(types(blocks)).toEqual(['assistantProse', 'assistantProse']);
    expect(blocks.every((block) => block.at === null)).toBe(true);
  });

  it('treats a missing receivedAt entry as unknown, not as now', () => {
    const { blocks } = foldSessionEvents([{ kind: 'assistantMessage', text: 'a' }]);
    expect(blocks[0]!.at).toBeNull();
  });
});
