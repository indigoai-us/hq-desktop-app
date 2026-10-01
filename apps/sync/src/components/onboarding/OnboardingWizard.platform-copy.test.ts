import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const wizard = readFileSync(fileURLToPath(new URL('./OnboardingWizard.svelte', import.meta.url)), 'utf8');
const styles = readFileSync(fileURLToPath(new URL('./welcome/welcome.css', import.meta.url)), 'utf8');

describe('onboarding AI-tool status layout and platform copy', () => {
  it('uses the detected host noun and stacks the status with its retry action', () => {
    expect(wizard.includes('Checking for AI tools on {thisComputer}')).toBe(true);
    expect(wizard.includes('We couldn’t check for AI tools on {thisComputer}')).toBe(true);
    expect(wizard.includes('class="tool-pills tool-pills-status ai-tools-status-stack"')).toBe(true);
    expect(styles.includes('.tool-pills.tool-pills-status.ai-tools-status-stack')).toBe(true);
    expect(/\.ai-tools-status-stack\s*\{[^}]*flex-direction:\s*column/s.test(styles)).toBe(true);
  });
});
