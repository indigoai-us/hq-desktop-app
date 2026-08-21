import { describe, expect, it } from 'vitest';
import {
  friendlyPath,
  homeDirFromDefaultHqPath,
  toUserFacingPath,
} from './onboarding-path';

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

describe('toUserFacingPath', () => {
  it('strips the Windows verbatim prefix so Explorer and Claude can consume the path', () => {
    expect(toUserFacingPath(String.raw`\\?\C:\Users\person\hq`)).toBe(
      String.raw`C:\Users\person\hq`,
    );
    expect(toUserFacingPath(String.raw`\\?\C:\HQ Setup`)).toBe(String.raw`C:\HQ Setup`);
  });

  it('rewrites verbatim UNC paths to a normal UNC path', () => {
    expect(toUserFacingPath(String.raw`\\?\UNC\server\share\HQ`)).toBe(
      String.raw`\\server\share\HQ`,
    );
    expect(toUserFacingPath(String.raw`\\?\unc\server\share\HQ`)).toBe(
      String.raw`\\server\share\HQ`,
    );
  });

  it('leaves POSIX and already-normal Windows paths unchanged', () => {
    expect(toUserFacingPath('/Users/ada/hq')).toBe('/Users/ada/hq');
    expect(toUserFacingPath(String.raw`C:\Users\Ada\hq`)).toBe(String.raw`C:\Users\Ada\hq`);
    expect(toUserFacingPath('  C:\\Users\\Ada\\hq  ')).toBe(String.raw`C:\Users\Ada\hq`);
  });

  it('keeps the verbatim prefix when legacy Win32 cannot name the path', () => {
    expect(toUserFacingPath(String.raw`\\?\C:\COM1`)).toBe(String.raw`\\?\C:\COM1`);
    expect(toUserFacingPath(String.raw`\\?\C:\Users\person\CON.txt`)).toBe(
      String.raw`\\?\C:\Users\person\CON.txt`,
    );
    expect(toUserFacingPath(String.raw`\\?\C:\foo\..\bar`)).toBe(String.raw`\\?\C:\foo\..\bar`);
    expect(toUserFacingPath(String.raw`\\?\C:\HQ.\repo`)).toBe(String.raw`\\?\C:\HQ.\repo`);
    expect(toUserFacingPath(String.raw`\\?\C:\HQ \repo`)).toBe(String.raw`\\?\C:\HQ \repo`);
    const longLegacy = `C:\\${'a'.repeat(260)}`;
    const longVerbatim = `\\\\?\\${longLegacy}`;
    expect(toUserFacingPath(longVerbatim)).toBe(longVerbatim);
    const exactLegacy = `C:\\${'a'.repeat(257)}`;
    expect(exactLegacy.length).toBe(260);
    expect(toUserFacingPath(`\\\\?\\${exactLegacy}`)).toBe(`\\\\?\\${exactLegacy}`);
    const underMax = `C:\\${'a'.repeat(256)}`;
    expect(underMax.length).toBe(259);
    expect(toUserFacingPath(`\\\\?\\${underMax}`)).toBe(underMax);
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
