import { isOnboardingState } from './lifecycle';

export interface StartupSetupEvidence {
  installCompleted: boolean;
  firstRunCompleted: boolean;
  installInProgress: boolean;
  hadMachineId: boolean;
  hqRootValid: boolean;
}

function hasPriorSetup(evidence: StartupSetupEvidence): boolean {
  return (
    evidence.installCompleted ||
    evidence.firstRunCompleted ||
    (!evidence.installInProgress && evidence.hadMachineId && evidence.hqRootValid)
  );
}

/**
 * Returns "sign-in" or "onboarding" when the machine landed on an unexpected
 * surface after startup, or null when the surface is normal (signed-in).
 *
 * Used to decide whether to call `report_unexpected_startup_surface`.
 */
export function unexpectedSurfaceForState(
  lifecycleState: string | null,
  authenticated: boolean,
  setupEvidence?: StartupSetupEvidence | null,
): 'sign-in' | 'onboarding' | null {
  if (isOnboardingState(lifecycleState)) {
    // Suppress expected onboarding only for fresh or incomplete installs.
    // InstalledFirstRun remains reportable even if older marker fields are absent.
    const freshInstallState =
      lifecycleState === 'NeedsInstall' ||
      lifecycleState === 'NeedsAuthForInstall' ||
      lifecycleState === 'InstallResume';
    if (freshInstallState && setupEvidence != null && !hasPriorSetup(setupEvidence)) return null;
    return 'onboarding';
  }
  if (!authenticated) return 'sign-in';
  return null;
}
