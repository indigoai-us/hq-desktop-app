import { describe, expect, it } from 'vitest';
import { friendlyPath, homeDirFromDefaultHqPath } from './onboarding-path';

describe('friendlyPath', () => {
  it('collapses a POSIX home prefix', () => {
    expect(friendlyPath('/Users/ada/hq', '/Users/ada')).toBe('~/hq');
    expect(friendlyPath('/Users/ada/Documents/HQ', '/Users/ada/')).toBe('~/Documents/HQ');
  });

  it('collapses the home directory itself', () => {
    expect(friendlyPath('/Users/ada/', '/Users/ada')).toBe('~');
  });

  it('does not collapse a partial home prefix match', () => {
    expect(friendlyPath('/Users/ada-work/hq', '/Users/ada')).toBe('/Users/ada-work/hq');
  });

  it('handles Windows-style paths', () => {
    expect(friendlyPath('C:\\Users\\Ada\\hq', 'C:\\Users\\Ada')).toBe('~\\hq');
    expect(friendlyPath('C:\\Users\\Ada2\\hq', 'C:\\Users\\Ada')).toBe('C:\\Users\\Ada2\\hq');
  });

  it('returns a trimmed absolute path when no home directory is known', () => {
    expect(friendlyPath('  /opt/hq/  ', null)).toBe('/opt/hq');
  });
});

describe('homeDirFromDefaultHqPath', () => {
  it('derives the home directory from a default HQ path', () => {
    expect(homeDirFromDefaultHqPath('/Users/ada/hq')).toBe('/Users/ada');
    expect(homeDirFromDefaultHqPath('C:\\Users\\Ada\\HQ')).toBe('C:\\Users\\Ada');
  });

  it('returns null for non-default-looking paths', () => {
    expect(homeDirFromDefaultHqPath('/Users/ada/projects')).toBeNull();
    expect(homeDirFromDefaultHqPath('hq')).toBeNull();
  });
});
