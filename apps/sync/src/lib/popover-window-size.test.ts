import { describe, expect, it } from 'vitest';
import {
  POPOVER_MAX_HEIGHT,
  POPOVER_MIN_HEIGHT,
  clampPopoverHeight,
  isPopoverResizeWindow,
  measuredSurfaceContentHeight,
  shouldResizePopoverWindow,
} from './popover-window-size';

describe('popover window sizing helpers', () => {
  it('measures the content wrapper height instead of the current viewport height', () => {
    // Regression: when the transparent Tauri window is still taller than the
    // first painted card, using the outer 100vh/root height preserves the
    // bottom gap. The resize target must come from the content wrapper.
    expect(measuredSurfaceContentHeight({ contentScrollHeight: 318 })).toBe(318);
  });

  it('includes floating menu content that sits outside normal flow', () => {
    expect(
      measuredSurfaceContentHeight({
        contentScrollHeight: 280,
        floatingBottom: 356.2,
      }),
    ).toBe(357);
  });

  it('clamps the measured content height to the popover window bounds', () => {
    expect(clampPopoverHeight(120)).toBe(POPOVER_MIN_HEIGHT);
    expect(clampPopoverHeight(333.1)).toBe(334);
    expect(clampPopoverHeight(900)).toBe(POPOVER_MAX_HEIGHT);
    expect(clampPopoverHeight(Number.NaN)).toBe(POPOVER_MIN_HEIGHT);
  });

  it('ignores sub-pixel resize churn', () => {
    expect(shouldResizePopoverWindow(300.9, 300)).toBe(false);
    expect(shouldResizePopoverWindow(302, 300)).toBe(true);
  });
});

describe('isPopoverResizeWindow (HQ-DESKTOP-38)', () => {
  it('only the main menubar window may resize itself', () => {
    expect(isPopoverResizeWindow('main')).toBe(true);
  });

  it('secondary windows that reuse the popover must not resize (no set-size ACL)', () => {
    expect(isPopoverResizeWindow('new-files-detail')).toBe(false);
    expect(isPopoverResizeWindow('messages')).toBe(false);
    expect(isPopoverResizeWindow('dm-detail')).toBe(false);
    expect(isPopoverResizeWindow('widget')).toBe(false);
  });
});
