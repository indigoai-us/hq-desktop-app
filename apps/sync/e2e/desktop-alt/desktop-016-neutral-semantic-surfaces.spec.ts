import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

function expectOpenStatusRow(source: string, selector: string, label: string): void {
  const block = rule(source, selector);
  expect(block, `${label} selector should exist`).not.toBe('');
  expect(block, `${label} still has a closed perimeter`).toMatch(/\bborder:\s*0\s*;/);
  expect(block, `${label} needs a neutral row divider`).toContain(
    'border-top: 1px solid var(--v4-rowline)',
  );
  expect(block, `${label} still uses a colored partial edge`).not.toContain(
    'border-left:',
  );
  expect(block, `${label} still paints a surface fill`).toContain('background: transparent');
  expect(block, `${label} still has structural rounding`).toContain('border-radius: 0');
  expect(block, `${label} still mixes semantic color across its surface`).not.toContain(
    'background: color-mix(',
  );
}

describe('DESKTOP-016: neutral semantic surfaces', () => {
  const home = readRepoFile('src/desktop-alt/pages/HomePage.svelte');
  const storyCard = readRepoFile('src/desktop-alt/components/StoryCard.svelte');
  const deployments = readRepoFile('src/desktop-alt/panels/DeploymentsPanel.svelte');
  const secrets = readRepoFile('src/desktop-alt/panels/SecretsPanel.svelte');
  const submit = readRepoFile('src/desktop-alt/panels/SubmitPanel.svelte');
  const marketplace = readRepoFile('src/desktop-alt/panels/MarketplacePanel.svelte');
  const installed = readRepoFile('src/desktop-alt/panels/InstalledPacksPanel.svelte');
  const liveSessions = readRepoFile('src/desktop-alt/panels/LiveSessionsPanel.svelte');
  const moderation = readRepoFile('src/desktop-alt/panels/ModerationPanel.svelte');

  it('opens active progress and nested live-run status without tinting another card', () => {
    expectOpenStatusRow(home, '.home-progress', 'Home sync progress');
    expectOpenStatusRow(storyCard, '.live-run', 'task live run');
  });

  it('renders operational errors as neutral open rows', () => {
    for (const [source, selector, label] of [
      [deployments, '.deployments-error', 'deployments error'],
      [secrets, '.secrets-error', 'secrets error'],
      [installed, '.state-error', 'installed-pack error'],
    ] as const) {
      expectOpenStatusRow(source, selector, label);
    }
  });

  it('keeps submission and consent states open and achromatic', () => {
    expectOpenStatusRow(submit, '.state-success', 'submission success');
    expectOpenStatusRow(submit, '.state-error', 'submission error');
    expectOpenStatusRow(marketplace, '.consent-note', 'install consent note');

    const requestAccess = rule(submit, '.request-access');
    expect(requestAccess).toContain('border: 0');
    expect(requestAccess).toContain('border-top:');
    expect(requestAccess).toContain('border-radius: 0');
    expect(requestAccess).toContain('background: transparent');
  });

  it('keeps outpost status and grouping controls open while retaining compact status cues', () => {
    const groupControl = rule(liveSessions, '.ls-group-ctl');
    expect(groupControl).toContain('border: 0');
    expect(groupControl).toContain('border-radius: 0');
    expect(groupControl).toContain('background: transparent');

    const outpost = rule(liveSessions, '.ls-outpost-card');
    expect(outpost).toContain('border: 0');
    expect(outpost).toContain('border-top: 1px solid var(--v4-hairline)');
    expect(outpost).toContain('border-radius: 0');
    expect(outpost).toContain('background: transparent');
    expect(outpost).not.toContain('var(--v4-raised)');

    for (const selector of ['.ls-outpost-card.up', '.ls-outpost-card.down']) {
      const block = rule(liveSessions, selector);
      expect(block).toContain('background: transparent');
      expect(block).toContain('border-color: var(--v4-hairline)');
      expect(block).not.toContain('background: color-mix(');
    }
    expectOpenStatusRow(liveSessions, '.ls-outpost-note', 'outpost stale note');
  });

  it('uses a neutral destructive button surface with a compact warning dot', () => {
    const yank = rule(moderation, '.yank-button');
    expect(yank).toContain('background: var(--v4-control-faint)');
    expect(yank).toContain('border: 1px solid var(--v4-control-border)');
    expect(yank).toContain('color: var(--v4-text-1)');
    expect(yank).not.toContain('background: color-mix(');
    expect(moderation).toContain('.yank-button::before');
  });

  it('does not spend yellow on routine priority, update, pending, or best-effort metadata', () => {
    for (const [source, selector, label] of [
      [storyCard, ".priority-badge[data-priority='P2']", 'P2 priority'],
      [submit, '.status-pending', 'submission pending badge'],
      [submit, '.ra-pending', 'creator request pending copy'],
      [installed, '.badge', 'installed-pack update badge'],
      [installed, '.pill.update', 'installed-pack update pill'],
      [liveSessions, '.ls-besteffort', 'best-effort badge'],
      [marketplace, '.pill.version', 'marketplace version pill'],
      [marketplace, '.kind-dot', 'marketplace kind dot'],
    ] as const) {
      const block = rule(source, selector);
      expect(block, `${label} selector should exist`).not.toBe('');
      expect(block, `${label} still uses warning yellow`).not.toContain('var(--v4-warn)');
    }
  });

  it('keeps moderation security warnings sparse and routes true failures to error red', () => {
    for (const selector of [
      '.doc-path-badge',
      '.init-prompt-tag',
      '.doc-text.init-prompt',
    ]) {
      expect(rule(moderation, selector)).not.toContain('var(--v4-warn)');
    }
    const flagged = rule(moderation, '.flagged');
    expect(flagged).toContain('background: transparent');
    expect(flagged).not.toContain('background: color-mix(');
    expect(rule(moderation, '.row-flag')).toContain('color: var(--v4-text-3)');
    expect(rule(moderation, '.warning-dot')).toContain('background: var(--v4-warn)');
    expect(moderation).not.toContain('⚠');
    expect(rule(moderation, '.result.fail')).toContain('color: var(--v4-error)');
  });

  it('uses error red for actual failures and neutral marketplace decoration', () => {
    for (const [source, selector] of [
      [deployments, '.deployments-error'],
      [secrets, '.secrets-error'],
      [marketplace, '.state-error'],
      [marketplace, '.install-result.fail'],
    ] as const) {
      expect(rule(source, selector)).toContain('var(--v4-error)');
      expect(rule(source, selector)).not.toContain('var(--v4-warn)');
    }

    for (const selector of ['.accent', '.cover-version']) {
      expect(rule(marketplace, selector)).not.toContain('var(--v4-warn)');
    }
  });
});
