/**
 * One 4px scrollbar in every Sync window (mirrors packages/ui
 * src/chat/scrollbars.contract.test.ts for the shell).
 *
 * `scrollbar-width` / `scrollbar-color` beat `::-webkit-scrollbar` in Chromium
 * and WebKit — `scrollbar-width: thin` drew an ~11px bar straight through a
 * 4px rule — so only `scrollbar-width: none` (hiding a bar) is allowed, and
 * every sized `::-webkit-scrollbar` is 4px.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(svelte|css)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function styleOf(path: string): string {
  const text = readFileSync(path, 'utf8');
  const css = path.endsWith('.svelte')
    ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    : text;
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

type Rule = { selector: string; body: string };
function rules(css: string): Rule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, ' '),
    body: m[2],
  }));
}

function declarations(body: string, prop: string): string[] {
  const re = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g');
  return [...body.matchAll(re)].map((m) => m[1].trim());
}

const files = walk(SRC).map((path) => ({ rel: relative(SRC, path), css: styleOf(path) }));
const isBar = (selector: string) => /::-webkit-scrollbar(?![-\w])/.test(selector);

describe('scrollbar contract (apps/sync)', () => {
  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('never sets scrollbar-width except `none`', () => {
    const offenders = files.flatMap(({ rel, css }) =>
      declarations(css, 'scrollbar-width')
        .filter((value) => value !== 'none')
        .map((value) => `${rel}: scrollbar-width: ${value}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never sets scrollbar-color (it disables ::-webkit-scrollbar styling)', () => {
    const offenders = files.flatMap(({ rel, css }) =>
      declarations(css, 'scrollbar-color').map((value) => `${rel}: scrollbar-color: ${value}`),
    );
    expect(offenders).toEqual([]);
  });

  it('sizes every ::-webkit-scrollbar at 4px', () => {
    const offenders = files.flatMap(({ rel, css }) =>
      rules(css)
        .filter((rule) => isBar(rule.selector))
        .flatMap((rule) =>
          ['width', 'height'].flatMap((prop) =>
            declarations(rule.body, prop)
              .filter((value) => value !== '4px')
              .map((value) => `${rel}: ${rule.selector} { ${prop}: ${value} }`),
          ),
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('every custom bar paints a thumb (a sized bar with no thumb rule is invisible)', () => {
    const offenders = files.flatMap(({ rel, css }) => {
      const all = rules(css);
      return all
        .filter((rule) => isBar(rule.selector))
        .filter((rule) => !declarations(rule.body, 'display').includes('none'))
        .flatMap((rule) => rule.selector.split(',').map((s) => s.trim()))
        .filter(
          (selector) =>
            !all.some((other) =>
              other.selector
                .split(',')
                .map((s) => s.trim())
                .includes(
                  selector.endsWith(')')
                    ? selector.replace(/::-webkit-scrollbar\)$/, '::-webkit-scrollbar-thumb)')
                    : `${selector}-thumb`,
                ),
            ),
        )
        .map((selector) => `${rel}: ${selector}`);
    });
    expect(offenders).toEqual([]);
  });

  it('hides a bar for WebKit too wherever scrollbar-width: none hides it', () => {
    const offenders = files
      .filter(({ css }) => declarations(css, 'scrollbar-width').includes('none'))
      .filter(
        ({ css }) =>
          !rules(css).some(
            (rule) => isBar(rule.selector) && declarations(rule.body, 'display').includes('none'),
          ),
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('draws the window-level bar at 4px with a 2px thumb over a transparent track', () => {
    const css = styleOf(fileURLToPath(new URL('./desktop-alt/styles/desktop-alt.css', import.meta.url)));
    const all = rules(css);
    const find = (selector: string) =>
      all.find((rule) => rule.selector.split(',').map((s) => s.trim()).includes(selector));
    const bar = find("html[data-window='desktop-alt'] ::-webkit-scrollbar");
    expect(declarations(bar!.body, 'width')).toEqual(['4px']);
    expect(declarations(bar!.body, 'height')).toEqual(['4px']);
    const thumb = find("html[data-window='desktop-alt'] ::-webkit-scrollbar-thumb");
    expect(declarations(thumb!.body, 'border-radius')).toEqual(['2px']);
    expect(declarations(thumb!.body, 'background')).toEqual(['var(--scrollbar-thumb)']);
    const track = find("html[data-window='desktop-alt'] ::-webkit-scrollbar-track");
    expect(declarations(track!.body, 'background')).toEqual(['transparent']);
  });
});
