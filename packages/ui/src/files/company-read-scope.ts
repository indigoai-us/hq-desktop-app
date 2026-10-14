/**
 * Company read scope for the native file commands.
 *
 * The desktop gate (`enforce_read_scope`) rejects any read under
 * `companies/<slug>/` until the window binds that company with
 * `appShell.setActiveCompany`. Every surface that lists company files must
 * bind first, or the tree shows "Files unavailable" (QA-007, QA-011).
 */

/** Company slug for an HQ-relative path under `companies/<slug>/`, else null. */
export function companySlugForPath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] !== "companies" || !parts[1]) return null;
  return parts[1];
}

type Bind = (slug: string) => Promise<unknown>;

/**
 * Wrap a directory lister so each company path binds its company before the
 * read. Binding is remembered per slug; a failed bind is retried next call.
 */
export function withCompanyReadScope<T>(
  bind: Bind | null | undefined,
  list: (relPath: string) => Promise<T>,
): (relPath: string) => Promise<T> {
  let boundSlug: string | null = null;
  let pending: Promise<void> | null = null;
  return async (relPath: string) => {
    const slug = companySlugForPath(relPath);
    if (bind && slug && slug !== boundSlug) {
      if (!pending) {
        pending = Promise.resolve(bind(slug))
          .then((result) => {
            const rec = result as { ok?: boolean; message?: string } | undefined;
            if (rec && rec.ok === false) throw new Error(rec.message ?? "could not open company files");
            boundSlug = slug;
          })
          .finally(() => {
            pending = null;
          });
      }
      await pending;
    }
    return list(relPath);
  };
}

/** Plain-language reason for a failed folder read. Never the raw error. */
export function fileTreeErrorReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/signed-in user|AUTH_REQUIRED/i.test(text)) return "Sign in to HQ to see these files.";
  if (/scope not bound|cross-company/i.test(text)) return "This company's files could not be opened in this window.";
  if (/not authorized|\b403\b|forbidden/i.test(text)) return "You don't have access to this company's files.";
  if (/not found|no such file|does not exist/i.test(text)) return "This folder isn't on this computer yet. Sync the company, then retry.";
  return "Could not read this folder.";
}
