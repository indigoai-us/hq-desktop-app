/**
 * Session drafts for create forms (QA-088). A create form that closes without
 * submitting keeps its fields here for the life of the app session, and the
 * next open restores them with a "Draft restored · Clear" affordance. Nothing
 * is written to disk, so a restart starts clean.
 */

const drafts = new Map<string, unknown>();

export function saveFormDraft<T>(key: string, value: T): void {
  drafts.set(key, structuredClone(value));
}

export function readFormDraft<T>(key: string): T | null {
  return drafts.has(key) ? structuredClone(drafts.get(key) as T) : null;
}

export function clearFormDraft(key: string): void {
  drafts.delete(key);
}

/** Test hook: forget every draft. */
export function resetFormDrafts(): void {
  drafts.clear();
}
