import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(process.cwd(), 'src');
const SEMANTIC_EDGE =
  /border-(?:left|inline-start)(?:-color)?\s*:\s*[^;]*(?:--v4-(?:warn|error|ok|unread)|--(?:amber|red|emerald))/gi;
const ACCENT_STRIP = /<span\s+class=["'][^"']*\baccent\b[^"']*["']/gi;
const BOX_SHADOW = /\bbox-shadow\s*:\s*([^;]+);/gi;
const SIDE_INSET =
  /\binset\s+(-?(?:\d*\.)?\d+)px\s+0(?:px)?\s+0(?:px)?\s+([^,]+)/gi;
const FULL_PANE_GLASS_HIGHLIGHT = /var\(--v4-glass-highlight\)/;

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:svelte|css|ts)$/.test(entry)
        ? [path]
        : [];
  });
}

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

function partialInsetSideRails(source: string): string[] {
  return [...source.matchAll(BOX_SHADOW)].flatMap((shadow) => {
    const declaration = shadow[1];
    return [...declaration.matchAll(SIDE_INSET)]
      .filter((inset) => Number.parseFloat(inset[1]) !== 0)
      .filter((inset) => !FULL_PANE_GLASS_HIGHLIGHT.test(inset[0]))
      .map((inset) => inset[0]);
  });
}

function expectOpenPersistentSelection(
  source: string,
  baseSelector: string,
  selectedSelector: string,
  label: string,
): void {
  const base = rule(source, baseSelector);
  const selected = rule(source, selectedSelector);

  expect(base, `${label} base selector should exist`).not.toBe('');
  expect(base, `${label} base row should remain square`).toContain(
    'border-radius: 0',
  );
  expect(base, `${label} base row should not have a closed perimeter`).not.toMatch(
    /\bborder:\s*1px/,
  );

  expect(selected, `${label} selected selector should exist`).not.toBe('');
  expect(selected, `${label} selected row should not paint an opaque slab`).toContain(
    'background: transparent',
  );
  expect(selected, `${label} selected row needs a neutral bottom rule`).toMatch(
    /box-shadow:\s*inset\s+0\s+-1px\s+0\s+var\(--[^)]+\)/,
  );
  expect(
    partialInsetSideRails(`.selected { ${selected} }`),
    `${label} selected row should not use a side rail`,
  ).toEqual([]);
}

