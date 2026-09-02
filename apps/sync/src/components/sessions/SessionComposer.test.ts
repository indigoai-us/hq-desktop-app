// @vitest-environment happy-dom
/**
 * The composer's SHAPE, mounted for real.
 *
 * The owner's verdict on the previous bar was about layout, not behaviour:
 * controls crammed beside the caret, a model pill that said "Default", and a
 * footer of telemetry. Those are DOM facts, so they are asserted against a
 * rendered component rather than pinned as source strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import SessionComposer from './SessionComposer.svelte';
import { CODEX_EFFORT_OPTIONS, readSessionModels } from './session-models';

/** The exact shape the CLI handshake sends. */
const CATALOG = readSessionModels([
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Use the default model (currently Opus 5 (1M context))',
  },
  {
    value: 'claude-opus-5[1m]',
    displayName: 'Opus',
    description: 'Most capable for your hardest and longest-running tasks. Slower.',
  },
  { value: 'claude-fable-5-1[1m]', displayName: 'Fable' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet' },
]);

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown> = {}) {
  component = mount(SessionComposer, {
    target: host,
    props: { companies: [{ slug: 'absorption-company', displayName: 'absorption-company' }], models: CATALOG, hqFolder: 'HQ', ...props },
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

describe('two rows: text on top, every control underneath', () => {
  it('puts nothing beside the textarea but the ⏎ hint', () => {
    render();
    const textRow = must('session-composer-input').parentElement!;
    expect(textRow.querySelector('[data-testid^="session-pill-"]')).toBeNull();
    expect(textRow.querySelector('[data-testid="session-composer-send"]')).toBeNull();
    expect(textRow.querySelector('[data-testid="session-composer-attach"]')).toBeNull();
  });

  it('carries every control on one row below the text', () => {
    render();
    const controls = must('session-composer-controls');
    for (const testid of [
      'session-pill-permission',
      'session-composer-attach',
      'session-pill-company',
      'session-pill-tool',
      'session-pill-model',
      'session-pill-effort',
      'session-composer-send',
    ]) {
      expect(controls.querySelector(`[data-testid="${testid}"]`), testid).not.toBeNull();
    }
  });

  it('orders the row left-to-right the way the eye reads it', () => {
    render();
    const order = [...must('session-composer-controls').querySelectorAll('[data-testid]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((testid) => testid !== 'session-composer-file');
    expect(order).toEqual([
      'session-pill-permission',
      'session-composer-attach',
      'session-pill-company',
      'session-pill-tool',
      'session-pill-model',
      'session-pill-effort',
      'session-composer-send',
    ]);
  });
});

describe('the footer is the HQ folder and nothing else', () => {
  it('shows the folder', () => {
    render();
    expect(must('session-foot-folder').textContent?.trim()).toBe('HQ');
  });

  it('renders no session id, no token counts, no cost', () => {
    render();
    expect(at('session-foot-id')).toBeNull();
    expect(at('session-foot-usage')).toBeNull();
    expect(host.textContent).not.toMatch(/\$\d/);
    expect(host.textContent).not.toMatch(/\bin ·/);
  });
});

describe('picking a model is one click on a friendly name', () => {
  it('names the resolved model rather than the word "Default"', () => {
    render({ model: null, resolvedModel: 'claude-opus-4-8' });
    expect(must('session-pill-model').textContent).toContain('Opus 4.8');
    expect(must('session-pill-model').textContent).not.toContain('Default');
  });

  it('falls back to the catalog’s own hint before a session exists', () => {
    render({ model: null, resolvedModel: null });
    expect(must('session-pill-model').textContent).toContain('Opus 5');
  });

  it('never shows a raw id on the pill', () => {
    render({ model: 'claude-fable-5-1[1m]' });
    const label = must('session-pill-model').textContent ?? '';
    expect(label).toContain('Fable 5.1');
    expect(label).not.toContain('[1m]');
  });

  it('opens a menu of pickable models — with "Default" left out', () => {
    render({ model: null, resolvedModel: 'claude-opus-4-8' });
    click(must('session-pill-model'));
    const rows = [...must('session-menu-model').querySelectorAll('.menu-label')].map((node) =>
      node.textContent?.trim(),
    );
    expect(rows).toEqual(['Opus 5', 'Fable 5.1', 'Sonnet 4.6']);
  });

  it('gives each row the description’s first sentence as a subline', () => {
    render();
    click(must('session-pill-model'));
    const first = must('session-menu-model').querySelector('.menu-sub');
    expect(first?.textContent?.trim()).toBe(
      'Most capable for your hardest and longest-running tasks',
    );
  });

  it('reports the picked model’s id, once', () => {
    const onmodel = vi.fn();
    render({ onmodel });
    click(must('session-pill-model'));
    click(must('session-menu-model').querySelectorAll<HTMLElement>('.menu-item')[1]!);
    expect(onmodel).toHaveBeenCalledTimes(1);
    expect(onmodel).toHaveBeenCalledWith('claude-fable-5-1[1m]');
    expect(at('session-menu-model')).toBeNull();
  });

  it('closes an open menu on Escape', () => {
    render();
    click(must('session-pill-model'));
    expect(at('session-menu-model')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(at('session-menu-model')).toBeNull();
  });

  it('anchors the popover above the pill rather than inside a scroller', () => {
    render();
    click(must('session-pill-model'));
    const menu = must('session-menu-model');
    // Positioned against its own pill wrapper, which lives in the composer box.
    expect(menu.parentElement?.className).toContain('pill-wrap');
    expect(menu.closest('[data-testid="session-composer"]')).not.toBeNull();
  });
});

describe('the effort menu spells out what Auto means', () => {
  it('offers Auto, Low, Medium, High, Max', () => {
    render();
    click(must('session-pill-effort'));
    const rows = [...must('session-menu-effort').querySelectorAll('.menu-label')].map((node) =>
      node.textContent?.trim(),
    );
    expect(rows).toEqual(['Auto', 'Low', 'Medium', 'High', 'Max']);
    expect(must('session-menu-effort').querySelector('.menu-sub')?.textContent?.trim()).toBe(
      'Let the model decide',
    );
  });
});

describe('the permission pill says what it does', () => {
  it('reads as a sentence, not a one-word code', () => {
    render({ permissionMode: 'prompt' });
    expect(must('session-pill-permission').textContent).toContain('Prompt for permissions');
  });

  it('toggles through its own menu', () => {
    const onpermission = vi.fn();
    render({ permissionMode: 'prompt', onpermission });
    click(must('session-pill-permission'));
    click(must('session-menu-permission').querySelectorAll<HTMLElement>('.menu-item')[1]!);
    expect(onpermission).toHaveBeenCalledWith('bypassAll');
  });
});

describe('the tool pill', () => {
  it('names the CLI the next session will run', () => {
    render({ tool: 'claude' });
    expect(must('session-pill-tool').textContent).toContain('Claude');
  });

  it('offers Codex but disables it when the CLI is not installed', () => {
    render({ codexAvailable: false });
    click(must('session-pill-tool'));
    const rows = must('session-menu-tool').querySelectorAll<HTMLButtonElement>('.menu-item');
    expect(rows[0]?.disabled).toBe(false);
    expect(rows[1]?.disabled).toBe(true);
    expect(rows[1]?.textContent).toContain('not installed');
  });

  it('lets Codex be chosen once the preflight finds it', () => {
    const ontool = vi.fn();
    render({ codexAvailable: true, ontool });
    click(must('session-pill-tool'));
    click(must('session-menu-tool').querySelectorAll<HTMLElement>('.menu-item')[1]!);
    expect(ontool).toHaveBeenCalledWith('codex');
  });
});

describe('send and stop', () => {
  it('sends on Enter and keeps Shift+Enter for a newline', () => {
    const onsend = vi.fn();
    render({ onsend });
    const input = must('session-composer-input') as HTMLTextAreaElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    flushSync();
    expect(onsend).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSync();
    expect(onsend).toHaveBeenCalledWith('hello', [], [], []);
  });

  it('becomes a spinning stop while the agent works', () => {
    render({ working: true });
    expect(at('session-composer-send')).toBeNull();
    const stop = must('session-composer-stop');
    expect(stop.querySelector('.spinner')).not.toBeNull();
  });
});

describe('@mentions — the picker, the chips, the promise', () => {
  const CANDIDATES = [
    { uid: 'prs_corey', displayName: 'Corey Epstein', kind: 'human', email: 'corey@example.com' },
    { uid: 'prs_alex', displayName: 'Alex Smith', kind: 'human', email: 'alex@example.com' },
    { uid: 'agt_atlas', displayName: 'Atlas', kind: 'agent' },
  ];

  function type(text: string) {
    const input = must('session-composer-input') as HTMLTextAreaElement;
    input.value = text;
    input.setSelectionRange?.(text.length, text.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    return input;
  }

  const key = (input: HTMLElement, k: string, init: KeyboardEventInit = {}) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
    flushSync();
  };

  it('opens on a bare @ and lists people before agents with a kind tag', () => {
    render({ mentionCandidates: CANDIDATES });
    expect(at('session-mention-menu')).toBeNull();
    type('@');
    const rows = [...must('session-mention-menu').querySelectorAll('[data-testid="session-mention-item"]')];
    expect(rows.map((row) => row.querySelector('.name')?.textContent?.trim())).toEqual([
      'Corey Epstein',
      'Alex Smith',
      'Atlas',
    ]);
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['human', 'human', 'agent']);
    expect(rows[2]?.querySelector('.kind')?.textContent?.trim()).toBe('agent');
    expect(rows[0]?.querySelector('.avatar')?.textContent?.trim()).toBe('CE');
    // The slash menu does not fight for the slot.
    expect(at('session-slash-menu')).toBeNull();
  });

  it('filters as you type and never opens mid-word', () => {
    render({ mentionCandidates: CANDIDATES });
    type('ping @at');
    const rows = [...must('session-mention-menu').querySelectorAll('.name')].map((n) => n.textContent?.trim());
    expect(rows).toEqual(['Atlas']);
    type('mail corey@ex');
    expect(at('session-mention-menu')).toBeNull();
    type('hello');
    expect(at('session-mention-menu')).toBeNull();
  });

  it('anchors the picker in the composer, above the box', () => {
    render({ mentionCandidates: CANDIDATES });
    type('@');
    const menu = must('session-mention-menu');
    expect(menu.closest('[data-testid="session-composer"]')).not.toBeNull();
    expect(menu.compareDocumentPosition(must('session-composer-input')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Enter picks the highlighted row: @Name lands in the draft and a chip promises the DM', () => {
    const onsend = vi.fn();
    render({ mentionCandidates: CANDIDATES, onsend });
    const input = type('@co');
    key(input, 'Enter');
    expect(onsend).not.toHaveBeenCalled();
    expect(input.value).toBe('@Corey Epstein ');
    expect(at('session-mention-menu')).toBeNull();
    const chips = must('session-mention-chips');
    expect(chips.textContent).toContain('Will DM');
    expect(chips.textContent).toContain('Corey Epstein');
    expect(chips.querySelectorAll('[data-testid="session-mention-chip"]')).toHaveLength(1);
  });

  it('Down/Up move the highlight and Tab picks it', () => {
    render({ mentionCandidates: CANDIDATES });
    const input = type('@');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    const rows = must('session-mention-menu').querySelectorAll('[data-testid="session-mention-item"]');
    expect(rows[2]?.getAttribute('aria-selected')).toBe('true');
    key(input, 'ArrowUp');
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');
    key(input, 'Tab');
    expect(input.value).toBe('@Alex Smith ');
  });

  it('Escape closes the picker without inserting anything', () => {
    render({ mentionCandidates: CANDIDATES });
    const input = type('@co');
    expect(at('session-mention-menu')).not.toBeNull();
    key(input, 'Escape');
    expect(at('session-mention-menu')).toBeNull();
    expect(input.value).toBe('@co');
    expect(at('session-mention-chips')).toBeNull();
  });

  it('sends the chips with the text, and nothing once the chip is removed', () => {
    const onsend = vi.fn();
    render({ mentionCandidates: CANDIDATES, onsend });
    let input = type('@co');
    key(input, 'Enter');
    input = type('@Corey Epstein can you look?');
    key(input, 'Enter');
    expect(onsend).toHaveBeenCalledWith(
      '@Corey Epstein can you look?',
      [],
      [{ uid: 'prs_corey', displayName: 'Corey Epstein' }],
      [],
    );
    expect(at('session-mention-chips')).toBeNull();

    input = type('@co');
    key(input, 'Enter');
    click(must('session-mention-remove'));
    expect(at('session-mention-chips')).toBeNull();
    input = type('@Corey Epstein again');
    key(input, 'Enter');
    expect(onsend).toHaveBeenLastCalledWith('@Corey Epstein again', [], [], []);
  });

  it('drops the chip when the @Name is deleted from the draft', () => {
    render({ mentionCandidates: CANDIDATES });
    let input = type('@co');
    key(input, 'Enter');
    expect(at('session-mention-chips')).not.toBeNull();
    input = type('never mind');
    expect(at('session-mention-chips')).toBeNull();
  });

  it('reports the DM outcome in the footer, as an alert when it failed', () => {
    render({ mentionStatus: { text: "DM'd Corey Epstein", error: false } });
    expect(must('session-mention-status').textContent?.trim()).toBe("DM'd Corey Epstein");
    expect(must('session-mention-status').getAttribute('role')).toBeNull();
    if (component) unmount(component);
    component = null;
    render({ mentionStatus: { text: "Couldn't DM Atlas (Network error)", error: true } });
    expect(must('session-mention-status').getAttribute('role')).toBe('alert');
    expect(must('session-mention-status').className).toContain('error');
  });
});

describe('the effort menu follows the tool', () => {
  it('offers Codex its own ladder when told to', () => {
    render({ tool: 'codex', codexAvailable: true, effortOptions: CODEX_EFFORT_OPTIONS });
    click(must('session-pill-effort'));
    const labels = [...must('session-menu-effort').querySelectorAll('.menu-label')].map(
      (row) => row.textContent?.trim(),
    );
    expect(labels).toEqual(['Auto', 'Low', 'Medium', 'High', 'Extra high', 'Ultra']);
  });

  it('names the pill from the ladder it was given', () => {
    render({ tool: 'codex', effort: 'xhigh', effortOptions: CODEX_EFFORT_OPTIONS });
    expect(must('session-pill-effort').textContent).toContain('Extra high');
  });
});

describe('the model-reset note', () => {
  it('shows the page’s one-line note in the footer', () => {
    render({ modelNote: 'Model reset to Default for Claude' });
    expect(must('session-model-reset-note').textContent?.trim()).toBe(
      'Model reset to Default for Claude',
    );
  });

  it('renders nothing when there is no note', () => {
    render();
    expect(at('session-model-reset-note')).toBeNull();
  });
});

describe('openModelMenu — the transcript’s "Choose a model" lands here', () => {
  it('opens the model menu from outside', () => {
    render();
    expect(at('session-menu-model')).toBeNull();
    (component as unknown as { openModelMenu: () => void }).openModelMenu();
    flushSync();
    expect(at('session-menu-model')).not.toBeNull();
    expect(must('session-pill-model').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('reset — a fresh draft for a new session', () => {
  it('clears the text and the attached images, but not the pills', () => {
    render({ company: 'indigo', companies: [{ slug: 'indigo', displayName: 'Indigo' }] });
    const input = must('session-composer-input') as HTMLTextAreaElement;
    input.value = 'half a thought';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(false);
    (component as unknown as { reset: () => void }).reset();
    flushSync();
    expect(input.value).toBe('');
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(true);
    expect(at('session-composer-attachments')).toBeNull();
    // The company pill is a prop: it stays.
    expect(must('session-pill-company').textContent).toContain('Indigo');
  });
});
