// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { pickerBounds, positionPicker } from './picker-position';
describe('project picker viewport placement', () => {
  it('escapes clipping ancestors via the top layer and clears opposing CSS insets', () => {
    const parent = document.createElement('div');
    parent.style.transform = 'translateX(200px)';
    parent.style.overflow = 'hidden';
    const menu = document.createElement('div');
    parent.append(menu); document.body.append(parent);
    const show = vi.fn(); const hide = vi.fn();
    menu.showPopover = show; menu.hidePopover = hide;
    parent.getBoundingClientRect = () => ({ left: window.innerWidth - 50, top: 400 }) as DOMRect;
    const action = positionPicker(menu, false);
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(show).toHaveBeenCalledOnce();
    expect(menu.style.right).toBe('auto');
    expect(menu.style.margin).toBe('0px');
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 12);
    action.destroy(); expect(hide).toHaveBeenCalledOnce(); parent.remove();
  });
  it('shifts a right-edge trigger left without cutting off the popup', () => {
    const b = pickerBounds({ left: 900, top: 640 }, { width: 1100, height: 800 }, true);
    expect(b.left + b.width).toBeLessThanOrEqual(1088);
    expect(b.left).toBeGreaterThanOrEqual(12);
    expect(800 - b.bottom - b.maxHeight).toBeGreaterThanOrEqual(12);
  });
  it('shrinks to fit a narrow, short window', () => {
    const b = pickerBounds({ left: 210, top: 180 }, { width: 320, height: 300 }, true);
    expect(b.width).toBe(296);
    expect(b.left).toBe(12);
    expect(b.maxHeight).toBe(162);
  });
});
