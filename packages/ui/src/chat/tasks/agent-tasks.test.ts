import { describe, it, expect } from 'vitest';
import {
  AGENT_TASK_STATUS_LABEL,
  CATEGORY_FAMILY,
  TASK_FAMILIES,
  TASK_POOL_PER_FAMILY,
  agentTaskTone,
  classifyTask,
  hashTaskId,
  taskMark,
  taskMarkAddress,
  taskMarkSvg,
  type AgentTask,
  type AgentTaskStatus,
} from './agent-tasks';

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 't-1', title: 'Repair auth final', status: 'working', ...over,
});

describe('mark catalogue', () => {
  it('is exactly 8 families x 100 variants, all distinct', () => {
    const all = new Set<string>();
    for (const family of TASK_FAMILIES) {
      for (let i = 0; i < TASK_POOL_PER_FAMILY; i++) all.add(taskMarkSvg(family, i, 64));
    }
    expect(TASK_FAMILIES).toHaveLength(8);
    expect(all.size).toBe(800);
  });

  it('is stable — an address always renders the same art', () => {
    expect(taskMarkSvg('bloom', 7)).toBe(taskMarkSvg('bloom', 7));
    expect(taskMarkSvg('bloom', 7)).not.toBe(taskMarkSvg('bloom', 8));
  });

  it('addresses are zero-padded and family-scoped', () => {
    expect(taskMarkAddress('star', 4)).toBe('pool-star-004');
  });

  it('honours the requested size but keeps a fixed viewBox so it scales', () => {
    expect(taskMarkSvg('orbit', 1, 48)).toContain('width="48" height="48"');
    expect(taskMarkSvg('orbit', 1, 16)).toContain('viewBox="0 0 100 100"');
  });

  it('scopes internal ids so two marks can coexist in one document', () => {
    const ids = (svg: string) => (svg.match(/id="([^"]+)"/g) ?? []).map((m) => m.slice(4, -1));
    const a = ids(taskMarkSvg('bloom', 1));
    const b = ids(taskMarkSvg('bloom', 2));
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });

  it('is decorative to assistive tech — the chip label carries the meaning', () => {
    const svg = taskMarkSvg('seed', 3);
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
  });

  it('emits only hsla colours — no hardcoded hex', () => {
    for (const family of TASK_FAMILIES) {
      expect(taskMarkSvg(family, 5)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe('assignment', () => {
  it('takes family from meaning and variant from identity', () => {
    const a = taskMark(task({ id: 'a', title: 'Deploy preview #42' }));
    const b = taskMark(task({ id: 'b', title: 'Ship the release' }));
    expect(a.family).toBe('planet');
    expect(b.family).toBe('planet');   // same category -> same family
    expect(a.index).not.toBe(b.index); // different task -> different variant
  });

  it('gives a task the same mark every time', () => {
    expect(taskMark(task({ id: 'stable' })).svg).toBe(taskMark(task({ id: 'stable' })).svg);
  });

  it('never leaks the raw task id into the markup', () => {
    const id = 't20260903T140556Z-f9466240';
    expect(taskMark(task({ id })).svg).not.toContain(id);
  });

  it('honours an explicit category over the title', () => {
    expect(taskMark(task({ title: 'Deploy preview', category: 'design' })).family).toBe('mandala');
  });

  it('gives unclassifiable work a stable family rather than defaulting', () => {
    const first = taskMark(task({ id: 'zz', title: 'Zzzz something opaque' }));
    const again = taskMark(task({ id: 'zz', title: 'Zzzz something opaque' }));
    expect(first.family).toBe(again.family);
    expect(TASK_FAMILIES).toContain(first.family);
  });

  it('maps every category to a distinct family', () => {
    const families = Object.values(CATEGORY_FAMILY);
    expect(new Set(families).size).toBe(families.length);
  });
});

describe('classification', () => {
  it.each([
    ['Deploy preview #42', 'deploy'],
    ['Repair auth final', 'fix'],
    ['Nightly backfill', 'data'],
    ['Run the migration', 'data'],
    ['Review the PR', 'review'],
    ['Polish the icon', 'design'],
    ['Provision runner', 'infra'],
    ['Add signup form', 'build'],
  ] as const)('routes %s to %s', (title, expected) => {
    expect(classifyTask(title)).toBe(expected);
  });

  // Regression: stems were written as `investigat\b`, which can never match
  // "investigate" — research titles silently fell through to the fallback.
  it.each(['Investigate flake', 'Analyse churn', 'Diagnosing the outage'])(
    'matches the research stem in %s', (title) => {
      expect(classifyTask(title)).toBe('research');
    },
  );

  it('returns null when nothing matches, rather than guessing', () => {
    expect(classifyTask('Zzzz opaque')).toBeNull();
    expect(classifyTask('')).toBeNull();
    expect(classifyTask(null)).toBeNull();
  });
});

describe('status presentation', () => {
  it('labels every status without inventing progress', () => {
    const statuses: AgentTaskStatus[] = ['queued', 'working', 'waiting', 'done', 'failed'];
    for (const status of statuses) {
      expect(AGENT_TASK_STATUS_LABEL[status]).toBeTruthy();
      expect(AGENT_TASK_STATUS_LABEL[status]).not.toMatch(/\d+%|almost|soon/i);
    }
  });

  it('maps statuses onto the v4 tone vocabulary', () => {
    expect(agentTaskTone('done')).toBe('ok');
    expect(agentTaskTone('waiting')).toBe('warn');
    expect(agentTaskTone('failed')).toBe('error');
    expect(agentTaskTone('working')).toBe('unread');
    expect(agentTaskTone('queued')).toBe('idle');
  });
});

describe('hashTaskId', () => {
  it('is stable, unsigned, and spreads', () => {
    expect(hashTaskId('abc')).toBe(hashTaskId('abc'));
    expect(hashTaskId('abc')).toBeGreaterThanOrEqual(0);
    expect(hashTaskId('abc')).not.toBe(hashTaskId('abd'));
    const buckets = new Set(
      Array.from({ length: 200 }, (_, i) => hashTaskId(`task-${i}`) % TASK_POOL_PER_FAMILY),
    );
    expect(buckets.size).toBeGreaterThan(50);
  });
});
