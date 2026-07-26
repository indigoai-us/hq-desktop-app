// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

let mount: typeof import('svelte').mount;
let tick: typeof import('svelte').tick;
let unmount: typeof import('svelte').unmount;
let CommandPalette: typeof import('../../src/desktop-alt/components/CommandPalette.svelte').default;

let host: HTMLDivElement;
let trigger: HTMLButtonElement;
let component: ReturnType<typeof mount> | null;
let scrollIntoView: ReturnType<typeof vi.fn>;

const commands = [
  {
    id: 'command-sync-now',
    label: 'Sync now',
    detail: 'Run a sync',
    action: vi.fn(),
  },
  {
    id: 'command-go-home',
    label: 'Go to Home',
    detail: 'Open the overview',
    action: vi.fn(),
  },
];

const manyCommands = Array.from({ length: 18 }, (_, index) => ({
  id: `command-go-destination-${index}`,
  label: `Go to destination ${index}`,
  detail: `Open destination ${index}`,
  action: vi.fn(),
}));

async function flush() {
  await tick();
  await Promise.resolve();
}

async function renderPalette(paletteCommands = commands) {
  component = mount(CommandPalette, {
    target: host,
    props: {
      commands: paletteCommands,
      onclose: () => {
        if (component) {
          void unmount(component);
          component = null;
        }
      },
    },
  });
  await flush();
}

beforeAll(async () => {
  ({ mount, tick, unmount } = await import('svelte'));
  ({ default: CommandPalette } = await import(
    '../../src/desktop-alt/components/CommandPalette.svelte'
  ));
});

beforeEach(() => {
  document.body.innerHTML = '';
  trigger = document.createElement('button');
  trigger.textContent = 'Open command palette';
  document.body.append(trigger);
  host = document.createElement('div');
  document.body.append(host);
  trigger.focus();
  component = null;
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

describe('command palette keyboard focus', () => {
  it('returns focus to the opening control after Escape closes the modal', async () => {
    await renderPalette();

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter commands"]');
    expect(document.activeElement).toBe(input);

    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();

    expect(document.activeElement).toBe(trigger);
  });

  it('wraps Tab and Shift+Tab within the modal', async () => {
    await renderPalette();

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter commands"]');
    const options = Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="option"]'));
    const lastOption = options.at(-1);
    expect(input).not.toBeNull();
    expect(lastOption).not.toBeUndefined();

    lastOption?.focus();
    lastOption?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(input);

    input?.focus();
    input?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(lastOption);
  });

  it('scrolls keyboard-highlighted options into view as selection moves', async () => {
    await renderPalette(manyCommands);

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter commands"]');
    expect(input).not.toBeNull();
    scrollIntoView.mockClear();

    for (let index = 0; index < 12; index += 1) {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await flush();
    }

    expect(
      host.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="true"]')?.id,
    ).toBe('command-go-destination-12');
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
  });
});
