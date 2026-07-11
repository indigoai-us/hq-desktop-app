// @vitest-environment happy-dom
//
// US-013: Restyle widget click popup to locked design (scenes 8-10).
// Behavioral mounts (no Tauri) + source contracts for the frosted panel chrome.
//
// e2eTests from the PRD:
// 1. Given the pinned popup, when rendered, then no header/tabs/buttons/footer
//    chrome exists and rows are one line with day separators.
// 2. Given an actionable row, when hovered, then text pills replace the
//    timestamp; at rest the row shows the timestamp.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Force Svelte's client entry so mount/flushSync work (same pattern as US-003).
vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import Widget from '../../src/components/Widget.svelte';
import {
  WIDGET_HOVER_PANEL_WIDTH,
  WIDGET_ROW_TIMEOUT_MS,
  dismissRecent,
  widgetHoverWindowSize,
  type WidgetStackItem,
} from '../../src/stores/widgetNotifications';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);

const widgetSource = readFileSync(root('src/components/Widget.svelte'), 'utf8');
const rowSource = readFileSync(
  root('src/components/NotificationRow.svelte'),
  'utf8',
);

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function mountWidget(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(Widget, { target: host, props });
  flushSync();
  return host;
}

function stackItem(
  overrides: Partial<WidgetStackItem> & Pick<WidgetStackItem, 'id'>,
  now = 1_000,
): WidgetStackItem {
  return {
    type: 'system',
    text: 'hello',
    ts: now,
    kind: 'update',
    clickActionId: 'open',
    data: null,
    expiresAt: now + WIDGET_ROW_TIMEOUT_MS,
    ...overrides,
  };
}

