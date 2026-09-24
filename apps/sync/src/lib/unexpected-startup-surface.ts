import { isOnboardingState } from './lifecycle';

/**
 * Returns "sign-in" or "onboarding" when the machine landed on an unexpected
 * surface after startup, or null when the surface is normal (signed-in).
 *
 * Used to decide whether to call `report_unexpected_startup_surface`.
 */
export function unexpectedSurfaceForState(
  lifecycleState: string | null,
  authenticated: boolean,
): 'sign-in' | 'onboarding' | null {
  if (isOnboardingState(lifecycleState)) return 'onboarding';
  if (!authenticated) return 'sign-in';
  return null;
}
