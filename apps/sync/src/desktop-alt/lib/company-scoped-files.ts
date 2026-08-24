/** Direct company subtrees supported by the shared read-only file browser. */
export type CompanyScopedDirectory = 'knowledge' | 'clients';

/** Build the HQ-relative root for a company-scoped browser. */
export function companyScopedRoot(
  slug: string,
  directory: CompanyScopedDirectory,
): string {
  return `companies/${slug}/${directory}`;
}

/** Defense-in-depth guard for renderer-selected and backend-returned paths. */
export function inCompanyScopedRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

/**
 * The native directory command has a stable missing-directory error. Only the
 * browser root is converted to a calm empty state; nested failures stay
 * visible and retryable in CompanyFileTree.
 */
export function isMissingScopedRootError(error: unknown, rootPath: string): boolean {
  return String(error).endsWith(`directory not found: "${rootPath}"`);
}
