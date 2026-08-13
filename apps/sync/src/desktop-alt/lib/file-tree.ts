import type { Workspace } from '../../lib/workspaces';

/**
 * Pure helpers for the company file explorer (US-002).
 *
 * This module is the TypeScript half of the `get_company_file_tree` contract.
 * The Rust half lives in `src-tauri/src/commands/desktop_alt.rs` (struct
 * `FileNode` with `#[serde(rename_all = "camelCase")]`), so the wire payload
 * maps 1:1 onto the `FileNode` interface below.
 *
 * No Svelte runes and no Tauri here — just data and side-effect-free functions,
 * so the contract stays trivially unit-testable under vitest (the test itself is
 * US-006). The Rust side already sorts (dirs-before-files, case-insensitive
 * alphabetical), but `sortNodes` sorts again so the tree is independently
 * correct and robust to unsorted input.
 */

/**
 * One node in the company file tree.
 *
 * Mirrors the Rust `FileNode` struct exactly (camelCase on the wire):
 * - `name`     node display name; the root node's name is the company slug.
 * - `path`     HQ-folder-relative, forward-slash separated, e.g.
 *              `"companies/indigo/policies/foo.md"`.
 * - `isDir`    true for directories; files are leaves.
 * - `children` child nodes; files always have `[]`.
 */
export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

/**
 * One immediate child returned by the LAZY `list_hq_dir` command (US-010).
 *
 * Mirrors the Rust `DirEntry` struct (camelCase on the wire). Unlike
 * {@link FileNode} it is NOT recursive — `list_hq_dir` returns only one
 * directory's immediate children so the large HQ root (esp. `repos/`) is never
 * eagerly walked. `hasChildren` lets the UI show an expand chevron for
 * non-empty directories without fetching their contents first.
 */
export interface DirEntry {
  name: string;
  /** HQ-folder-relative, forward-slash separated (e.g. `repos/public`). */
  path: string;
  isDir: boolean;
  /** Directories: true iff they hold ≥1 non-noise child. Files: always false. */
  hasChildren: boolean;
}

/**
 * Reserved slug of the personal workspace. Its knowledge lives at the HQ ROOT
 * (`personal/knowledge`), NOT under `companies/personal/` — the backend
 * synthesizes the personal workspace row without a `companies/` directory
 * (see `src-tauri/src/commands/workspaces.rs`), so company-shaped paths for
 * this slug point at a tree that never exists.
 */
export const PERSONAL_WORKSPACE_SLUG = 'personal';

/**
 * Knowledge-tree root for a workspace slug.
 *
 * Companies keep knowledge at `companies/<slug>/knowledge`; the personal
 * workspace keeps it at `personal/knowledge` in the HQ root. Pure — the
 * lexical scope guard in CompanyKnowledgePanel derives from this same value so
 * root and guard can never disagree.
 */
export function knowledgeRootPath(slug: string): string {
  return slug === PERSONAL_WORKSPACE_SLUG
    ? 'personal/knowledge'
    : `companies/${slug}/knowledge`;
}

/**
 * Files-mode scope root for a workspace slug filter.
 *
 * Companies scope the tree to `companies/<slug>`; the personal workspace's
 * content root is the top-level `personal/` directory.
 */
export function filesScopeRootPath(slug: string): string {
  return slug === PERSONAL_WORKSPACE_SLUG ? 'personal' : `companies/${slug}`;
}

/**
 * Classify a directory-listing failure as "the directory does not exist"
 * (missing dir or dangling symlink) so the UI can render a calm empty state
 * instead of a scary load-failure row.
 *
 * The backend surfaces a missing directory through two error shapes:
 *  - `list_dir_entries` — `directory not found: "<path>"` (path exists check)
 *  - `canonical_hq_relative_path` — `could not resolve "<path>": <io error>`,
 *    where the io error is ENOENT/ENOTDIR-flavored (`No such file or
 *    directory (os error 2)` on unix; `The system cannot find the file/path
 *    specified. (os error 2|3)` on Windows). Canonicalization runs BEFORE the
 *    listing in `list_hq_dir`, so a missing root usually fails here first.
 *
 * A `could not resolve` with any other io error (e.g. permission denied) is
 * NOT a not-found and stays a real error. Pure string classification — callers
 * must apply it to the ROOT load only, never to subdirectory loads.
 */