describe('DESKTOP-018: no colored edge rails', () => {
  it('never uses a semantic color as a partial container edge', () => {
    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(SEMANTIC_EDGE)].map(
        (match) => `${relative(process.cwd(), path)}: ${match[0]}`,
      );
    });

    expect(
      violations,
      'Use an open row with a neutral divider and a small dot or concise semantic text instead.',
    ).toEqual([]);
  });

  it('never reintroduces decorative card-edge accent strips', () => {
    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(ACCENT_STRIP)].map(
        (match) => `${relative(process.cwd(), path)}: ${match[0]}`,
      );
    });

    expect(
      violations,
      'Use normal card padding, neutral borders, and compact status dots instead of an inset edge strip.',
    ).toEqual([]);
  });

  it('rejects semantic or decorative inset side rails while allowing full-pane glass highlights', () => {
    expect(
      partialInsetSideRails(
        '.nr-selected { box-shadow: inset 2px 0 0 var(--popover-unread); }',
      ),
    ).toEqual(['inset 2px 0 0 var(--popover-unread)']);
    expect(
      partialInsetSideRails(
        '.pane { box-shadow: var(--v4-shadow-popover), inset 1px 0 0 var(--v4-glass-highlight); }',
      ),
    ).toEqual([]);

    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return partialInsetSideRails(source).map(
        (match) => `${relative(process.cwd(), path)}: ${match}`,
      );
    });

    expect(
      violations,
      'Use a neutral fill/divider for rows and cards; reserve inset side highlights for full-pane glass surfaces.',
    ).toEqual([]);
  });

  it('uses transparent neutral bottom rules for persistent row selection', () => {
    for (const [path, baseSelector, selectedSelector, label] of [
      [
        'desktop-alt/v4/V4Sidebar.svelte',
        '.v4-row',
        '.v4-row.active',
        'primary navigation',
      ],
      [
        'desktop-alt/v4/V4SecondarySidebar.svelte',
        '.v4-row',
        '.v4-row.active',
        'secondary navigation',
      ],
      [
        'desktop-alt/v4/FilesModeSidebar.svelte',
        '.fs-company-row',
        '.fs-company-row.active',
        'files company navigation',
      ],
      [
        'desktop-alt/components/CompanyFileTree.svelte',
        '.ft-row',
        '.ft-row.selected',
        'company file tree',
      ],
      [
        'components/NotificationRow.svelte',
        '.nr',
        '.nr-selected',
        'notification',
      ],
      [
        'components/messaging/RecipientPicker.svelte',
        '.suggestion',
        '.suggestion.active',
        'recipient suggestion',
      ],
      [
        'desktop-alt/pages/ProjectDetailView.svelte',
        '.task-rail-row',
        '.task-rail-row.is-selected',
        'project task rail',
      ],
      [
        'desktop-alt/pages/CompanyGoalsPage.svelte',
        '.goal-list-row',
        '.goal-list-row.is-selected',
        'company goal list',
      ],
      [
        'desktop-alt/panels/TeamPanel.svelte',
        '.team-member-row',
        '.team-member-row.is-selected',
        'team member list',
      ],
      [
        'desktop-alt/panels/CompanyOperationsPanel.svelte',
        '.ops-nav-item',
        '.ops-nav-item.is-selected',
        'operations navigation',
      ],
    ] as const) {
      expectOpenPersistentSelection(
        readFileSync(join(SOURCE_ROOT, path), 'utf8'),
        baseSelector,
        selectedSelector,
        label,
      );
    }

    const messages = readFileSync(
      join(SOURCE_ROOT, 'components/messaging/MessagesShell.svelte'),
      'utf8',
    );
    expect(rule(messages, '.contact-row')).toContain('border-radius: 0');
    expect(rule(messages, '.compact-list .contact-row')).toContain('border-radius: 6px');
    expect(rule(messages, '.compact-list .contact-row.active')).toContain(
      'background: color-mix(in srgb, var(--fg) 10%, transparent)',
    );
    expect(rule(messages, '.compact-list .contact-row.active')).toContain('box-shadow: none');

    const secondarySidebar = readFileSync(
      join(SOURCE_ROOT, 'desktop-alt/v4/V4SecondarySidebar.svelte'),
      'utf8',
    );
    const secondaryFooter = rule(secondarySidebar, '.v4-footer.active');
    expect(secondaryFooter).toContain('background: transparent');
    expect(secondaryFooter).toContain(
      'box-shadow: inset 0 -1px 0 var(--v4-hairline)',
    );
  });

  it('keeps settings notices and moderation lock states free of partial edge rails', () => {
    const settings = readFileSync(
      join(SOURCE_ROOT, 'desktop-alt/pages/SettingsPage.svelte'),
      'utf8',
    );
    const moderation = readFileSync(
      join(SOURCE_ROOT, 'desktop-alt/panels/ModerationPanel.svelte'),
      'utf8',
    );

    expect(rule(settings, '.notice-card')).not.toContain('border-left:');
    expect(rule(moderation, '.section.locked')).not.toContain('border-left:');
  });

  it('keeps message details and share notes open instead of using one-sided inset rails', () => {
    const conversation = readFileSync(
      join(SOURCE_ROOT, 'components/messaging/Conversation.svelte'),
      'utf8',
    );
    const thread = readFileSync(
      join(SOURCE_ROOT, 'components/messaging/ThreadPanel.svelte'),
      'utf8',
    );

    for (const [source, selector] of [
      [conversation, '.dm-bubble-details'],
      [conversation, '.share-card-note'],
      [thread, '.thread-root-details'],
    ] as const) {
      const block = rule(source, selector);
      expect(block).toContain('border: 0');
      expect(block).toContain('border-top:');
      expect(block).not.toContain('border-left:');
      expect(block).toContain('border-radius: 0');
      expect(block).toContain('background: transparent');
    }

    expect(conversation).not.toMatch(
      /\.(?:dm-bubble-details|share-card-note)[^{]*\{[^}]*border-left:/,
    );
  });

  it('keeps conflict and meeting status rows open across every semantic state', () => {
    const conflicts = readFileSync(
      join(SOURCE_ROOT, 'components/ConflictRow.svelte'),
      'utf8',
    );
    const meetings = readFileSync(
      join(SOURCE_ROOT, 'components/MeetingsWindow.svelte'),
      'utf8',
    );

    for (const [source, selector, label] of [
      [conflicts, '.conflict-row', 'conflict row'],
      [meetings, '.active-row', 'active meeting row'],
    ] as const) {
      const block = rule(source, selector);
      expect(block, `${label} selector should exist`).not.toBe('');
      expect(block).toContain('border: 0');
      expect(block).toContain('border-radius: 0');
      expect(block).toContain('background: transparent');
      expect(block).not.toContain('border-left:');
      expect(partialInsetSideRails(`.${label.replaceAll(' ', '-')} { ${block} }`)).toEqual([]);
    }

    for (const [source, selector] of [
      [conflicts, '.conflict-row.resolved'],
      [conflicts, '.conflict-row.error'],
      [meetings, ".active-row[data-state='recording']"],
      [meetings, ".active-row[data-state='error']"],
    ] as const) {
      const block = rule(source, selector);
      expect(block, `${selector} selector should exist`).not.toBe('');
      expect(block).toContain('background: transparent');
      expect(block).not.toContain('border-left:');
      expect(partialInsetSideRails(`.state { ${block} }`)).toEqual([]);
    }
  });
});
