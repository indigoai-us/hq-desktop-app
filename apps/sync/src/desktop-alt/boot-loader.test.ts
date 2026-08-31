// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOT_LOADER_FADE_MS, dismissBootLoader } from './boot-loader';
import { DEFAULT_SKELETON_DELAY_MS } from './lib/load-state';

afterEach(() => {
  vi.useRealTimers();
  document.getElementById('hq-boot')?.remove();
});

function mountOverlay(doc: Document = document): HTMLElement {
  const el = doc.createElement('div');
  el.id = 'hq-boot';
  doc.body.appendChild(el);
  return el;
}

describe('BOOT_LOADER_FADE_MS', () => {
  it('is 200ms so the overlay can cross-fade into the real UI', () => {
    expect(BOOT_LOADER_FADE_MS).toBe(200);
  });
});

describe('dismissBootLoader', () => {
  it('adds hq-boot-done and removes the overlay after the fade fallback', () => {
    vi.useFakeTimers();
    const el = mountOverlay();
    dismissBootLoader();
    expect(el.classList.contains('hq-boot-done')).toBe(true);
    expect(document.getElementById('hq-boot')).toBe(el);
    vi.advanceTimersByTime(399);
    expect(document.getElementById('hq-boot')).toBe(el);
    vi.advanceTimersByTime(1);
    expect(document.getElementById('hq-boot')).toBeNull();
  });

  it('removes the overlay on opacity transitionend before the fallback', () => {
    vi.useFakeTimers();
    const el = mountOverlay();
    dismissBootLoader();
    const event = new Event('transitionend');
    Object.defineProperty(event, 'propertyName', { value: 'opacity' });
    el.dispatchEvent(event);
    expect(document.getElementById('hq-boot')).toBeNull();
    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
  });

  it('is idempotent once dismissal has started', () => {
    vi.useFakeTimers();
    const el = mountOverlay();
    dismissBootLoader();
    dismissBootLoader();
    expect(el.classList.contains('hq-boot-done')).toBe(true);
    vi.advanceTimersByTime(400);
    expect(document.getElementById('hq-boot')).toBeNull();
    expect(() => dismissBootLoader()).not.toThrow();
  });

  it('no-ops when #hq-boot is missing', () => {
    expect(document.getElementById('hq-boot')).toBeNull();
    expect(() => dismissBootLoader()).not.toThrow();
  });

  it('accepts an injected document', () => {
    vi.useFakeTimers();
    const doc = document.implementation.createHTMLDocument('boot');
    const el = mountOverlay(doc);
    dismissBootLoader(doc);
    expect(el.classList.contains('hq-boot-done')).toBe(true);
    vi.advanceTimersByTime(400);
    expect(doc.getElementById('hq-boot')).toBeNull();
  });
});

describe('desktop-alt.html boot overlay', () => {
  const html = readFileSync(resolve(process.cwd(), 'desktop-alt.html'), 'utf8');

  it('inlines #hq-boot before the mount target and never paints html/body', () => {
    expect(html).toContain('id="hq-boot"');
    expect(html).toContain('id="hq-boot-mark"');
    expect(html).toContain('id="desktop-alt"');
    expect(html.indexOf('id="hq-boot"')).toBeLessThan(html.indexOf('id="desktop-alt"'));
    expect(html).toContain('hq-boot-done');
    expect(html).not.toMatch(/html\s*\{[^}]*background/);
    expect(html).not.toMatch(/body\s*\{[^}]*background/);
  });

  it('gates the overlay on DEFAULT_SKELETON_DELAY_MS so fast loads never flash', () => {
    expect(html).toContain('DEFAULT_SKELETON_DELAY_MS');
    expect(html).toContain(`${DEFAULT_SKELETON_DELAY_MS}ms`);
    expect(html).toMatch(
      new RegExp(`animation-delay:\\s*${DEFAULT_SKELETON_DELAY_MS}ms`),
    );
  });
});
