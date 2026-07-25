import { describe, expect, it } from 'vitest';
import { shareAclLabel, sharePathPrefix, shareTitle } from './share-path';

describe('shareTitle', () => {
  it('names the directory (with trailing slash) for a wildcard directory share', () => {
    // Regression: this used to collapse to the literal "*".
    expect(shareTitle('projects/client-stats-redesign/*')).toBe(
      'client-stats-redesign/',
    );
  });

  it('handles recursive `/**` directory shares', () => {
    expect(shareTitle('projects/foo/**')).toBe('foo/');
  });

  it('leaves plain file shares unchanged', () => {
    expect(shareTitle('docs/a.md')).toBe('a.md');
    expect(shareTitle('README.md')).toBe('README.md');
  });

  it('ignores a trailing slash on a directory path without a wildcard', () => {
    expect(shareTitle('projects/foo/')).toBe('foo');
  });

  it('falls back to "All files" for a whole-vault wildcard', () => {
    expect(shareTitle('*')).toBe('All files');
    expect(shareTitle('**')).toBe('All files');
  });
});

describe('sharePathPrefix', () => {
  it('returns the tenant-scoped path as received', () => {
    expect(sharePathPrefix('companies/indigo/docs/a.md')).toBe(
      'companies/indigo/docs/a.md',
    );
    expect(sharePathPrefix('projects/foo/*')).toBe('projects/foo/*');
  });

  it('labels whole-vault wildcards', () => {
    expect(sharePathPrefix('*')).toBe('All files (vault root)');
    expect(sharePathPrefix('**')).toBe('All files (vault root)');
  });
});

describe('shareAclLabel', () => {
  it('normalizes known permission tokens into ACL truth lines', () => {
    expect(shareAclLabel('read')).toBe('ACL: read');
    expect(shareAclLabel('VIEW')).toBe('ACL: read');
    expect(shareAclLabel('write')).toBe('ACL: write');
    expect(shareAclLabel('edit')).toBe('ACL: write');
    expect(shareAclLabel('admin')).toBe('ACL: admin');
  });

  it('returns null for empty permission and preserves unknown tokens', () => {
    expect(shareAclLabel(null)).toBeNull();
    expect(shareAclLabel('')).toBeNull();
    expect(shareAclLabel('  ')).toBeNull();
    expect(shareAclLabel('custom-grant')).toBe('ACL: custom-grant');
  });
});
