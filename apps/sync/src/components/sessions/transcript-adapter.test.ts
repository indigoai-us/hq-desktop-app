import { describe, expect, it } from 'vitest';

import {
  FOLD_ERRORS_BLOCK_ID,
  AUTHENTICATION_FAILED_CODE,
  AUTHENTICATION_FAILED_TEXT,
  MODEL_NOT_FOUND_CODE,
  MODEL_NOT_FOUND_TEXT,
  SESSION_AGENT_UID,
  SESSION_MEMBERS,
  SESSION_SELF_UID,
  describeToolInput,
  emptyTranscript,
  foldErrorLabel,
  foldSessionEvents,
  isModelNotFoundText,
  toolArtifactPaths,
  toolCategory,
  toolGroupSummary,
  type ChatBlock,
  type ToolCallSummary,
  type UserTurn,
} from './transcript-adapter';
import {
  CONTENT_TEXT_CAP,
  SESSION_EVENT_KINDS,
  contentToText,
  type SessionEvent,
} from './session-events';

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
      foldErrors: [],
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

  it('does not duplicate a toolCall that is re-announced under the same id', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'toolCall', id: 'a', name: 'bash', input: { command: 'ls' } },
      { kind: 'toolCall', id: 'a', name: 'bash', input: { command: 'ls' } },
      { kind: 'toolResult', id: 'a', isError: false, content: 'ok' },
    ]);
    expect(groups(blocks)[0]!.calls).toHaveLength(1);
    expect(groups(blocks)[0]!.running).toBe(false);
    expect(groups(blocks)[0]!.calls[0]!.status).toBe('ok');
  });

  it('settles leftover running calls when the turn ends without results', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'toolCall', id: 'a', name: 'read_file', input: { target_file: '/x.ts' } },
      { kind: 'toolCall', id: 'b', name: 'grep', input: { pattern: 'foo' } },
      { kind: 'turnDone', status: 'success' },
    ]);
    const group = groups(blocks)[0]!;
    expect(group.running).toBe(false);
    expect(group.calls.map((c) => c.status)).toEqual(['ok', 'ok']);
    expect(group.summary).toBe('Read 1 file · searched 1 time');
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

  it('reconstructs an atomic first message from replay without optimistic metadata', () => {
    const { blocks } = foldSessionEvents([
      {
        kind: 'userMessage',
        text: '/startwork indigo\n\n/indigo:html-deck hello world deck',
        imageCount: 0,
      },
    ]);
    expect(types(blocks)).toEqual(['divider', 'userBubble']);
    expect(blocks[0]).toMatchObject({ label: '/startwork indigo' });
    expect(blocks[1]).toMatchObject({ text: '/indigo:html-deck hello world deck' });
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

  it('offers sign-in again on an authentication_failed error', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'userMessage', text: 'hello', imageCount: 0 },
      {
        kind: 'error',
        message: 'Authentication failed — sign in to Claude again.',
        code: 'authentication_failed',
      },
    ]);
    expect(errors(blocks)[0]?.action).toBe('reauth');
    expect(errors(blocks)[0]?.code).toBe(AUTHENTICATION_FAILED_CODE);
    expect(errors(blocks)[0]?.text).toBe(AUTHENTICATION_FAILED_TEXT);
  });

  it('folds the 401 prose, error event, and turnDone into one sign-in card', () => {
    const { blocks } = foldSessionEvents([
      { kind: 'userMessage', text: 'hello', imageCount: 0 },
      {
        kind: 'assistantMessage',
        text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      },
      {
        kind: 'error',
        message: 'Authentication failed — sign in to Claude again.',
        code: AUTHENTICATION_FAILED_CODE,
      },
      {
        kind: 'turnDone',
        status: 'error',
        error: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      },
    ]);
    expect(types(blocks)).toEqual(['userBubble', 'error']);
    expect(errors(blocks)).toHaveLength(1);
    expect(errors(blocks)[0]?.action).toBe('reauth');
    expect(proseText(blocks)).toEqual([]);
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

// ---------------------------------------------------------------------------
// Hostile payloads — the wire is not the types
// ---------------------------------------------------------------------------

/** An event whose `text` cannot even be READ — the most hostile payload there is. */
function eventWithThrowingText(kind: 'textDelta' | 'assistantMessage'): SessionEvent {
  const event = { kind } as unknown as SessionEvent;
  Object.defineProperty(event, 'text', {
    enumerable: true,
    get() {
      throw new Error('payload exploded');
    },
  });
  return event;
}

/** A tool group's expanded rows, for the outcome assertions. */
function calls(blocks: ChatBlock[]): ToolCallSummary[] {
  return groups(blocks).flatMap((group) => group.calls);
}

describe('contentToText', () => {
  it('reads null and undefined as nothing', () => {
    expect(contentToText(null)).toBe('');
    expect(contentToText(undefined)).toBe('');
  });

  it('returns a string verbatim', () => {
    expect(contentToText('a\nb')).toBe('a\nb');
    expect(contentToText('')).toBe('');
  });

  it('joins Claude text blocks — the shape a real tool_result carries', () => {
    expect(
      contentToText([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
    expect(contentToText(['plain', { type: 'text', text: 'block' }])).toBe('plain\nblock');
  });

  it('renders any other array or object as compact JSON', () => {
    expect(contentToText({ ok: true })).toBe('{"ok":true}');
    expect(contentToText([{ type: 'image', source: 'x' }])).toBe('[{"type":"image","source":"x"}]');
    expect(contentToText({ changes: [{ path: '/a', kind: 'add' }] })).toBe(
      '{"changes":[{"path":"/a","kind":"add"}]}',
    );
  });

  it('caps a huge payload at 4 KB', () => {
    const huge = { blob: 'x'.repeat(CONTENT_TEXT_CAP * 3) };
    const text = contentToText(huge);
    expect(text.length).toBe(CONTENT_TEXT_CAP + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('stringifies scalars and survives a payload JSON cannot serialize', () => {
    expect(contentToText(42)).toBe('42');
    expect(contentToText(false)).toBe('false');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => contentToText(cyclic)).not.toThrow();
    expect(contentToText(cyclic)).toBe('[object Object]');
  });
});

describe('foldSessionEvents — a null or non-string payload never crashes the window', () => {
  // The owner's most recent session opened to a blank window with
  // `null is not an object (evaluating 'content.split')`: a `toolResult` whose
  // `content` was JSON null. Every shape the Rust `Value` can take is folded
  // here, and every one renders.
  const call: SessionEvent = { kind: 'toolCall', id: 'c1', name: 'Bash', input: { command: 'ls' } };

  it('folds a toolResult whose content is null as a call with no outcome', () => {
    const state = foldSessionEvents([
      { kind: 'userMessage', text: 'run it', imageCount: 0 },
      call,
      { kind: 'toolResult', id: 'c1', isError: false, content: null },
      { kind: 'assistantMessage', text: 'done' },
    ]);
    expect(types(state.blocks)).toEqual(['userBubble', 'toolGroup', 'assistantProse']);
    expect(calls(state.blocks)).toEqual([
      expect.objectContaining({ id: 'c1', status: 'ok', outcome: '' }),
    ]);
    expect(state.foldErrors).toEqual([]);
  });

  it('folds Claude content blocks into the outcome text', () => {
    const state = foldSessionEvents([
      call,
      {
        kind: 'toolResult',
        id: 'c1',
        isError: false,
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      },
    ]);
    expect(calls(state.blocks)[0]!.outcome).toBe('a\nb');
    expect(state.foldErrors).toEqual([]);
  });

  it('folds an object result (a Codex fileChange) as compact JSON', () => {
    const state = foldSessionEvents([
      call,
      { kind: 'toolResult', id: 'c1', isError: false, content: { ok: true } },
    ]);
    expect(calls(state.blocks)[0]!.outcome).toBe('{"ok":true}');
    expect(state.foldErrors).toEqual([]);
  });

  it('gives an orphaned null-content result a row too', () => {
    const state = foldSessionEvents([
      { kind: 'toolResult', id: 'gone', isError: true, content: null },
    ]);
    expect(calls(state.blocks)).toEqual([
      expect.objectContaining({ id: 'gone', name: 'Tool', status: 'error', outcome: '' }),
    ]);
  });

  it('folds a malformed toolCall — no input, null name — as a "Tool" row', () => {
    const malformed = { kind: 'toolCall', id: 'x1', name: null, input: undefined } as unknown as SessionEvent;
    const state = foldSessionEvents([
      malformed,
      { kind: 'toolResult', id: 'x1', isError: false, content: 'fine' },
      { kind: 'assistantMessage', text: 'after' },
    ]);
    expect(state.foldErrors).toEqual([]);
    expect(calls(state.blocks)).toEqual([
      expect.objectContaining({ id: 'x1', name: 'Tool', detail: '', status: 'ok', outcome: 'fine' }),
    ]);
    expect(proseText(state.blocks)).toEqual(['after']);
  });

  it('folds every string field arriving as null, on every kind, without throwing', () => {
    const nulls = [
      { kind: 'userMessage', text: null, imageCount: null },
      { kind: 'textDelta', text: null, parentToolUseId: null },
      { kind: 'thinkingDelta', text: null },
      { kind: 'assistantMessage', text: null, parentToolUseId: null },
      { kind: 'toolCall', id: null, name: null, input: null, parentToolUseId: null },
      { kind: 'toolResult', id: null, isError: null, content: null, parentToolUseId: null },
      { kind: 'permissionRequest', requestId: null, toolName: null, input: null, suggestions: null },
      { kind: 'questionRequest', requestId: null, questions: null },
      { kind: 'questionRequest', requestId: 'q2', questions: [{ id: null, header: null, text: null, options: null, multiSelect: null }] },
      { kind: 'usage', inputTokens: null, outputTokens: null, costUsd: null, durationMs: null },
      { kind: 'rateLimit', message: null, resetsAt: null },
      { kind: 'hookNotice', hookEvent: null, hookName: null, text: null },
      { kind: 'turnDone', status: 'error', error: null, sessionId: null },
      { kind: 'error', message: null, code: null },
      { kind: 'exited', code: null, signal: null },
      { kind: 'truncated', dropped: null },
    ] as unknown as SessionEvent[];
    const covered = new Set(nulls.map((event) => event.kind));
    expect([...SESSION_EVENT_KINDS].filter((kind) => kind !== 'started' && !covered.has(kind))).toEqual([]);

    let state!: ReturnType<typeof foldSessionEvents>;
    expect(() => {
      state = foldSessionEvents(nulls, { userTurns: [turn({ text: null as unknown as string })] });
    }).not.toThrow();
    expect(state.foldErrors).toEqual([]);
    expect(state.lastUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      durationMs: null,
      label: '0 in · 0 out',
    });
    // The cards still exist, with safe-to-read fields.
    expect(state.pending.map((card) => card.type)).toEqual(['permission', 'question', 'question']);
    const question = state.pending[2];
    expect(question).toMatchObject({ type: 'question', requestId: 'q2' });
    expect((question as Extract<typeof question, { type: 'question' }>).questions).toEqual([
      { id: 'q0', header: '', text: '', options: [], multiSelect: false },
    ]);
  });

  it('keeps permission suggestions a list whatever the wire sent', () => {
    const state = foldSessionEvents([
      { kind: 'permissionRequest', requestId: 'p1', toolName: 'Bash', input: {}, suggestions: { not: 'a list' } },
      { kind: 'permissionRequest', requestId: 'p2', toolName: 'Bash', input: {}, suggestions: [{ type: 'addRules' }, null, 'x'] },
    ]);
    const cards = state.blocks.filter(
      (block): block is Extract<ChatBlock, { type: 'permissionCard' }> => block.type === 'permissionCard',
    );
    expect(cards.map((card) => card.suggestions)).toEqual([[], [{ type: 'addRules' }]]);
  });
});

describe('foldSessionEvents — an event that still throws is one quiet line, not a crash', () => {
  const before: SessionEvent = { kind: 'assistantMessage', text: 'before' };
  const after: SessionEvent = { kind: 'assistantMessage', text: 'after' };

  it('records the failure and renders the rest of the transcript', () => {
    let state!: ReturnType<typeof foldSessionEvents>;
    expect(() => {
      state = foldSessionEvents([before, eventWithThrowingText('textDelta'), after]);
    }).not.toThrow();

    expect(state.foldErrors).toEqual([{ index: 1, kind: 'textDelta', error: 'payload exploded' }]);
    expect(proseText(state.blocks)).toEqual(['before', 'after']);
    const line = state.blocks[state.blocks.length - 1]!;
    expect(line).toEqual({
      type: 'divider',
      id: FOLD_ERRORS_BLOCK_ID,
      label: '1 event could not be displayed (textDelta)',
      at: null,
    });
  });

  it('says it ONCE for several failures, naming each kind', () => {
    const state = foldSessionEvents([
      eventWithThrowingText('textDelta'),
      before,
      eventWithThrowingText('assistantMessage'),
      eventWithThrowingText('textDelta'),
      after,
    ]);
    expect(state.foldErrors.map((error) => [error.index, error.kind])).toEqual([
      [0, 'textDelta'],
      [2, 'assistantMessage'],
      [3, 'textDelta'],
    ]);
    expect(proseText(state.blocks)).toEqual(['before', 'after']);
    const lines = state.blocks.filter((block) => block.id === FOLD_ERRORS_BLOCK_ID);
    expect(lines).toHaveLength(1);
    expect((lines[0] as Extract<ChatBlock, { type: 'divider' }>).label).toBe(
      '3 events could not be displayed (textDelta, assistantMessage)',
    );
  });

  it('survives an event that is not even an object', () => {
    const garbage = [null, undefined, 42, 'text', { kind: 'nonsense' }] as unknown as SessionEvent[];
    let state!: ReturnType<typeof foldSessionEvents>;
    expect(() => {
      state = foldSessionEvents([before, ...garbage, after]);
    }).not.toThrow();
    // An unknown kind is simply not a row; a non-object is a recorded error.
    expect(proseText(state.blocks)).toEqual(['before', 'after']);
    expect(state.foldErrors.every((error) => typeof error.error === 'string')).toBe(true);
  });

  it('labels the line grammatically', () => {
    expect(foldErrorLabel([{ index: 0, kind: 'toolResult', error: 'x' }])).toBe(
      '1 event could not be displayed (toolResult)',
    );
    expect(
      foldErrorLabel([
        { index: 0, kind: 'toolResult', error: 'x' },
        { index: 4, kind: 'toolResult', error: 'y' },
      ]),
    ).toBe('2 events could not be displayed (toolResult)');
  });
});
