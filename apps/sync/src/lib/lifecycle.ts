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
    state === 'NeedsAuthForInstall'
  );
}

export function onboardingHeadline(
  state: LifecycleState | string | null | undefined,
): string {
  switch (state) {
    case 'InstallResume':
      return 'Resume setup';
    case 'NeedsAuthForInstall':
      return 'Sign in to finish setup';
    case 'NeedsInstall':
    default:
      return "Welcome to HQ - let's get you set up";
  }
}
