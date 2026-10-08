/**
 * App-wide company icon lookup for `CompanyLabel`.
 *
 * The desktop shell owns the membership roster and publishes its uid/slug to
 * icon map here once, so any surface that renders a company name can show the
 * favicon by uid without threading an icon prop through every parent.
 */
let icons = $state<ReadonlyMap<string, string>>(new Map());

/**
 * Replace the registry with the current roster icon map. Keys are company
 * uids and slugs, plus display names for surfaces that only know the name.
 */
export function setCompanyIconRegistry(next: ReadonlyMap<string, string>): void {
  icons = next;
}

/** Presigned icon for a company uid, slug, or display name, or null when none is known. */
export function companyIconFor(uidOrSlug: string | null | undefined): string | null {
  const key = uidOrSlug?.trim();
  if (!key) return null;
  return icons.get(key) ?? null;
}
