import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const wizardSource = readFileSync(new URL('./OnboardingWizard.svelte', import.meta.url), 'utf8');

describe('onboarding launch handoff', () => {
  it('finishes onboarding after each supported launcher opens', () => {
    expect(wizardSource.match(/await onfinish\?\.\(\);/g)).toHaveLength(5);
    expect(wizardSource).not.toContain('advanceTo(4)');
  });

  it('renders exactly one ready-panel bottom-row button and removes Finish', () => {
    const marker = wizardSource.indexOf('data-testid="onboarding-summary"');
    const panel = wizardSource.slice(
      wizardSource.lastIndexOf('<section', marker),
      wizardSource.indexOf('</section>', marker),
    );
    const row = panel?.match(/<div class="btns">[\s\S]*?<\/div>/)?.[0];
    expect(row?.match(/<button\b/g)).toHaveLength(1);
    expect(row).toContain('class="btn btn-primary"');
    expect(row).not.toContain('Finish');
  });

  it('uses the injected timer cadence for download watching and deep-linking', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ installed: true, logged_in: true });
    const interval = setInterval(() => void poll(), 3000);
    await vi.advanceTimersByTimeAsync(3000);
    clearInterval(interval);
    expect(poll).toHaveBeenCalledOnce();
    expect(wizardSource).toContain("invoke<ClaudeReady>('detect_claude_ready')");
    expect(wizardSource).toContain("invoke('open_claude_code_link', { url })");
    expect(wizardSource).toContain("buildClaudeCodeUrl({ folder: installPath ?? '', prompt: '/setup' })");
    vi.useRealTimers();
  });
});
