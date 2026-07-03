import { describe, expect, it } from 'vitest';
import { shouldShowMeetingsLoadingPlaceholder } from './meetingsLoadingGate';

describe('meetings loading placeholder gate', () => {
  it('drops the placeholder after primary meetings load while secondary work is still pending', () => {
    expect(shouldShowMeetingsLoadingPlaceholder(true, false, 0, 0)).toBe(true);
    expect(shouldShowMeetingsLoadingPlaceholder(true, true, 0, 0)).toBe(false);
  });

  it('does not hide already-rendered meeting content behind the placeholder', () => {
    expect(shouldShowMeetingsLoadingPlaceholder(true, false, 1, 0)).toBe(false);
    expect(shouldShowMeetingsLoadingPlaceholder(true, false, 0, 1)).toBe(false);
  });
});
