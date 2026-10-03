import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OWNER-015: the signed-out page renders before any session exists, outside the
// chat shell that defines --font-ui. It must name the app sans itself (with a
// literal fallback) and use the console-rail sheet-title row for its heading.
const HERE = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(HERE, 'HqWorkWorkShell.svelte'), 'utf8');
const prompt = readFileSync(join(HERE, '../components/SignInPrompt.svelte'), 'utf8');
const shellStyle = shell.slice(shell.lastIndexOf('<style'));
const promptStyle = prompt.slice(prompt.lastIndexOf('<style'));

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match![1];
}

describe('signed-out page typography (OWNER-015)', () => {
  it('sets the app sans on the page with a sans-serif fallback', () => {
    const page = rule(shellStyle, '.lifecycle-state');
    expect(page).toMatch(/font-family:\s*var\(--font-sans,[^;]*"Geist"[^;]*sans-serif\)/);
    expect(page).toMatch(/font-size:\s*13px/);
    expect(rule(promptStyle, '.sign-in-container')).toMatch(
      /font-family:\s*var\(--font-sans,[^;]*sans-serif\)/,
    );
  });

  it('sizes the heading on the sheet-title row: 15px / 600', () => {
    const heading = rule(shellStyle, '.lifecycle-state h1');
    expect(heading).toMatch(/font-size:\s*15px/);
    expect(heading).toMatch(/font-weight:\s*600/);
  });

  it('keeps Retry inside the sign-in card, not floating below it', () => {
    const start = shell.indexOf('data-testid="hq-work-signed-out"');
    const block = shell.slice(start, shell.indexOf('</section>', start));
    expect(block).toContain('onretry=');
    expect(block).not.toMatch(/<button[^>]*>Retry<\/button>/);
  });

  it('builds labelled buttons to the 36px rail spec', () => {
    const button = rule(promptStyle, '.sign-in-btn');
    expect(button).toMatch(/height:\s*36px/);
    expect(button).toMatch(/padding:\s*0 16px/);
    expect(button).toMatch(/font-size:\s*12px/);
    expect(button).toMatch(/font-weight:\s*500/);
  });
});

describe('signed-out sign-in card type (AUDIT-3)', () => {
  it('sizes text in px so the 15px shell root cannot make fractional sizes', () => {
    expect(promptStyle).not.toMatch(/font-size:\s*[\d.]+rem/);
  });

  it('keeps the card heading at weight 500 or less', () => {
    const heading = rule(promptStyle, 'h1');
    const weight = Number(heading.match(/font-weight:\s*(\d+)/)?.[1] ?? 400);
    expect(weight).toBeLessThanOrEqual(500);
  });

  it('names the app HQ in the quit control, as the tray menu does', () => {
    expect(prompt).not.toContain('Quit HQ Sync');
  });
});

describe('signed-out page copy (AUDIT-3)', () => {
  it('uses the app name HQ, not the internal HQ Work name', () => {
    const start = shell.indexOf('data-testid="hq-work-signed-out"');
    const block = shell.slice(start, shell.indexOf('</section>', start));
    expect(block).not.toMatch(/HQ Work\b/);
    expect(block).not.toMatch(/fleet agent/);
  });
});

describe('signed-out page heading (OWNER-D 5, AUDIT-3-20)', () => {
  it('has no page heading of its own; the sign-in card carries the one title', () => {
    const start = shell.indexOf('data-testid="hq-work-signed-out"');
    const block = shell.slice(start, shell.indexOf('</section>', start));
    expect(block).not.toMatch(/<h[1-6]\b/);
    expect(block).not.toContain('You are signed out');
    expect(block).toContain('<SignInPrompt');
    expect(prompt).toContain("'Sign in to HQ'");
  });
});