/** Open the pinned popup by clicking the wordmark. */
function pinOpen(): HTMLElement {
  host.querySelector('.wm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
  const list = host.querySelector<HTMLElement>('[data-testid="widget-hover-list"]');
  expect(list).toBeTruthy();
  return list!;
}

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('US-013: pinned popup matches locked design (scenes 8-10)', () => {
  describe('single frosted panel, no extra chrome', () => {
    it('pinned popup renders only day separators and rows — no header/tabs/buttons/footer chrome', () => {
      // Deterministic clock so day labels never shift across midnight in CI.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)); // Jul 15 2026, 12:00 local
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem({ id: 't', type: 'sync', text: 'today row', unread: true }, now),
          stackItem(
            { id: 'y', type: 'share', text: 'yesterday row' },
            new Date(2026, 6, 14, 20, 0, 0).getTime(),
          ),
        ],
      });

      const list = pinOpen();

      // Panel children are exclusively day separators and row wrappers.
      const children = [...list.children];
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        expect(
          child.classList.contains('hl-sep') || child.classList.contains('hl-row'),
        ).toBe(true);
      }

      // No popover-style chrome anywhere in the panel.
      expect(list.querySelector('header, footer, [role="tablist"], [role="tab"]')).toBeNull();
      expect(list.querySelector('.hl-header, .hl-footer, .hl-tabs, .hl-toolbar')).toBeNull();

      // Day separator present with the muted uppercase label.
      const seps = [...list.querySelectorAll('.hl-sep')].map((el) => el.textContent);
      expect(seps).toEqual(['YESTERDAY']);

      // Rows are one line at rest (not expanded).
      for (const row of list.querySelectorAll('[data-testid="notification-row"]')) {
        expect(row.getAttribute('data-expanded')).toBe('false');
      }
    });

    it('rows carry the unread dot between the type icon and the source text', () => {
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem({ id: 'a', type: 'sync', actor: 'Brand Honey', text: 'added you', unread: true }, now),
        ],
      });
      const list = pinOpen();
      const row = list.querySelector('[data-testid="notification-row"]')!;
      const kids = [...row.children];
      const iconIdx = kids.findIndex((el) => el.classList.contains('nr-icon'));
      const dotIdx = kids.findIndex((el) => el.classList.contains('nr-unread'));
      const textIdx = kids.findIndex((el) => el.classList.contains('nr-text'));
      expect(iconIdx).toBeGreaterThanOrEqual(0);
      expect(dotIdx).toBe(iconIdx + 1);
      expect(textIdx).toBe(dotIdx + 1);
    });
  });

  describe('actionable rows: hover-only text pills', () => {
    it('actionable row renders text pills (actionLabel + Dismiss) and a timestamp at rest', () => {
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem(
            {
              id: 'a',
              type: 'sync',
              actor: 'Brand Honey',
              text: 'added you',
              actionLabel: 'Sync now',
              unread: true,
            },
            now,
          ),
        ],
      });
      const list = pinOpen();
      const row = list.querySelector('[data-testid="notification-row"]')!;

      // Timestamp shown at rest.
      expect(row.querySelector('.nr-ts')?.textContent?.trim()).toBe('now');

      // Pills carry the action label and a text Dismiss (no × icon, no svg).
      const open = row.querySelector('.nr-open')!;
      expect(open.textContent?.trim()).toBe('Sync now');
      const dismiss = row.querySelector('.nr-dismiss')!;
      expect(dismiss.classList.contains('nr-dismiss-text')).toBe(true);
      expect(dismiss.textContent?.trim()).toBe('Dismiss');
      expect(dismiss.querySelector('svg')).toBeNull();
    });

    it('CSS contract: hover swaps the timestamp for the action pills', () => {
      // The swap is pure CSS (:hover / :focus-within) — happy-dom does not
      // compute it, so lock the rules at the source.
      expect(rowSource).toContain('.nr:not(.nr-message):hover .nr-ts');
      expect(rowSource).toContain('.nr:not(.nr-message):hover .nr-actions');
      const tsHideIdx = rowSource.indexOf('.nr:not(.nr-message):hover .nr-ts');
      const tsHideBlock = rowSource.slice(tsHideIdx, rowSource.indexOf('}', tsHideIdx));
      expect(tsHideBlock).toContain('display: none');
    });

    it('Dismiss pill removes the row from the pinned popup', () => {
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem({ id: 'a', type: 'sync', text: 'row a', actionLabel: 'Sync now' }, now),
          stackItem({ id: 'b', type: 'share', text: 'row b' }, now - 1000),
        ],
      });
      const list = pinOpen();
      expect(list.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(2);

      list
        .querySelector('.nr-dismiss')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();

      expect(
        host.querySelectorAll('[data-testid="notification-row"]'),
      ).toHaveLength(1);
    });

    it('dismissing the LAST row closes the panel (no stale hold on an empty invisible panel)', () => {
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem({ id: 'only', type: 'sync', text: 'row', actionLabel: 'Sync now' }, now),
        ],
      });
      const list = pinOpen();
      // Simulate the pointer being over the panel when the row goes.
      list.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      flushSync();

      list
        .querySelector('.nr-dismiss')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();

      // Panel unmounts entirely — closePinned ran (pinned/hoverOpen reset).
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
      expect(host.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(0);
    });
  });

  describe('panel chrome + sizing source contracts', () => {
    it('popup is a single frosted panel growing upward from the wordmark (bottom-right origin)', () => {
      const style = widgetSource.slice(widgetSource.indexOf('<style>'));
      const panelIdx = style.indexOf('.hover-list {');
      expect(panelIdx).toBeGreaterThan(-1);
      const panel = style.slice(panelIdx, style.indexOf('}', panelIdx));
      expect(panel).toContain('width: 264px');
      expect(panel).toContain('border-radius: 12px');
      expect(panel).toContain('padding: 6px');
      expect(panel).toContain('gap: 1px');
      expect(panel).toContain('backdrop-filter: blur(30px) saturate(1.8)');
      expect(panel).toContain('transform-origin: bottom right');
      expect(panel).toContain('widget-bloom');
    });

    it('rows inside the panel drop their own glass — transparent with panel-scoped hover tint', () => {
      const style = widgetSource.slice(widgetSource.indexOf('<style>'));
      const rowIdx = style.indexOf('.hl-row :global(.nr) {');
      expect(rowIdx).toBeGreaterThan(-1);
      const row = style.slice(rowIdx, style.indexOf('}', rowIdx));
      expect(row).toContain('background: transparent');
      expect(row).toContain('min-height: 28px');
      expect(row).toContain('border-radius: 7px');
      expect(row).not.toContain('backdrop-filter');
      expect(row).not.toContain('box-shadow');
    });

    it('day separator uses the muted uppercase treatment from the board', () => {
      const style = widgetSource.slice(widgetSource.indexOf('<style>'));
      const sepIdx = style.indexOf('.hl-sep {');
      const sep = style.slice(sepIdx, style.indexOf('}', sepIdx));
      expect(sep).toContain('text-transform: uppercase');
      expect(sep).toContain('font-size: 9px');
      expect(sep).toContain('letter-spacing: 0.9px');
      expect(sep).toContain('color: var(--row-muted)');
    });

    it('hover window sizing tracks the 264px panel', () => {
      const one = [stackItem({ id: 'a' }, Date.now())];
      expect(widgetHoverWindowSize(one, 0).width).toBe(WIDGET_HOVER_PANEL_WIDTH + 20);
    });

    it('dismissRecent drops the id from recent and visible', () => {
      const now = Date.now();
      const state = {
        occluded: false,
        held: false,
        visible: [stackItem({ id: 'a' }, now)],
        queued: [],
        recent: [stackItem({ id: 'a' }, now), stackItem({ id: 'b' }, now)],
      };
      const next = dismissRecent(state, 'a');
      expect(next.visible).toHaveLength(0);
      expect(next.recent.map((r) => r.id)).toEqual(['b']);
    });
  });
});
