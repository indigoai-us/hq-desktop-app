export type LifecycleState =
  | 'NeedsInstall'
  | 'InstallResume'
  | 'NeedsAuthForInstall'
  | 'InstalledFirstRun'
  | 'InstalledLegacyUpdate'
  | 'SteadyState';

export function isOnboardingState(
  state: LifecycleState | string | null | undefined,
): boolean {
  return (
    state === 'NeedsInstall' ||
    state === 'InstallResume' ||
    state === 'NeedsAuthForInstall' ||
    state === 'InstalledFirstRun'
  );
}
