import { describe, expect, it } from 'vitest';

import {
  MODEL_NOT_FOUND_CODE,
  MODEL_NOT_FOUND_TEXT,
  SESSION_AGENT_UID,
  SESSION_MEMBERS,
  SESSION_SELF_UID,
  describeToolInput,
  emptyTranscript,
  foldSessionEvents,
  isModelNotFoundText,
  toolArtifactPaths,
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
      policies: { company: null, entries: [] },
      checkpointDue: false,
      checkpointPrompts: 0,
      handoff: 'none',
    });
    expect(foldSessionEvents([])).toEqual(emptyTranscript());
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
    { kind: 'userMessage', text: 'do the thing', imageCount: 0 },
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
    {
      kind: 'hookNotice',
      hookEvent: 'SessionStart',
      hookName: 'SessionStart:startup',
      text: '> Policy `x` applies here: y',
    },
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
  it('renders a backend userMessage as a bubble', () => {
    // The backend records the operator's turn as it writes it to the CLI, so a
    // replayed transcript is a conversation rather than the agent's half of one.
    expect([...SESSION_EVENT_KINDS]).toContain('userMessage');

    const { blocks } = foldSessionEvents([
      { kind: 'userMessage', text: 'do the thing', imageCount: 2 },
      { kind: 'assistantMessage', text: 'on it' },
    ]);
    expect(types(blocks)).toEqual(['userBubble', 'assistantProse']);
    expect((blocks[0] as Extract<ChatBlock, { type: 'userBubble' }>).text).toBe('do the thing');
  });

  it('dates a backend userMessage by when it was received', () => {
    const at = Date.parse('2026-09-02T14:00:00.000Z');
    const { blocks } = foldSessionEvents(
      [{ kind: 'userMessage', text: 'do the thing', imageCount: 0 }],
      { receivedAt: [at] },
    );
    expect(blocks[0]!.at).toBe(at);
  });

  it('closes the agent’s open prose, group and thought at a backend turn', () => {
    // A user turn is the hardest boundary in the transcript — whatever the
    // agent had open before it belongs to the previous exchange.
    const { blocks } = foldSessionEvents([
      { kind: 'thinkingDelta', text: 'hmm' },
      { kind: 'textDelta', text: 'partly said' },
      { kind: 'userMessage', text: 'actually, stop', imageCount: 0 },
      { kind: 'textDelta', text: 'ok' },
    ]);
    expect(types(blocks)).toEqual(['assistantProse', 'userBubble', 'assistantProse']);
    expect(proseText(blocks)).toEqual(['partly said', 'ok']);
  });

  it('mirrors a sent turn as a bubble, for the moment before the backend echoes it', () => {
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

describe('foldSessionEvents — hook notices are state, never rows', () => {
  const notice = (text: string): SessionEvent => ({
    kind: 'hookNotice',
    hookEvent: 'SessionStart',
    hookName: 'SessionStart:startup',
    text,
  });
  const POLICIES =
    '<policy-reminder>\n> Policy `hq-git-discipline` (HARD — binding rule from `core/policies/hq-git-discipline.md`):\n> Anchor every git mutation.\n> Policy `quiet-by-default-narration` applies here: Quiet by default.\n</policy-reminder>\n';
  const BIND = '<company-policy-digest co="indigo">\n- [hard] **indigo-only**: Keep it in indigo. Full text: `x.md`.\n</company-policy-digest>\n';

  it('produces no block and fills `policies`', () => {
    const state = foldSessionEvents([started, notice(POLICIES)]);
    expect(state.blocks).toEqual([]);
    expect(state.policies).toEqual({
      company: null,
      entries: [
        { slug: 'hq-git-discipline', hard: true, excerpt: 'Anchor every git mutation.' },
        { slug: 'quiet-by-default-narration', hard: false, excerpt: 'Quiet by default.' },
      ],
    });
  });

  it('accumulates across notices, dedupes by slug, and takes the latest company', () => {
    const state = foldSessionEvents([
      notice(POLICIES),
      { kind: 'textDelta', text: 'hi' },
      notice(POLICIES),
      notice(BIND),
    ]);
    expect(types(state.blocks)).toEqual(['assistantProse']);
    expect(state.policies.company).toBe('indigo');
    expect(state.policies.entries.map((e) => e.slug)).toEqual([
      'hq-git-discipline',
      'quiet-by-default-narration',
      'indigo-only',
    ]);
    expect(state.policies.entries.filter((e) => e.hard)).toHaveLength(2);
  });

  it('does not interrupt an open prose row or tool group', () => {
    const state = foldSessionEvents([
      { kind: 'textDelta', text: 'a' },
      notice('<journal-index>\nnothing to see\n</journal-index>'),
      { kind: 'textDelta', text: 'b' },
    ]);
    expect(proseText(state.blocks)).toEqual(['ab']);
    expect(state.policies).toEqual({ company: null, entries: [] });
  });

  it('raises the checkpoint prompt on the AUTO-CHECKPOINT banner and clears it on /checkpoint', () => {
    const banner = notice('║  AUTO-CHECKPOINT REQUIRED — context ~50%  ║');
    const raised = foldSessionEvents([started, banner]);
    expect(raised.blocks).toEqual([]);
    expect(raised.checkpointDue).toBe(true);
    expect(raised.checkpointPrompts).toBe(1);

    // A mirrored `/checkpoint` turn answers it.
    const answered = foldSessionEvents([started, banner], {
      userTurns: [turn({ text: '/checkpoint', atIndex: 2 })],
    });
    expect(answered.checkpointDue).toBe(false);
    expect(answered.checkpointPrompts).toBe(1);

    // So does the backend's own record of that turn; a second banner later
    // (the precompact one) raises it again with a higher count.
    const again = foldSessionEvents([
      started,
      banner,
      { kind: 'userMessage', text: '/checkpoint', imageCount: 0 },
      { kind: 'turnDone', status: 'success' },
      notice('AUTO-CHECKPOINT REQUIRED — precompact backup'),
    ]);
    expect(again.checkpointDue).toBe(true);
    expect(again.checkpointPrompts).toBe(2);
    // An ordinary message does not answer a checkpoint prompt.
    const ignored = foldSessionEvents([banner, { kind: 'userMessage', text: 'carry on', imageCount: 0 }]);
    expect(ignored.checkpointDue).toBe(true);
  });
});

describe('foldSessionEvents — the /handoff turn', () => {
  it('is running from the mirrored turn until turnDone, then leaves a divider', () => {
    const running = foldSessionEvents([started, { kind: 'textDelta', text: 'Writing…' }], {
      userTurns: [turn({ text: '/handoff', atIndex: 1 })],
    });
    expect(running.handoff).toBe('running');
    expect(types(running.blocks)).toEqual(['userBubble', 'assistantProse']);

    const done = foldSessionEvents(
      [
        started,
        { kind: 'assistantMessage', text: 'Handoff written to workspace/threads/handoff.json.' },
        { kind: 'turnDone', status: 'success' },
      ],
      { userTurns: [turn({ text: '/handoff', atIndex: 1 })] },
    );
    expect(done.handoff).toBe('done');
    expect(types(done.blocks)).toEqual(['userBubble', 'assistantProse', 'divider']);
    expect((done.blocks[2] as Extract<ChatBlock, { type: 'divider' }>).label).toBe(
      'Session handed off',
    );
  });

  it('reads the backend-recorded turn the same way, and a failed turn is not a handoff', () => {
    const recorded = foldSessionEvents([
      { kind: 'userMessage', text: '/handoff', imageCount: 0 },
      { kind: 'turnDone', status: 'success' },
    ]);
    expect(recorded.handoff).toBe('done');
    expect(types(recorded.blocks)).toEqual(['userBubble', 'divider']);

    const failed = foldSessionEvents([
      { kind: 'userMessage', text: '/handoff', imageCount: 0 },
      { kind: 'turnDone', status: 'error', error: 'nope' },
    ]);
    expect(failed.handoff).toBe('none');
    expect(types(failed.blocks)).toEqual(['userBubble', 'error']);

    // Only a real /handoff counts; an ordinary turn ending says nothing.
    const plain = foldSessionEvents([
      { kind: 'userMessage', text: 'ship it', imageCount: 0 },
      { kind: 'turnDone', status: 'success' },
    ]);
    expect(plain.handoff).toBe('none');
    expect(types(plain.blocks)).toEqual(['userBubble']);
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

describe('usage without a dollar cost (Codex)', () => {
  it('folds a usage event whose costUsd/durationMs are null without throwing', () => {
    const events: SessionEvent[] = [
      { kind: 'started', sessionId: 's', tool: 'codex', model: 'gpt-5.6', cwd: '/hq', tools: [], commands: [] },
      { kind: 'textDelta', text: 'hello' },
      { kind: 'assistantMessage', text: 'hello' },
      { kind: 'usage', inputTokens: 10, outputTokens: 5, costUsd: null, durationMs: null } as SessionEvent,
      { kind: 'turnDone', status: 'success' },
    ];
    const state = foldSessionEvents(events);
    expect(state.lastUsage?.label).toBe('10 in · 5 out');
    expect(state.blocks.some((b) => b.type === 'assistantProse')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Artifacts — the files a turn produced
// ---------------------------------------------------------------------------

describe('toolArtifactPaths', () => {
  it("reads Claude's file tools by their file_path", () => {
    expect(toolArtifactPaths('Write', { file_path: '/hq/out/report.md', content: '#' })).toEqual([
      '/hq/out/report.md',
    ]);
    expect(toolArtifactPaths('Edit', { file_path: '/hq/a.ts', old_string: 'a' })).toEqual([
      '/hq/a.ts',
    ]);
    expect(toolArtifactPaths('MultiEdit', { file_path: '/hq/b.ts', edits: [] })).toEqual([
      '/hq/b.ts',
    ]);
    expect(toolArtifactPaths('NotebookEdit', { notebook_path: '/hq/n.ipynb' })).toEqual([
      '/hq/n.ipynb',
    ]);
  });

  it("reads Codex fileChange items by their changes[].path, skipping deletes", () => {
    expect(toolArtifactPaths('Write', { changes: [{ path: '/hq/new.md', kind: 'add' }] })).toEqual([
      '/hq/new.md',
    ]);
    expect(
      toolArtifactPaths('ApplyPatch', {
        changes: [
          { path: '/hq/a.rs', kind: 'update' },
          { path: '/hq/gone.rs', kind: 'delete' },
          { path: '/hq/b.rs', kind: 'add' },
          { path: '/hq/a.rs', kind: 'update' },
        ],
      }),
    ).toEqual(['/hq/a.rs', '/hq/b.rs']);
  });

  it('ignores tools that are not file tools, even when their input names a path', () => {
    expect(toolArtifactPaths('Read', { file_path: '/hq/a.md' })).toEqual([]);
    expect(toolArtifactPaths('Bash', { command: 'echo hi > /hq/out.txt' })).toEqual([]);
    expect(toolArtifactPaths('Glob', { pattern: '**/*.md', path: '/hq' })).toEqual([]);
  });

  it('ignores relative and malformed paths', () => {
    expect(toolArtifactPaths('Write', { file_path: 'relative/out.md' })).toEqual([]);
    expect(toolArtifactPaths('Write', { file_path: 42 })).toEqual([]);
    expect(toolArtifactPaths('Write', 'a string')).toEqual([]);
    expect(toolArtifactPaths('Write', null)).toEqual([]);
    expect(toolArtifactPaths('ApplyPatch', { changes: [null, 'x', { kind: 'add' }] })).toEqual([]);
  });

  it('accepts Windows drive-letter paths', () => {
    expect(toolArtifactPaths('Write', { file_path: 'C:\\hq\\out.md' })).toEqual(['C:\\hq\\out.md']);
  });
});

describe('foldSessionEvents · artifacts', () => {
  const write = (id: string, path: string): SessionEvent => ({
    kind: 'toolCall',
    id,
    name: 'Write',
    input: { file_path: path, content: '' },
  });
  const done = (id: string, isError = false): SessionEvent => ({
    kind: 'toolResult',
    id,
    isError,
    content: isError ? 'nope' : 'ok',
  });

  it('lists each produced file once, by path, on the tool group', () => {
    const events: SessionEvent[] = [
      started,
      write('w1', '/hq/companies/indigo/report.md'),
      done('w1'),
      { kind: 'toolCall', id: 'e1', name: 'Edit', input: { file_path: '/hq/companies/indigo/report.md' } },
      done('e1'),
      write('w2', '/hq/workspace/site/index.html'),
      done('w2'),
      { kind: 'toolCall', id: 'r1', name: 'Read', input: { file_path: '/hq/README.md' } },
      done('r1'),
    ];
    const [group] = groups(foldSessionEvents(events).blocks);
    expect(group?.artifacts).toEqual([
      { path: '/hq/companies/indigo/report.md', name: 'report.md', kind: 'file' },
      { path: '/hq/workspace/site/index.html', name: 'index.html', kind: 'file' },
    ]);
    expect(group?.calls.map((c) => c.artifactPath)).toEqual([
      '/hq/companies/indigo/report.md',
      '/hq/companies/indigo/report.md',
      '/hq/workspace/site/index.html',
      undefined,
    ]);
  });

  it('counts a Codex multi-file patch in full', () => {
    const events: SessionEvent[] = [
      started,
      {
        kind: 'toolCall',
        id: 'p1',
        name: 'ApplyPatch',
        input: { changes: [{ path: '/hq/a.md', kind: 'add' }, { path: '/hq/b.md', kind: 'update' }] },
      },
      done('p1'),
    ];
    const [group] = groups(foldSessionEvents(events).blocks);
    expect(group?.artifacts.map((a) => a.path)).toEqual(['/hq/a.md', '/hq/b.md']);
    expect(group?.calls[0]?.artifactPath).toBe('/hq/a.md');
  });

  it('drops a file whose write failed or has not finished', () => {
    const events: SessionEvent[] = [
      started,
      write('w1', '/hq/failed.md'),
      done('w1', true),
      write('w2', '/hq/pending.md'),
    ];
    const [group] = groups(foldSessionEvents(events).blocks);
    expect(group?.artifacts).toEqual([]);
    expect(group?.running).toBe(true);
  });

  it('keeps artifacts with the group they were produced in', () => {
    const events: SessionEvent[] = [
      started,
      write('w1', '/hq/first.md'),
      done('w1'),
      { kind: 'assistantMessage', text: 'One down.' },
      write('w2', '/hq/second.md'),
      done('w2'),
    ];
    const [a, b] = groups(foldSessionEvents(events).blocks);
    expect(a?.artifacts.map((x) => x.name)).toEqual(['first.md']);
    expect(b?.artifacts.map((x) => x.name)).toEqual(['second.md']);
  });

  it('gives a group with no file tools an empty list, never undefined', () => {
    const events: SessionEvent[] = [
      started,
      { kind: 'toolCall', id: 'b1', name: 'Bash', input: { command: 'ls' } },
      done('b1'),
    ];
    const [group] = groups(foldSessionEvents(events).blocks);
    expect(group?.artifacts).toEqual([]);
  });
});

describe('foldSessionEvents — hidden turns and context tags', () => {
  it('renders a hidden mirrored turn as a quiet divider with its label', () => {
    const { blocks } = foldSessionEvents([], {
      userTurns: [
        turn({ id: 'sw', text: '/startwork indigo', hidden: true, label: 'Starting work in indigo · project x' }),
        turn({ id: 'u', text: 'go', atIndex: 0 }),
      ],
    });
    expect(types(blocks)).toEqual(['divider', 'userBubble']);
    expect(blocks[0]).toMatchObject({ id: 'sys-sw', label: 'Starting work in indigo · project x' });
  });

  it('treats a backend-recorded /startwork as hidden too, deriving the label from the text', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'userMessage', text: '/startwork indigo', imageCount: 0 },
      { kind: 'userMessage', text: 'go', imageCount: 0 },
    ]);
    expect(types(blocks)).toEqual(['divider', 'userBubble']);
    expect(blocks[0]).toMatchObject({ label: 'Starting work in indigo' });
  });

  it('prefers the kept meta for a backend turn — the exact label survives the mirror', () => {
    const { blocks } = foldSessionEvents(
      [{ kind: 'userMessage', text: '/startwork sessions', imageCount: 0 }],
      { turnMeta: { '/startwork sessions': { hidden: true, label: 'Starting work in indigo · project sessions' } } },
    );
    expect(blocks[0]).toMatchObject({ type: 'divider', label: 'Starting work in indigo · project sessions' });
  });

  it('strips the context block from a recorded turn and renders it as tags', () => {
    const text =
      'What did we decide?\n\n<hq-context source="meeting" path="companies/indigo/sources/meetings/x.md" title="Weekly sync">\nnotes\n</hq-context>';
    const { blocks } = foldSessionEvents([{ kind: 'userMessage', text, imageCount: 0 }]);
    expect(blocks[0]).toEqual({
      type: 'userBubble',
      id: 'user-ev-0',
      text: 'What did we decide?',
      attachments: [
        { kind: 'meeting', title: 'Weekly sync', path: 'companies/indigo/sources/meetings/x.md' },
      ],
      at: null,
    });
  });

  it('carries a mirrored turn’s attachments onto its bubble', () => {
    const { blocks } = foldSessionEvents([], {
      userTurns: [
        turn({
          text: 'summarise',
          attachments: [{ kind: 'signal', title: 'Ship it', path: '/s.md' }],
        }),
      ],
    });
    expect((blocks[0] as Extract<ChatBlock, { type: 'userBubble' }>).attachments).toEqual([
      { kind: 'signal', title: 'Ship it', path: '/s.md' },
    ]);
  });

  it('a plain turn carries no tags', () => {
    const { blocks } = foldSessionEvents([{ kind: 'userMessage', text: 'hi', imageCount: 0 }]);
    expect((blocks[0] as Extract<ChatBlock, { type: 'userBubble' }>).attachments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// model_not_found — the owner saw the same failure three times per turn
// ---------------------------------------------------------------------------

describe('foldSessionEvents — model_not_found is ONE recoverable line', () => {
  /** The prose the Claude CLI narrates before it errors. */
  const NARRATION =
    "There's an issue with the selected model (gpt-5.6-sol). Please check the model name and try again. (model_not_found)";

  /** Exactly what the wire delivers for one failed turn, in order. */
  const failedTurn: SessionEvent[] = [
    { kind: 'userMessage', text: 'hello', imageCount: 0 },
    { kind: 'textDelta', text: "There's an issue with the selected model (gpt-5.6-sol). " },
    { kind: 'textDelta', text: 'Please check the model name and try again. (model_not_found)' },
    { kind: 'assistantMessage', text: NARRATION },
    { kind: 'error', message: MODEL_NOT_FOUND_TEXT, code: MODEL_NOT_FOUND_CODE },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'turnDone', status: 'error', error: NARRATION },
  ];

  const errors = (blocks: ChatBlock[]) =>
    blocks.filter((block): block is Extract<ChatBlock, { type: 'error' }> => block.type === 'error');

  it('recognises the CLI’s narration of the failure', () => {
    expect(isModelNotFoundText(NARRATION)).toBe(true);
    expect(isModelNotFoundText("There's an issue with the selected model (x)")).toBe(true);
    expect(isModelNotFoundText('model_not_found')).toBe(true);
    expect(isModelNotFoundText('on it')).toBe(false);
    expect(isModelNotFoundText(undefined)).toBe(false);
  });

  it('renders the bubble and ONE red line — no prose, no "Turn failed" echo', () => {
    const { blocks } = foldSessionEvents(failedTurn);
    expect(types(blocks)).toEqual(['userBubble', 'error']);
    const [line] = errors(blocks);
    expect(line?.text).toBe(MODEL_NOT_FOUND_TEXT);
    expect(line?.code).toBe(MODEL_NOT_FOUND_CODE);
    expect(line?.tone).toBe('error');
    expect(proseText(blocks)).toEqual([]);
  });

  it('offers "Choose a model" on that line', () => {
    const { blocks } = foldSessionEvents(failedTurn);
    expect(errors(blocks)[0]?.action).toBe('chooseModel');
  });

  it('withdraws the narration even when only the streamed deltas arrived', () => {
    // Mid-stream: the prose has started, the error has not landed yet.
    const { blocks } = foldSessionEvents(failedTurn.slice(0, 3));
    expect(types(blocks)).toEqual(['userBubble', 'error']);
    expect(errors(blocks)[0]?.action).toBe('chooseModel');
  });

  it('folds the `error` event first when the wire delivers it before the prose', () => {
    const reordered: SessionEvent[] = [
      { kind: 'userMessage', text: 'hello', imageCount: 0 },
      { kind: 'error', message: MODEL_NOT_FOUND_TEXT, code: MODEL_NOT_FOUND_CODE },
      { kind: 'assistantMessage', text: NARRATION },
      { kind: 'turnDone', status: 'error', error: NARRATION },
    ];
    const { blocks } = foldSessionEvents(reordered);
    expect(types(blocks)).toEqual(['userBubble', 'error']);
  });

  it('keeps one line when only the turnDone names the model failure', () => {
    const { blocks } = foldSessionEvents([{ kind: 'turnDone', status: 'error', error: NARRATION }]);
    expect(types(blocks)).toEqual(['error']);
    expect(errors(blocks)[0]?.action).toBe('chooseModel');
    expect(errors(blocks)[0]?.text).toBe(MODEL_NOT_FOUND_TEXT);
  });

  it('is per turn: the next turn’s failure gets its own line', () => {
    const twice = [...failedTurn, ...failedTurn];
    const { blocks } = foldSessionEvents(twice);
    expect(types(blocks)).toEqual(['userBubble', 'error', 'userBubble', 'error']);
  });

  it('leaves ordinary prose in a turn that did not fail on its model alone', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'userMessage', text: 'hello', imageCount: 0 },
      { kind: 'assistantMessage', text: 'on it' },
      { kind: 'turnDone', status: 'success' },
    ]);
    expect(types(blocks)).toEqual(['userBubble', 'assistantProse']);
  });
});

describe('foldSessionEvents — an error said once is said once', () => {
  it('drops a "Turn failed" that repeats the error event’s own message', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'error', message: 'Claude had a server error — try again.', code: 'server_error' },
      { kind: 'turnDone', status: 'error', error: 'Claude had a server error — try again.' },
    ]);
    expect(types(blocks)).toEqual(['error']);
    expect((blocks[0] as Extract<ChatBlock, { type: 'error' }>).text).toBe(
      'Claude had a server error — try again. (server_error)',
    );
  });

  it('keeps a "Turn failed" that says something new', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'error', message: 'first thing', code: 'E1' },
      { kind: 'turnDone', status: 'error', error: 'a different thing' },
    ]);
    expect(types(blocks)).toEqual(['error', 'error']);
    expect((blocks[1] as Extract<ChatBlock, { type: 'error' }>).text).toBe(
      'Turn failed: a different thing.',
    );
  });

  it('carries the CLI’s code on the block', () => {
    const { blocks } = foldSessionEvents([{ kind: 'error', message: 'boom', code: 'E1' }]);
    expect((blocks[0] as Extract<ChatBlock, { type: 'error' }>).code).toBe('E1');
  });
});
