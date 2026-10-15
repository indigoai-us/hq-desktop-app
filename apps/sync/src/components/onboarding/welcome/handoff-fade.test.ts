// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/components/onboarding/welcome/welcome.css'), 'utf8');

/** The selector of the automatic handoff's fade rule. */
function handoffFadeSelector(): string {
  const match = css.match(/(\.hq-welcome \.s-ready\.on\[data-handoff\][^{]*)\{\s*opacity:\s*0;/);
  expect(match, 'handoff fade rule').not.toBeNull();
  return match![1].trim();
}

/** The ready scene as it stands during the handoff, waiting line showing. */
function readyScene(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hq-welcome';
  root.innerHTML = `
    <section class="scene s-ready on" data-handoff="">
      <div class="copy"><h2>HQ is ready.</h2></div>
      <div class="prog"><div class="pwrap"></div></div>
      <div class="nav ready-options on">
        <p class="ready-wait">
          <span class="ready-wait-line">Getting ready…</span>
          <button class="btn btn-secondary ready-wait-continue" disabled>Continue</button>
        </p>
        <div class="tool-pills"></div>
      </div>
    </section>`;
  document.body.replaceChildren(root);
  return root;
}

/** True when the element or any ancestor is faded by the rule. */
function faded(el: Element, selector: string): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.matches(selector)) return true;
  }
  return false;
}

describe('welcome ready scene: the automatic handoff fade', () => {
  it('keeps the "Getting ready" line visible while the desktop window takes over', () => {
    const selector = handoffFadeSelector();
    const root = readyScene();
    const line = root.querySelector('.ready-wait-line')!;
    expect(faded(line, selector)).toBe(false);
  });

  it('still fades the scene copy, the progress row, the greyed Continue and the other options', () => {
    const selector = handoffFadeSelector();
    const root = readyScene();
    for (const cls of ['.copy', '.prog', '.ready-wait-continue', '.tool-pills']) {
      expect(faded(root.querySelector(cls)!, selector), cls).toBe(true);
    }
  });
});
