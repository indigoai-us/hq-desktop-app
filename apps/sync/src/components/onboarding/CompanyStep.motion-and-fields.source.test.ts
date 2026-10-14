// Two reported faults on the company screens, pinned as source contracts
// because neither shows up in the test DOM (no Web Animations, no :hover).
//
// 1. "I can see the text of the next step before the current step fades out."
//    The leaving copy faded over 600ms while the new screen started rising at
//    0.3s, so both screens showed text at once. The new screen's entrance now
//    waits for the old one to finish fading.
// 2. Hovering the focused email box dropped its bright focus border to the dim
//    hover one. The box is a `.field` wrapper around the real input, so it is
//    focused through `:focus-within`, which the field rules did not cover.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const step = readFileSync(resolve(process.cwd(), 'src/components/onboarding/CompanyStep.svelte'), 'utf8');
const welcomeCss = readFileSync(
  resolve(process.cwd(), 'src/components/onboarding/welcome/welcome.css'),
  'utf8',
);

function constMs(name: string): number {
  const match = step.match(new RegExp(`const ${name} = (\\d+);`));
  expect(match, `${name} is declared`).not.toBeNull();
  return Number(match![1]);
}

describe('company screen change', () => {
  it('starts the new screen only once the old one has faded out', () => {
    const leave = constMs('LEAVE_MS');
    const wait = constMs('LEAVE_WAIT_MS');
    expect(step).toContain('duration: LEAVE_MS');
    expect(step).toContain('leavingUntil = performance.now() + LEAVE_MS;');
    expect(step).toContain("root.style.setProperty('--cs-wait', `${wait}ms`)");
    // The earliest part of the new screen rises at 0.3s + the wait.
    expect(step).toMatch(/\.cs-pane > \* \{\s*animation: cs-rise [^;]*calc\(var\(--cs-wait, 0s\) \+ 0\.3s\)/);
    expect(300 + wait).toBeGreaterThanOrEqual(leave);
  });

  it('delays every later entrance by the same wait', () => {
    for (const delay of ['0.42s', '0.56s', '0.7s', '0.84s', '1.1s']) {
      expect(step).toContain(`calc(var(--cs-wait, 0s) + ${delay})`);
    }
    // No entrance keeps a bare delay that would ignore the wait.
    expect(step).not.toMatch(/\.cs-pane > [^{]*\{\s*animation-delay: \d/);
  });
});

describe('field states', () => {
  it('keeps the focus border while a focused wrapper field is hovered', () => {
    const focusRule = welcomeCss.match(/((?:\.hq-welcome [^{,]+,\s*)*\.hq-welcome [^{,]+)\{\s*outline: none;\s*border-color: rgba\(255, 255, 255, 0\.72\);/);
    expect(focusRule).not.toBeNull();
    const selectors = focusRule![1].split(',').map((s) => s.trim());
    expect(selectors).toContain('.hq-welcome .field:focus-within');
    expect(selectors).toContain('.hq-welcome .field:focus-within:hover');
  });

  it('still shows a problem on the email box over hover and focus', () => {
    expect(step).toContain(':global(.hq-welcome) .cs-chips.has-problem:hover');
    expect(step).toContain(':global(.hq-welcome) .cs-chips.has-problem:focus-within');
  });
});

describe('the "Setting up" mark', () => {
  // Its breathing replaced the shared entrance, so it showed at once while the
  // rest of the screen rose, and flashed as a copy when the screen was skipped.
  it('rises in with its screen before it starts breathing', () => {
    expect(step).toMatch(
      /\.cs-mark\.working \{\s*animation:\s*cs-rise 0\.9s cubic-bezier\([^)]*\) calc\(var\(--cs-wait, 0s\) \+ 0\.3s\) both,\s*cs-breathe [^;]*infinite;/,
    );
  });
});
