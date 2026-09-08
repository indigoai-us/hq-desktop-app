// @vitest-environment happy-dom
/**
 * The strip's "⋯" session menu, mounted for real.
 *
 * DOM facts: the "Open in …" item is named by the session's tool, the trigger
 * is inert without a live session, each item reports its click and closes,
 * and the menu sits in the strip before "+".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import SessionMenu from './SessionMenu.svelte';
import SessionsStrip from './SessionsStrip.svelte';

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

function mountMenu(props: Record<string, unknown> = {}) {
  if (component) unmount(component);
  component = mount(SessionMenu, { target: host, props }) as Record<string, unknown>;
  flushSync();
}

function mountStrip(props: Record<string, unknown> = {}) {
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

describe('SessionMenu', () => {
  it('names the open item by the session tool', () => {
    mountMenu({ tool: 'claude' });
    click(must('session-menu-trigger'));
    expect(must('session-menu-open-in-app').textContent?.trim()).toBe('Open in Claude Code');

    mountMenu({ tool: 'codex' });
    click(must('session-menu-trigger'));
    expect(must('session-menu-open-in-app').textContent?.trim()).toBe('Open in Codex');
  });

  it('offers share and end beneath it', () => {
    mountMenu({ tool: 'claude' });
    click(must('session-menu-trigger'));
    expect(must('session-menu-popover').getAttribute('role')).toBe('menu');
    expect(must('session-menu-share').textContent?.trim()).toBe('Share to channel…');
    expect(must('session-menu-end').textContent?.trim()).toBe('End session');
    const items = Array.from(host.querySelectorAll('[role="menuitem"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(items).toEqual(['session-menu-open-in-app', 'session-menu-share', 'session-menu-end']);
  });

  it('is inert without a live session', () => {
    mountMenu({ disabled: true });
    const trigger = must('session-menu-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(at('session-menu-popover')).toBeNull();
  });

  it('reports each click through its callback and closes', () => {
    const onopeninapp = vi.fn();
    const onshare = vi.fn();
    const onend = vi.fn();
    mountMenu({ onopeninapp, onshare, onend });

    click(must('session-menu-trigger'));
    click(must('session-menu-open-in-app'));
    expect(onopeninapp).toHaveBeenCalledTimes(1);
    expect(at('session-menu-popover')).toBeNull();

    click(must('session-menu-trigger'));
    click(must('session-menu-share'));
    expect(onshare).toHaveBeenCalledTimes(1);
    expect(at('session-menu-popover')).toBeNull();

    click(must('session-menu-trigger'));
    click(must('session-menu-end'));
    expect(onend).toHaveBeenCalledTimes(1);
    expect(at('session-menu-popover')).toBeNull();
  });

  it('closes on Escape and on a click outside, without firing anything', () => {
    const onshare = vi.fn();
    mountMenu({ onshare });
    click(must('session-menu-trigger'));
    expect(must('session-menu-trigger').getAttribute('aria-expanded')).toBe('true');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(at('session-menu-popover')).toBeNull();

    click(must('session-menu-trigger'));
    click(document.body);
    expect(at('session-menu-popover')).toBeNull();
    expect(onshare).not.toHaveBeenCalled();
  });
});

describe('SessionsStrip hosts the menu', () => {
  it('mounts the menu before "+", disabled until a session is live, with the result line beside it', () => {
    mountStrip();
    const trigger = must('session-menu-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(at('session-menu-result')).toBeNull();

    const onopeninapp = vi.fn();
    mountStrip({ menuEnabled: true, tool: 'codex', menuResult: 'Opened in Terminal', onopeninapp });
    expect((must('session-menu-trigger') as HTMLButtonElement).disabled).toBe(false);
    expect(must('session-menu-result').textContent).toBe('Opened in Terminal');

    const right = must('session-menu').parentElement!;
    const order = Array.from(right.querySelectorAll('[data-testid]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(order.indexOf('session-menu')).toBeLessThan(order.indexOf('sessions-new'));
    expect(order.indexOf('session-menu-result')).toBeLessThan(order.indexOf('session-menu'));

    click(must('session-menu-trigger'));
    expect(must('session-menu-open-in-app').textContent?.trim()).toBe('Open in Codex');
    click(must('session-menu-open-in-app'));
    expect(onopeninapp).toHaveBeenCalledTimes(1);
  });
});