export function isRootNotFoundError(err: unknown): boolean {
  const message = errorText(err);
  if (message.includes('directory not found:')) return true;
  if (!message.includes('could not resolve')) return false;
  const lower = message.toLowerCase();
  return (
    /\(os error [23]\)/.test(lower) ||
    lower.includes('no such file or directory') ||
    lower.includes('cannot find the file') ||
    lower.includes('cannot find the path')
  );
}

/** Normalize an unknown thrown value into its message text. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '');
}

/**
 * How a ROOT directory-listing failure should be presented.
 *
 * - `not-found`     the directory itself doesn't exist → calm empty state.
 * - `scope`         the native `DesktopSessionScope` read gate rejected the
 *                   read (`company scope not bound` / `cross-company read
 *                   blocked`, see crates/hq-desktop-core/src/scope_gate.rs).
 *                   After the viewed-company scope-binding fix this is a
 *                   transient race at worst — retry succeeds once the bind
 *                   lands — so it renders calm, retryable copy instead of the
 *                   scary generic failure.
 * - `unauthorized`  workspace membership does not grant this company's local
 *                   files on this machine (`company files/projects are not
 *                   authorized`) — typically an un-synced cloud company.
 * - `unknown`       anything else → the generic retryable error row.
 */
export type RootLoadErrorKind = 'not-found' | 'scope' | 'unauthorized' | 'unknown';

/** Classify a root-listing failure. Pure; root loads only (never subdirs). */
export function classifyRootLoadError(err: unknown): RootLoadErrorKind {
  if (isRootNotFoundError(err)) return 'not-found';
  const message = errorText(err);
  if (
    message.includes('company scope not bound') ||
    message.includes('cross-company read blocked')
  ) {
    return 'scope';
  }
  if (
    message.includes('company files are not authorized') ||
    message.includes('company projects are not authorized')
  ) {
    return 'unauthorized';
  }
  return 'unknown';
}

/** Calm user-facing copy for a classified non-missing root-load failure. */
export function rootLoadErrorMessage(kind: Exclude<RootLoadErrorKind, 'not-found'>): string {
  switch (kind) {
    case 'scope':
      return 'These files aren’t ready in this view yet';
    case 'unauthorized':
      return 'This company’s files aren’t available on this Mac yet — run a sync';
    default:
      return 'Files unavailable';
  }
}

/**
 * Companies whose filesystem content the current membership may expose.
 *
 * Only an active cloud membership, or a genuinely local-only/no-cloud-identity
 * workspace, grants company content. Pending/paused/unknown memberships and
 * cloud-bound workspaces whose membership could not be hydrated fail closed.
 * Personal content remains available from the HQ-root tree and is
 * intentionally not presented under "Filter by company".
 */
export function fileAccessibleCompanies(workspaces: readonly Workspace[]): Workspace[] {
  const seen = new Set<string>();
  const accessible: Workspace[] = [];
  for (const workspace of workspaces) {
    const activeCloudMembership = workspace.membershipStatus === 'active';
    const genuinelyLocalOnly =
      workspace.membershipStatus === null &&
      workspace.state === 'local-only' &&
      workspace.cloudUid === null;
    if (
      workspace.kind !== 'company' ||
      (!activeCloudMembership && !genuinelyLocalOnly)
    ) {
      continue;
    }
    if (seen.has(workspace.slug)) continue;
    seen.add(workspace.slug);
    accessible.push(workspace);
  }
  return accessible;
}

/**
 * Normalize the Files command's HQ-relative path contract.
 *
 * Files paths are generated by the Rust tree as forward-slash-separated,
 * relative paths. Reject alternate spellings rather than repairing them:
 * otherwise `companies/indigo/../pending/secret.md` is attributed to Indigo
 * before the filesystem resolves it into the pending company. Backslashes,
 * absolute paths, empty segments, NUL, and Windows drive/ADS colons are also
 * ambiguous across the supported desktop platforms and are denied.
 */
export function normalizeHqRelativePath(
  path: string | null | undefined,
): string | null {
  const value = (path ?? '').trim();
  if (!value) return '';
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '.') continue;
    if (!segment || segment === '..' || segment.includes(':')) return null;
    segments.push(segment);
  }
  return segments.join('/');
}

/** Return the company slug addressed by a valid HQ-relative path, when present. */
export function companySlugForHqPath(path: string | null | undefined): string | null {
  const normalized = normalizeHqRelativePath(path);
  if (normalized === null) return null;
  const [root, slug] = normalized.split('/');
  return root === 'companies' && slug ? slug : null;
}

