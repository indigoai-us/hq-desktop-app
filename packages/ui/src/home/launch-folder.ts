/**
 * Launch remembers one HQ root (open question default), not a per-company
 * folder. The titlebar reads this before asking setup status, and writes it
 * when setup reports a root or the user picks Change.
 */
export const LAUNCH_HQ_ROOT_KEY = "hq.launch.hqRoot";

export function readRememberedHqRoot(
  storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage,
): string {
  try {
    return storage?.getItem(LAUNCH_HQ_ROOT_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function rememberHqRoot(
  path: string,
  storage: Pick<Storage, "setItem"> | null | undefined = globalThis.localStorage,
): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  try {
    storage?.setItem(LAUNCH_HQ_ROOT_KEY, trimmed);
  } catch {
    /* private mode / denied storage — the in-memory value still launches */
  }
}

/** Shorten an absolute home path for the menu footer. */
export function displayHqRoot(path: string, home?: string | null): string {
  const trimmed = path.trim();
  const homeTrim = home?.trim();
  if (homeTrim && (trimmed === homeTrim || trimmed.startsWith(`${homeTrim}/`))) {
    return `~${trimmed.slice(homeTrim.length)}`;
  }
  return trimmed;
}
