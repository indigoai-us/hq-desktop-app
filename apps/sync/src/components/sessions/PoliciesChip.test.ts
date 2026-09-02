// @vitest-environment happy-dom
/**
 * The policies chip and the strip's handoff button, mounted for real.
 *
 * What these pin are DOM facts — the chip hides until a policy lands, its
 * label carries the counts, the popover groups Hard / Advisory under the bound
 * company, and the handoff button is only clickable on an idle live session —
 * so they are asserted against rendered components rather than source strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import PoliciesChip from './PoliciesChip.svelte';
import SessionsStrip from './SessionsStrip.svelte';
import { emptyPolicyDigest, parsePolicyDigest, type PolicyDigest } from './policy-digest';

const DIGEST: PolicyDigest = parsePolicyDigest(
  [
    '<policy-reminder>',
    '> Policy `hq-git-discipline` (HARD — binding rule from `core/policies/hq-git-discipline.md`):',
    '> Anchor every git mutation.',
    '> Policy `quiet-by-default-narration` applies here: Quiet by default.',
    '> Policy `image-context-isolation` applies here: Delegate image reads.',
    '</policy-reminder>',
    '<company-policy-digest co="indigo">',
    '</company-policy-digest>',
  ].join('\n'),
);

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

/**
 * Mount fresh. Props handed to `mount()` are plain values, not runes, so a
 * later assignment would not reach the component — every state under test is
 * therefore a remount, which is also what the page does on a session change.
 */
function mountChip(digest: PolicyDigest) {
  if (component) unmount(component);
  component = mount(PoliciesChip, { target: host, props: { digest } }) as Record<string, unknown>;
  flushSync();
}

function mountStrip(props: Record<string, unknown>) {
  if (component) unmount(component);
  component = mount(SessionsStrip, {
    target: host,
    props: { title: 'indigo · Opus', ...props },
  }) as Record<string, unknown>;
  flushSync();
}

const at = (testid: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${testid}"]`);

const must = (testid: string): HTMLElement => {
  const found = at(testid);
  if (!found) throw new Error(`missing [data-testid="${testid}"]`);
  return found;
};

const click = (element: HTMLElement) => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  flushSync();
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
});

describe('PoliciesChip', () => {
  it('stays hidden until a hook has surfaced a policy or bound a company', () => {
    mountChip(emptyPolicyDigest());
    expect(at('session-policies')).toBeNull();

    mountChip({ company: 'indigo', entries: [] });
    expect(at('session-policies')).not.toBeNull();
    click(must('session-policies-chip'));
    expect(must('session-policies-company').textContent).toContain('indigo');
    expect(must('session-policies-popover').textContent).toContain('No policies surfaced yet.');
  });

  it('labels itself with the total and the hard count', () => {
    mountChip(DIGEST);
    expect(must('session-policies-chip').textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Policies · 3 (1 hard)',
    );
  });

  it('opens a popover grouped Hard / Advisory under the bound company, and closes on Escape', () => {
    mountChip(DIGEST);
    expect(at('session-policies-popover')).toBeNull();

    click(must('session-policies-chip'));
    const popover = must('session-policies-popover');
    expect(must('session-policies-chip').getAttribute('aria-expanded')).toBe('true');
    expect(must('session-policies-company').textContent).toContain('Bound to');
    expect(must('session-policies-company').textContent).toContain('indigo');
    // The company line comes first.
    expect(popover.firstElementChild?.getAttribute('data-testid')).toBe('session-policies-company');

    const hard = must('session-policies-hard');
    expect(hard.querySelectorAll('li')).toHaveLength(1);
    expect(hard.textContent).toContain('hq-git-discipline');
    expect(hard.textContent).toContain('Anchor every git mutation.');

    const advisory = must('session-policies-advisory');
    expect(advisory.querySelectorAll('li')).toHaveLength(2);
    expect(advisory.textContent).toContain('quiet-by-default-narration');
    expect(advisory.textContent).toContain('image-context-isolation');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(at('session-policies-popover')).toBeNull();
  });

  it('closes on a click outside and updates live as more policies fold in', () => {
    mountChip(DIGEST);
    click(must('session-policies-chip'));
    expect(at('session-policies-popover')).not.toBeNull();

    // A click INSIDE the popover keeps it open; one outside closes it.
    click(must('session-policies-hard'));
    expect(at('session-policies-popover')).not.toBeNull();
    click(document.body);
    expect(at('session-policies-popover')).toBeNull();

    mountChip({
      company: 'indigo',
      entries: [...DIGEST.entries, { slug: 'new-rule', hard: true, excerpt: 'Just landed.' }],
    });
    expect(must('session-policies-chip').textContent).toContain('4 (2 hard)');
    click(must('session-policies-chip'));
    expect(must('session-policies-hard').querySelectorAll('li')).toHaveLength(2);
  });
});

describe('SessionsStrip — hand off', () => {
  it('is absent with no session and disabled unless the session is idle', () => {
    mountStrip({ handoff: 'hidden' });
    expect(at('session-handoff')).toBeNull();

    mountStrip({ handoff: 'disabled' });
    const button = must('session-handoff') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-state')).toBe('disabled');

    mountStrip({ handoff: 'ready' });
    expect((must('session-handoff') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the handoff on click only when ready, and shows a spinner while running', () => {
    const onhandoff = vi.fn();
    mountStrip({ handoff: 'ready', onhandoff });
    click(must('session-handoff'));
    expect(onhandoff).toHaveBeenCalledTimes(1);

    // Disabled: the click must not reach the callback.
    mountStrip({ handoff: 'disabled', onhandoff });
    click(must('session-handoff'));
    expect(onhandoff).toHaveBeenCalledTimes(1);

    mountStrip({ handoff: 'running', onhandoff });
    const running = must('session-handoff') as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    expect(running.getAttribute('aria-busy')).toBe('true');
    expect(running.querySelector('.spinner')).not.toBeNull();
    expect(running.textContent).toContain('Handing off…');
  });

  it('mounts the policies chip next to the phase dot only when a digest is given', () => {
    mountStrip({ phaseLabel: 'Idle', phase: 'idle', policies: null });
    expect(at('session-policies')).toBeNull();

    mountStrip({ phaseLabel: 'Idle', phase: 'idle', policies: DIGEST });
    const chip = must('session-policies');
    const phase = must('sessions-phase');
    expect(chip.compareDocumentPosition(phase) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
