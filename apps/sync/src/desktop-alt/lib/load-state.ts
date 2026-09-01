export type LoadPhase = 'loading' | 'error' | 'empty' | 'ready';

/** Hold skeletons this long so a fast load never flashes a placeholder. */
export const DEFAULT_SKELETON_DELAY_MS = 150;

export function loadPhase({
  loading,
  error,
  count,
}: {
  loading: boolean;
  error: string;
  count: number;
}): LoadPhase {
  if (count > 0) return 'ready';
  if (loading) return 'loading';
  if (error) return 'error';
  return 'empty';
}
