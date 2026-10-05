const RETURN_NUDGE_STORAGE_PREFIX = "hq:desktop:first-week-return-nudge:v1:";

export interface ReturnNudgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function eligibleReturnNudgeDay(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row.eligible === true && row.reason === "eligible" &&
    Number.isInteger(row.dayIndex) && Number(row.dayIndex) >= 1 && Number(row.dayIndex) <= 6
    ? Number(row.dayIndex)
    : null;
}

/** Persist before rendering so reopening the popover cannot show a second line that day. */
export function markReturnNudgeShown(
  storage: ReturnNudgeStorage,
  companyUid: string,
  todayUtcDate: string,
): boolean {
  const key = `${RETURN_NUDGE_STORAGE_PREFIX}${companyUid}`;
  try {
    if (storage.getItem(key) === todayUtcDate) return false;
    storage.setItem(key, todayUtcDate);
    return true;
  } catch {
    return false;
  }
}
