import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../lib/workspaces';
import {
  companySlugForHqPath,
  dirEntryToLazyNode,
  fileAccessibleCompanies,
  fileTreeRowMeta,
  filesScopeRootPath,
  filterLazyNodes,
  filterFileEntriesForMembership,
  flattenLazy,
  flattenTree,
  isFilesRouteAllowed,
  isRootNotFoundError,
  knowledgeRootPath,
  parentPathOf,
  sortNodes,
  type DirEntry,
  type FileNode,
  type LazyNode,
} from './file-tree';

/**
 * US-006 — Frontend unit tests for the pure company-file-tree helpers.
 *
 * Covers the contract deferred from US-002:
 *   - sortNodes: folders-before-files, case-insensitive alphabetical within each
 *     group, recursive into children, and purity (no input mutation).
 *   - flattenTree: depth tracking + path flattening in display order, honoring
 *     the isExpanded predicate (collapsed dirs hide their subtree).
 *
 * These are dependency-free pure functions (no Svelte runes, no Tauri), so the
 * tests import the real module and assert on data only.
 */

/** Convenience constructor for a leaf file node. */
function file(name: string, path: string): FileNode {
  return { name, path, isDir: false, children: [] };
}

/** Convenience constructor for a directory node. */
function dir(name: string, path: string, children: FileNode[] = []): FileNode {
  return { name, path, isDir: true, children };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'indigo',
    displayName: 'Indigo',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cmp_indigo',
    bucketName: 'indigo-bucket',
    hasLocalFolder: true,
    localPath: '/tmp/HQ/companies/indigo',
    membershipStatus: 'active',
    role: 'member',
    syncEnabled: true,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

describe('Files membership boundary', () => {
  const active = workspace();
  const pending = workspace({
    slug: 'sender-agency',
    displayName: 'Sender Agency',
    state: 'cloud-only',
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: 'pending',
    role: null,
  });

  it('keeps pending invites out of company filters while retaining accepted companies', () => {
    const localOnly = workspace({
      slug: 'local-notebook',
      displayName: 'Local Notebook',
      state: 'local-only',
      cloudUid: null,
      bucketName: null,
      membershipStatus: null,
    });
    const companies = fileAccessibleCompanies([
      active,
      pending,
      workspace({ slug: 'paused', membershipStatus: 'paused' }),
      workspace({ slug: 'offline-cloud', membershipStatus: null }),
      localOnly,
      workspace({ slug: 'personal', kind: 'personal', state: 'personal' }),
    ]);
    expect(companies.map((company) => company.slug)).toEqual(['indigo', 'local-notebook']);
  });

  it('extracts company slugs only from company-scoped HQ paths', () => {
    expect(companySlugForHqPath('companies/indigo/knowledge/overview.md')).toBe('indigo');
    expect(companySlugForHqPath('./companies/sender-agency')).toBe('sender-agency');
    expect(companySlugForHqPath('personal/knowledge/overview.md')).toBeNull();
  });

  it('rejects traversal, absolute, backslash, and ambiguous HQ paths before resolving a company', () => {
    expect(companySlugForHqPath('companies/indigo/../sender-agency/secret.md')).toBeNull();
    expect(companySlugForHqPath('companies\\sender-agency\\secret.md')).toBeNull();
    expect(companySlugForHqPath('/companies/sender-agency/secret.md')).toBeNull();
    expect(companySlugForHqPath('C:/companies/sender-agency/secret.md')).toBeNull();
    expect(companySlugForHqPath('companies//sender-agency/secret.md')).toBeNull();
  });

  it('rejects pending, unknown, mismatched, and escaped company file routes', () => {
    const workspaces = [active, pending];
    expect(isFilesRouteAllowed({ slug: 'indigo' }, workspaces)).toBe(true);
    expect(
      isFilesRouteAllowed(
        { slug: 'indigo', path: 'companies/indigo/knowledge/overview.md' },
        workspaces,
      ),
    ).toBe(true);
    expect(isFilesRouteAllowed({ slug: 'sender-agency' }, workspaces)).toBe(false);
    expect(
      isFilesRouteAllowed(
        { path: 'companies/sender-agency/knowledge/overview.md' },
        workspaces,
      ),
    ).toBe(false);
    expect(
      isFilesRouteAllowed(
        { slug: 'indigo', path: 'companies/other/overview.md' },
        workspaces,
      ),
    ).toBe(false);
    expect(
      isFilesRouteAllowed({ slug: 'indigo', path: 'personal/overview.md' }, workspaces),
    ).toBe(false);
    expect(
      isFilesRouteAllowed(
        {
          slug: 'indigo',
          path: 'companies/indigo/../sender-agency/secret.md',
        },
        workspaces,
      ),
    ).toBe(false);
    expect(
      isFilesRouteAllowed(
        { slug: 'indigo', path: 'companies\\indigo\\knowledge\\overview.md' },
        workspaces,
      ),
    ).toBe(false);
    expect(
      isFilesRouteAllowed(
        { slug: 'indigo', path: '/companies/indigo/knowledge/overview.md' },
        workspaces,
      ),
    ).toBe(false);
    expect(isFilesRouteAllowed({ slug: '../sender-agency' }, workspaces)).toBe(false);
  });

  it('filters pending and unknown company folders from HQ-root lazy results', () => {
    const entries: DirEntry[] = [
      { name: 'indigo', path: 'companies/indigo', isDir: true, hasChildren: true },
      {
        name: 'sender-agency',
        path: 'companies/sender-agency',
        isDir: true,
        hasChildren: true,
      },
      { name: 'unknown', path: 'companies/unknown', isDir: true, hasChildren: true },
      {
        name: 'escaped',
        path: 'companies/indigo/../sender-agency',
        isDir: true,
        hasChildren: true,
      },
      { name: 'personal', path: 'personal', isDir: true, hasChildren: true },
    ];
    expect(
      filterFileEntriesForMembership(entries, [active, pending]).map((entry) => entry.path),
    ).toEqual(['companies/indigo', 'personal']);
  });
});

describe('file-tree sortNodes (US-006)', () => {
  it('sorts folders before files', () => {
    const input: FileNode[] = [
      file('readme.md', 'companies/test/readme.md'),
      dir('policies', 'companies/test/policies'),
      file('config.json', 'companies/test/config.json'),
      dir('data', 'companies/test/data'),
    ];

    const sorted = sortNodes(input);

    // All directories must come before any file, regardless of name.
    const firstFileIndex = sorted.findIndex((n) => !n.isDir);
    const lastDirIndex = sorted.map((n) => n.isDir).lastIndexOf(true);
    expect(lastDirIndex).toBeLessThan(firstFileIndex);

    expect(sorted.map((n) => n.name)).toEqual([
      'data',
      'policies',
      'config.json',
      'readme.md',
    ]);
  });

  it('sorts alphabetically (case-insensitive) within each group', () => {
    const input: FileNode[] = [
      dir('Zebra', 'companies/test/Zebra'),
      dir('alpha', 'companies/test/alpha'),
      file('Banana.txt', 'companies/test/Banana.txt'),
      file('apple.txt', 'companies/test/apple.txt'),
    ];

    const sorted = sortNodes(input);

    // Folders: alpha before Zebra (case-insensitive). Files: apple before Banana.
    expect(sorted.map((n) => n.name)).toEqual([
      'alpha',
      'Zebra',
      'apple.txt',
      'Banana.txt',
    ]);
  });

  it('sorts recursively into children', () => {
    const input: FileNode[] = [
      dir('root', 'companies/test/root', [
        file('b.txt', 'companies/test/root/b.txt'),
        dir('sub', 'companies/test/root/sub'),
        file('a.txt', 'companies/test/root/a.txt'),
      ]),
    ];

    const sorted = sortNodes(input);
    const childNames = sorted[0].children.map((n) => n.name);

    // Directory (sub) first, then files alphabetically (a.txt, b.txt).
    expect(childNames).toEqual(['sub', 'a.txt', 'b.txt']);
  });

  it('does not mutate the input array or input nodes (pure)', () => {
    const child = file('a.txt', 'companies/test/root/a.txt');
    const root = dir('root', 'companies/test/root', [
      file('b.txt', 'companies/test/root/b.txt'),
      child,
    ]);
    const input: FileNode[] = [
      file('z.txt', 'companies/test/z.txt'),
      root,
    ];
    const snapshotOrder = input.map((n) => n.name);
    const snapshotChildOrder = root.children.map((n) => n.name);

    const sorted = sortNodes(input);

    // Original arrays are untouched.
    expect(input.map((n) => n.name)).toEqual(snapshotOrder);
    expect(root.children.map((n) => n.name)).toEqual(snapshotChildOrder);
    // Returned nodes are fresh objects, not the same references.
    expect(sorted).not.toBe(input);
    const sortedRoot = sorted.find((n) => n.name === 'root')!;
    expect(sortedRoot).not.toBe(root);
    expect(sortedRoot.children).not.toBe(root.children);
  });

  it('handles missing children arrays without throwing', () => {
    // A node whose children is undefined (defensive — Rust always sends []).
    const input = [
      { name: 'orphan', path: 'companies/test/orphan', isDir: true } as FileNode,
    ];
    const sorted = sortNodes(input);
    expect(sorted[0].children).toEqual([]);
  });
});

describe('file-tree flattenTree (US-006)', () => {
  const tree: FileNode[] = [
    dir('companies/test', 'companies/test', [
      dir('policies', 'companies/test/policies', [
        file('foo.md', 'companies/test/policies/foo.md'),
      ]),
      file('readme.md', 'companies/test/readme.md'),
    ]),
  ];

  it('flattens to display order with depth and path tracking', () => {
    // Everything expanded.
    const rows = flattenTree(tree, () => true);

    expect(rows.map((r) => ({ path: r.node.path, depth: r.depth }))).toEqual([
      { path: 'companies/test', depth: 0 },
      { path: 'companies/test/policies', depth: 1 },
      { path: 'companies/test/policies/foo.md', depth: 2 },
      { path: 'companies/test/readme.md', depth: 1 },
    ]);
  });

  it('hides a collapsed directory subtree', () => {
    // Only the root is expanded; companies/test/policies is collapsed, so its
    // child foo.md must not appear.
    const expanded = new Set(['companies/test']);
    const rows = flattenTree(tree, (p) => expanded.has(p));

    expect(rows.map((r) => r.node.path)).toEqual([
      'companies/test',
      'companies/test/policies',
      'companies/test/readme.md',
    ]);
    expect(rows.map((r) => r.node.path)).not.toContain(
      'companies/test/policies/foo.md',
    );
  });

  it('flattens folders-before-files at every level', () => {
    const unsorted: FileNode[] = [
      file('z.txt', 'companies/test/z.txt'),
      dir('a-dir', 'companies/test/a-dir', [
        file('inner.txt', 'companies/test/a-dir/inner.txt'),
      ]),
    ];
    const rows = flattenTree(unsorted, () => true);

    // Directory row emitted before the sibling file, with its child nested.
    expect(rows.map((r) => r.node.path)).toEqual([
      'companies/test/a-dir',
      'companies/test/a-dir/inner.txt',
      'companies/test/z.txt',
    ]);
  });

  it('respects a non-zero starting depth', () => {
    const rows = flattenTree(
      [file('a.txt', 'companies/test/a.txt')],
      () => true,
      3,
    );
    expect(rows[0].depth).toBe(3);
  });
});

describe('file-tree lazy helpers (US-010)', () => {
  function entry(overrides: Partial<DirEntry>): DirEntry {
    return {
      name: 'x',
      path: 'x',
      isDir: false,
      hasChildren: false,
      ...overrides,
    };
  }

  /** Convenience: a loaded lazy directory node with children. */
  function lazyDir(
    name: string,
    path: string,
    children: LazyNode[] | undefined = undefined,
  ): LazyNode {
    return {
      name,
      path,
      isDir: true,
      hasChildren: true,
      loaded: children !== undefined,
      children,
    };
  }

  function lazyFile(name: string, path: string): LazyNode {
    return { name, path, isDir: false, hasChildren: false, loaded: false };
  }

  it('dirEntryToLazyNode maps a DirEntry to an unloaded node', () => {
    const node = dirEntryToLazyNode(
      entry({ name: 'repos', path: 'repos', isDir: true, hasChildren: true }),
    );
    expect(node).toEqual({
      name: 'repos',
      path: 'repos',
      isDir: true,
      hasChildren: true,
      loaded: false,
      children: undefined,
    });
  });

  it('clears hasChildren for files (only dirs can be expandable)', () => {
    const node = dirEntryToLazyNode(
      // A backend that erroneously set hasChildren on a file must not produce
      // an expandable file row.
      entry({ name: 'README.md', path: 'README.md', isDir: false, hasChildren: true }),
    );
    expect(node.hasChildren).toBe(false);
  });

  it('flattenLazy emits only loaded+expanded subtrees (lazy: unloaded dirs show no children)', () => {
    const tree: LazyNode[] = [
      // Loaded + has a child.
      lazyDir('companies', 'companies', [lazyFile('manifest.yaml', 'companies/manifest.yaml')]),
      // hasChildren but NOT loaded yet → no children even if "expanded".
      lazyDir('repos', 'repos', undefined),
    ];
    const expanded = new Set(['companies', 'repos']);
    const rows = flattenLazy(tree, (p) => expanded.has(p));

    expect(rows.map((r) => ({ path: r.node.path, depth: r.depth }))).toEqual([
      { path: 'companies', depth: 0 },
      { path: 'companies/manifest.yaml', depth: 1 },
      // repos is expanded but unloaded → no children rows yet (lazy).
      { path: 'repos', depth: 0 },
    ]);
  });

  it('flattenLazy hides a collapsed (loaded) directory subtree', () => {
    const tree: LazyNode[] = [
      lazyDir('core', 'core', [lazyFile('core.yaml', 'core/core.yaml')]),
    ];
    // Not expanded → child hidden even though it is loaded.
    const rows = flattenLazy(tree, () => false);
    expect(rows.map((r) => r.node.path)).toEqual(['core']);
  });

  it('flattenLazy sorts folders-before-files, case-insensitive alphabetical', () => {
    const tree: LazyNode[] = [
      lazyFile('zeta.txt', 'zeta.txt'),
      lazyDir('Beta', 'Beta'),
      lazyDir('alpha', 'alpha'),
      lazyFile('Apple.txt', 'Apple.txt'),
    ];
    const rows = flattenLazy(tree, () => false);
    expect(rows.map((r) => r.node.name)).toEqual([
      'alpha',
      'Beta',
      'Apple.txt',
      'zeta.txt',
    ]);
  });

  it('flattenLazy tracks depth across nested loaded dirs', () => {
    const tree: LazyNode[] = [
      lazyDir('repos', 'repos', [
        lazyDir('public', 'repos/public', [
          lazyFile('hq-sync', 'repos/public/hq-sync'),
        ]),
      ]),
    ];
    const expanded = new Set(['repos', 'repos/public']);
    const rows = flattenLazy(tree, (p) => expanded.has(p));
    expect(rows.map((r) => ({ path: r.node.path, depth: r.depth }))).toEqual([
      { path: 'repos', depth: 0 },
      { path: 'repos/public', depth: 1 },
      { path: 'repos/public/hq-sync', depth: 2 },
    ]);
  });

  it('filterLazyNodes keeps matching files and ancestor dirs (DESKTOP-008)', () => {
    const tree: LazyNode[] = [
      lazyDir('policies', 'companies/x/knowledge/policies', [
        lazyFile('security.md', 'companies/x/knowledge/policies/security.md'),
        lazyFile('readme.md', 'companies/x/knowledge/policies/readme.md'),
      ]),
      lazyFile('overview.md', 'companies/x/knowledge/overview.md'),
    ];
    const filtered = filterLazyNodes(tree, 'sec');
    expect(filtered.map((n) => n.path)).toEqual([
      'companies/x/knowledge/policies',
    ]);
    expect(filtered[0]?.children?.map((c) => c.path)).toEqual([
      'companies/x/knowledge/policies/security.md',
    ]);
  });

  it('filterLazyNodes is case-insensitive and empty query is identity', () => {
    const tree: LazyNode[] = [
      lazyFile('Brand.md', 'companies/x/knowledge/Brand.md'),
      lazyFile('notes.txt', 'companies/x/knowledge/notes.txt'),
    ];
    expect(filterLazyNodes(tree, '')).toEqual(tree);
    expect(filterLazyNodes(tree, '  brand  ').map((n) => n.name)).toEqual(['Brand.md']);
  });

  it('filterLazyNodes does not mutate input', () => {
    const tree: LazyNode[] = [
      lazyDir('a', 'a', [lazyFile('hit.md', 'a/hit.md'), lazyFile('miss.md', 'a/miss.md')]),
    ];
    const before = JSON.stringify(tree);
    filterLazyNodes(tree, 'hit');
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('parentPathOf returns the parent HQ-relative segment', () => {
    expect(parentPathOf('companies/x/knowledge/a.md')).toBe('companies/x/knowledge');
    expect(parentPathOf('readme.md')).toBe('');
  });
});

describe('file-tree row metadata', () => {
  it('omits the filesystem dot sentinel for direct children of a scoped root', () => {
    const rootPath = 'companies/boring-ecom/knowledge';

    expect(
      fileTreeRowMeta(
        {
          path: `${rootPath}/agents`,
          isDir: true,
        },
        rootPath,
      ),
    ).toBeNull();
    expect(
      fileTreeRowMeta(
        {
          path: `${rootPath}/README.md`,
          isDir: false,
        },
        rootPath,
      ),
    ).toBeNull();
  });

  it('keeps meaningful relative ancestry for nested rows', () => {
    const rootPath = 'companies/boring-ecom/knowledge';

    expect(
      fileTreeRowMeta(
        {
          path: `${rootPath}/agents/README.md`,
          isDir: false,
        },
        rootPath,
      ),
    ).toBe('agents');
  });

  it('keeps type metadata for top-level rows in the unscoped HQ tree', () => {
    expect(fileTreeRowMeta({ path: 'companies', isDir: true }, '')).toBe('Folder');
    expect(fileTreeRowMeta({ path: 'README.md', isDir: false }, '')).toBe('File');
  });
});

describe('workspace root paths (knowledge-path fixes)', () => {
  it('company slugs root knowledge under the company knowledge subtree', () => {
    expect(knowledgeRootPath('acme')).toBe('companies/acme/knowledge');
    expect(knowledgeRootPath('acme-labs')).toBe('companies/acme-labs/knowledge');
  });

  it('the personal workspace roots knowledge at the HQ-root personal/knowledge', () => {
    expect(knowledgeRootPath('personal')).toBe('personal/knowledge');
  });

  it('company slugs scope Files mode to the company subtree', () => {
    expect(filesScopeRootPath('acme')).toBe('companies/acme');
  });

  it('the personal workspace scopes Files mode to the HQ-root personal tree', () => {
    expect(filesScopeRootPath('personal')).toBe('personal');
  });

  it('a slug merely starting with personal is NOT the personal workspace', () => {
    expect(knowledgeRootPath('personalized')).toBe('companies/personalized/knowledge');
    expect(filesScopeRootPath('personalized')).toBe('companies/personalized');
  });
});

describe('isRootNotFoundError (missing-root empty state)', () => {
  it('classifies the list_dir_entries missing-directory shape', () => {
    expect(
      isRootNotFoundError('directory not found: "companies/acme/knowledge"'),
    ).toBe(true);
  });

  it('classifies the canonicalization ENOENT shape (unix)', () => {
    expect(
      isRootNotFoundError(
        'could not resolve "companies/acme/knowledge": No such file or directory (os error 2)',
      ),
    ).toBe(true);
  });

  it('classifies the canonicalization not-found shapes (windows)', () => {
    expect(
      isRootNotFoundError(
        'could not resolve "companies/acme/knowledge": The system cannot find the file specified. (os error 2)',
      ),
    ).toBe(true);
    expect(
      isRootNotFoundError(
        'could not resolve "companies/acme/knowledge": The system cannot find the path specified. (os error 3)',
      ),
    ).toBe(true);
  });

  it('accepts Error objects as well as strings', () => {
    expect(
      isRootNotFoundError(new Error('directory not found: "personal/knowledge"')),
    ).toBe(true);
    expect(isRootNotFoundError(new Error('company files are not authorized'))).toBe(false);
  });

  it('does NOT classify genuine failures as missing', () => {
    expect(
      isRootNotFoundError(
        'could not resolve "companies/acme/knowledge": Permission denied (os error 13)',
      ),
    ).toBe(false);
    expect(isRootNotFoundError('file explorer requires a signed-in user')).toBe(false);
    expect(isRootNotFoundError('path escapes the HQ folder: "../x"')).toBe(false);
    expect(isRootNotFoundError('could not read directory "x": Permission denied')).toBe(false);
    expect(isRootNotFoundError(null)).toBe(false);
    expect(isRootNotFoundError(undefined)).toBe(false);
    expect(isRootNotFoundError('')).toBe(false);
  });
});