function validCompanySlug(slug: string): boolean {
  const normalized = normalizeHqRelativePath(`companies/${slug}`);
  return normalized === `companies/${slug}` && companySlugForHqPath(normalized) === slug;
}

/**
 * Fail-closed route guard for Files mode.
 *
 * A company-scoped route must name an accessible company, and a selected path
 * must stay inside that same company. Root-mode paths may address any
 * non-company HQ path or an accessible company path.
 */
export function isFilesRouteAllowed(
  route: { slug?: string | null; path?: string | null },
  workspaces: readonly Workspace[],
): boolean {
  const allowedSlugs = new Set(
    fileAccessibleCompanies(workspaces).map((workspace) => workspace.slug),
  );
  const routeSlug = route.slug?.trim() || null;
  const hasPath = typeof route.path === 'string' && route.path.trim().length > 0;
  const normalizedPath = hasPath ? normalizeHqRelativePath(route.path) : '';
  if (hasPath && normalizedPath === null) return false;
  if (routeSlug && !validCompanySlug(routeSlug)) return false;
  const pathSlug = companySlugForHqPath(normalizedPath);

  if (routeSlug && !allowedSlugs.has(routeSlug)) return false;
  if (pathSlug && !allowedSlugs.has(pathSlug)) return false;
  if (routeSlug && pathSlug && routeSlug !== pathSlug) return false;
  if (routeSlug && hasPath && !pathSlug) return false;
  return true;
}

/** Remove pending or unknown company roots from a lazy directory response. */
export function filterFileEntriesForMembership(
  entries: readonly DirEntry[],
  workspaces: readonly Workspace[],
): DirEntry[] {
  const allowedSlugs = new Set(
    fileAccessibleCompanies(workspaces).map((workspace) => workspace.slug),
  );
  return entries.filter((entry) => {
    const normalizedPath = normalizeHqRelativePath(entry.path);
    if (normalizedPath === null) return false;
    const slug = companySlugForHqPath(normalizedPath);
    return slug === null || allowedSlugs.has(slug);
  });
}

/**
 * A node in the LAZY file tree (US-010). Children are loaded on demand when a
 * directory is first expanded; until then `loaded` is false and `children` is
 * undefined. `hasChildren` (from the backend peek) decides whether an expand
 * affordance renders, so empty dirs don't pretend to be expandable.
 */
export interface LazyNode {
  name: string;
  path: string;
  isDir: boolean;
  hasChildren: boolean;
  /** True once this directory's children have been fetched. */
  loaded: boolean;
  /** Loaded children (undefined until `loaded`). */
  children?: LazyNode[];
}

/** Convert a backend `DirEntry` into an unloaded {@link LazyNode}. Pure. */
export function dirEntryToLazyNode(entry: DirEntry): LazyNode {
  return {
    name: entry.name,
    path: entry.path,
    isDir: entry.isDir,
    hasChildren: entry.isDir && entry.hasChildren,
    loaded: false,
    children: undefined,
  };
}

/**
 * Compare two `DirEntry`/`LazyNode`-shaped values for display order:
 * directories before files, then case-insensitive alphabetical by name.
 * The backend already sorts, but sorting again keeps the UI independently
 * correct and robust to unsorted input. Pure comparator.
 */
function compareEntries(
  a: { name: string; isDir: boolean },
  b: { name: string; isDir: boolean },
): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/**
 * Flatten a lazy tree (a list of sibling {@link LazyNode}s) into display order
 * `{ node, depth }` rows. A directory's loaded children are emitted only when
 * `isExpanded(path)` is true AND the children are present. Sorts siblings via
 * {@link compareEntries}. Pure and side-effect-free — the UI fetches children
 * separately (on expand) and feeds the updated tree back in.
 */
export function flattenLazy(
  nodes: LazyNode[],
  isExpanded: (path: string) => boolean,
  depth = 0,
): LazyRow[] {
  const rows: LazyRow[] = [];
  for (const node of [...nodes].sort(compareEntries)) {
    rows.push({ node, depth });
    if (node.isDir && isExpanded(node.path) && node.children) {
      rows.push(...flattenLazy(node.children, isExpanded, depth + 1));
    }
  }
  return rows;
}

