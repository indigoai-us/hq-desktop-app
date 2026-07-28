import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wizardSource = readFileSync(
  new URL('./OnboardingWizard.svelte', import.meta.url),
  'utf8',
);

describe('onboarding launch handoff', () => {
  it('finishes onboarding after Claude Code or Codex opens', () => {
    // Six `await onfinish?.()` sites total: three are the launch-handoff paths
    // (Claude Code / Codex / the manual finish flows), and three were added by
    // the US-005 re-prompt mode (answer, dismiss, and the offline finish), which
    // closes the consent step directly instead of advancing to a ready screen
    // that does not exist in that mode.
    expect(wizardSource.match(/await onfinish\?\.\(\);/g)).toHaveLength(6);
    expect(wizardSource).not.toContain('advanceTo(4)');
  });

  it('offers Finish instead of continuing into post-launch instructions', () => {
    expect(wizardSource).toContain('onclick={() => void onfinish?.()}');
    expect(wizardSource).toContain('>Finish</button>');
  });

  it('warns that setup requires opening HQ in an AI tool and running /setup', () => {
    expect(wizardSource).toContain('class="setup-caution"');
    expect(wizardSource).toContain('Complete setup in Claude Code or Codex');
    expect(wizardSource).toContain('Open the HQ folder and run <code>/setup</code>.');
    expect(wizardSource).toContain('Choose Finish only if you want to do this later.');
  });
});
