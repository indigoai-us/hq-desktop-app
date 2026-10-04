import { describe, expect, it } from 'vitest';

import { DM_STATUS_APPLY_MIN_INTERVAL_MS, createStatusCoalescer } from './agent-thinking.js';

/**
 * B-11: nothing bounded how often a bot's DM statuses were applied. Each one
 * is a reactive write that redraws the thinking row. They are now applied at
 * most once a second per bot, always the newest.
 */

/** A clock and timers the test moves by hand. */
function harness() {
  let now = 10_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const applied: Array<{ key: string; value: string; at: number }> = [];
  return {
    applied,
    timers,
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    apply: (key: string, value: string) => void applied.push({ key, value, at: now }),
    /** Move the clock, firing timers that come due, in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

describe('createStatusCoalescer', () => {
  it('applies the first value at once', () => {
    const h = harness();
    const c = createStatusCoalescer<string>({ apply: h.apply, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    c.push('agt_nova', 'Working');
    expect(h.applied).toEqual([{ key: 'agt_nova', value: 'Working', at: 10_000 }]);
    expect(h.timers.size).toBe(0);
  });

  it('a burst costs one apply a second, and the newest value is the one applied', () => {
    expect(DM_STATUS_APPLY_MIN_INTERVAL_MS).toBe(1_000);
    const h = harness();
    const c = createStatusCoalescer<string>({ apply: h.apply, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    // Ninety-nine statuses in 990 ms.
    for (let i = 0; i < 99; i += 1) {
      c.push('agt_nova', `s${i}`);
      h.advance(10);
    }
    expect(h.applied.map((a) => a.value)).toEqual(['s0']);
    expect(h.timers.size).toBe(1);
    h.advance(10);
    expect(h.applied).toEqual([
      { key: 'agt_nova', value: 's0', at: 10_000 },
      { key: 'agt_nova', value: 's98', at: 11_000 },
    ]);
    // A steady stream for ten seconds: about ten applies, never a hundred a second.
    for (let i = 0; i < 1_000; i += 1) {
      c.push('agt_nova', `t${i}`);
      h.advance(10);
    }
    h.advance(1_000);
    expect(h.applied.length).toBeGreaterThanOrEqual(11);
    expect(h.applied.length).toBeLessThanOrEqual(13);
    expect(h.applied.at(-1)!.value).toBe('t999');
    for (let i = 1; i < h.applied.length; i += 1) {
      expect(h.applied[i]!.at - h.applied[i - 1]!.at).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('a value a second or more after the last apply is applied at once', () => {
    const h = harness();
    const c = createStatusCoalescer<string>({ apply: h.apply, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    c.push('agt_nova', 'a');
    h.advance(20_000);
    c.push('agt_nova', 'b');
    expect(h.applied.map((a) => [a.value, a.at])).toEqual([['a', 10_000], ['b', 30_000]]);
    h.advance(1_000);
    c.push('agt_nova', 'c');
    expect(h.applied.at(-1)).toEqual({ key: 'agt_nova', value: 'c', at: 31_000 });
  });

  it('counts each bot by itself', () => {
    const h = harness();
    const c = createStatusCoalescer<string>({ apply: h.apply, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    c.push('agt_nova', 'n1');
    c.push('agt_polar', 'p1');
    c.push('agt_nova', 'n2');
    c.push('agt_polar', 'p2');
    expect(h.applied.map((a) => a.value)).toEqual(['n1', 'p1']);
    h.advance(1_000);
    expect(h.applied.map((a) => a.value).sort()).toEqual(['n1', 'n2', 'p1', 'p2']);
  });

  it('keeps the newer of two held values by the rule it is given', () => {
    const h = harness();
    const c = createStatusCoalescer<{ at: number; text: string }>({
      apply: (key, value) => h.apply(key, value.text),
      newer: (candidate, held) => candidate.at >= held.at,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    c.push('agt_nova', { at: 1, text: 'first' });
    // Out of order: the one created later is kept, whichever arrives last.
    c.push('agt_nova', { at: 5, text: 'created later' });
    c.push('agt_nova', { at: 3, text: 'created earlier, arrived last' });
    h.advance(1_000);
    expect(h.applied.map((a) => a.value)).toEqual(['first', 'created later']);
  });

  it('applies nothing after it is disposed, and cancels its timers', () => {
    const h = harness();
    const c = createStatusCoalescer<string>({ apply: h.apply, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    c.push('agt_nova', 'a');
    c.push('agt_nova', 'b');
    expect(h.timers.size).toBe(1);
    c.dispose();
    expect(h.timers.size).toBe(0);
    h.advance(5_000);
    c.push('agt_nova', 'c');
    expect(h.applied.map((a) => a.value)).toEqual(['a']);
  });

  it('does not keep state for every bot it ever saw', () => {
    const h = harness();
    const c = createStatusCoalescer<string>({ apply: h.apply, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    for (let i = 0; i < 1_000; i += 1) {
      c.push(`agt_${i}`, 'x');
      h.advance(50);
    }
    expect(h.applied).toHaveLength(1_000);
    // Still correct for a bot seen long ago.
    c.push('agt_0', 'again');
    expect(h.applied.at(-1)!.value).toBe('again');
  });
});