/** One row of the flattened lazy tree, paired with its indentation depth. */
export interface LazyRow {
  node: LazyNode;
  depth: number;
}

/**
 * Filter a lazy tree by a case-insensitive name substring.
 *
 * Keeps a directory when its own name matches OR any loaded descendant matches.
 * Unloaded directories only match on their own name (lazy boundary — no eager walk).
 * Pure: returns a new array/tree; does not mutate input.
 */
export function filterLazyNodes(nodes: LazyNode[], query: string): LazyNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  const out: LazyNode[] = [];
  for (const node of nodes) {
    if (node.isDir) {
      const selfMatch = node.name.toLowerCase().includes(q);
      const filteredChildren = node.children
        ? filterLazyNodes(node.children, query)
        : undefined;
      const childMatch = (filteredChildren?.length ?? 0) > 0;
      if (selfMatch || childMatch) {
        out.push({
          ...node,
          children: filteredChildren ?? node.children,
          // When children were filtered, reflect remaining expandable kids.
          hasChildren:
            childMatch ||
            (selfMatch && node.hasChildren && !node.loaded) ||
            (selfMatch && (filteredChildren?.some((c) => c.isDir) ?? false)),
        });
      }
    } else if (node.name.toLowerCase().includes(q)) {
      out.push(node);
    }
  }
  return out;
}

/** Parent directory of an HQ-relative path, or empty string for top-level. */
export function parentPathOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '' : path.slice(0, idx);
}

/**
 * Human-facing parent metadata for one file-tree row.
 *
 * A direct child of a scoped root has no useful relative parent. Returning
 * `null` keeps the filesystem sentinel `.` out of the UI while preserving
 * meaningful ancestry for nested rows and type labels in the unscoped HQ tree.
 */
export function fileTreeRowMeta(
  node: Pick<LazyNode, 'path' | 'isDir'>,
  rootPath: string,
): string | null {
  const parent = parentPathOf(node.path);
  if (!parent) return node.isDir ? 'Folder' : 'File';
  if (rootPath && parent === rootPath) return null;
  if (rootPath && parent.startsWith(`${rootPath}/`)) {
    return parent.slice(rootPath.length + 1) || null;
  }
  return parent;
}

/**
 * One row in the flattened display order, paired with its indentation depth.
 * `depth` is 0 for the nodes passed in at the top level and increases by one
 * per level of nesting (used by the UI to scale padding-left).
 */
export interface FlatRow {
  node: FileNode;
  depth: number;
}

/**
 * Compare two nodes for display order: directories before files, then
 * case-insensitive alphabetical by name within each group. Pure comparator.
 */
function compareNodes(a: FileNode, b: FileNode): number {
  if (a.isDir !== b.isDir) {
    // Directories (isDir true) sort before files.
    return a.isDir ? -1 : 1;
  }
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/**
 * Return a NEW array of nodes sorted for display (folders-before-files, each
 * group case-insensitive alphabetical), recursing into children so the entire
 * subtree is sorted. Does NOT mutate the input array or any input node — every
 * returned node is a fresh object with a freshly-sorted `children` array.
 */
export function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes]
    .map((node) => ({ ...node, children: sortNodes(node.children ?? []) }))
    .sort(compareNodes);
}

/**
 * Flatten a tree into display order for rendering/testing.
 *
 * Signature: `flattenTree(nodes, isExpanded, depth?)`
 * - `nodes`      the sibling nodes to flatten (e.g. a root's `children`, or a
 *                single-element array `[root]`). Sorted internally via
 *                `sortNodes`, so callers may pass unsorted input.
 * - `isExpanded` predicate keyed on the node's `path`; a directory's children
 *                are only emitted when `isExpanded(path)` returns true. Pass a
 *                `Set<string>` via `(p) => set.has(p)` for the common case.
 * - `depth`      starting depth for the passed-in nodes (default 0); recursion
 *                increments it per level.
 *
 * Returns a flat list of `{ node, depth }` in display order: each directory row
 * is followed immediately by its (recursively flattened) children when expanded.
 * Pure and side-effect-free.
 */
export function flattenTree(
  nodes: FileNode[],
  isExpanded: (path: string) => boolean,
  depth = 0,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const node of sortNodes(nodes)) {
    rows.push({ node, depth });
    if (node.isDir && isExpanded(node.path)) {
      rows.push(...flattenTree(node.children ?? [], isExpanded, depth + 1));
    }
  }
  return rows;
}
