export function shouldShowMeetingsLoadingPlaceholder(
  loading: boolean,
  primaryLoaded: boolean,
  eventsCount: number,
  recordedBotsCount: number,
): boolean {
  return (
    loading &&
    !primaryLoaded &&
    eventsCount === 0 &&
    recordedBotsCount === 0
  );
}
