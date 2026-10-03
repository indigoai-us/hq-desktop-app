import type { Page } from '@playwright/test';

/**
 * QA-107: inner-box containment for sheets and modals. Every visible input and
 * control inside `rootSelector` must sit inside its parent's content box, sibling
 * inputs must not intersect, and every scroll body must not scroll sideways.
 * Returns one human-readable line per violation; an empty list means it fits.
 */
export async function innerFitViolations(page: Page, rootSelector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const roots = Array.from(document.querySelectorAll(selector));
    if (roots.length === 0) return [`no element matches ${selector}`];
    const out: string[] = [];
    const tol = 0.5;
    const name = (el: Element) => {
      const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-testid') || (el.textContent ?? '').trim().slice(0, 24);
      return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}[${label}]`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const contentBox = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const n = (v: string) => parseFloat(v) || 0;
      return {
        left: r.left + n(s.borderLeftWidth) + n(s.paddingLeft),
        right: r.right - n(s.borderRightWidth) - n(s.paddingRight),
      };
    };
    const controlSel = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select, button, [role="tab"], [role="combobox"]';
    for (const root of roots) {
      const all = [root, ...Array.from(root.querySelectorAll('*'))];
      for (const el of all) {
        if (!(el instanceof HTMLElement) || !visible(el)) continue;
        const s = getComputedStyle(el);
        if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
          out.push(`${name(el)} scrolls sideways: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
        }
      }
      const controls = Array.from(root.querySelectorAll(controlSel)).filter(visible);
      for (const el of controls) {
        const parent = el.parentElement;
        if (!parent || !visible(parent)) continue;
        const ps = getComputedStyle(parent);
        // Horizontal scrollers (tab strips, chip rows) own their overflow by design.
        if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') continue;
        const r = el.getBoundingClientRect();
        const cb = contentBox(parent);
        if (r.left < cb.left - tol || r.right > cb.right + tol) {
          out.push(`${name(el)} [${r.left.toFixed(1)}..${r.right.toFixed(1)}] outside ${name(parent)} content [${cb.left.toFixed(1)}..${cb.right.toFixed(1)}]`);
        }
      }
      const inputs = controls.filter((el) => el.matches('input, textarea, select'));
      for (let i = 0; i < inputs.length; i++) {
        for (let j = i + 1; j < inputs.length; j++) {
          if (inputs[i].parentElement !== inputs[j].parentElement) continue;
          const a = inputs[i].getBoundingClientRect();
          const b = inputs[j].getBoundingClientRect();
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > tol && h > tol) out.push(`${name(inputs[i])} intersects ${name(inputs[j])} by ${w.toFixed(1)}px`);
        }
      }
    }
    return out;
  }, rootSelector);
}
