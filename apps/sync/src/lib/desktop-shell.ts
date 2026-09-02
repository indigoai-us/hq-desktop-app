/**
 * Launch-surface decision for the HQ desktop app.
 *
 * The workspace window (`desktop-alt`, @hq/ui DesktopApp) is the only UI.
 * Email domain, company membership, and the retired `hqWorkHandoff`
 * menubar key cannot select the classic popover chat shell.
 */

export type DesktopShellKind = 'desktop-alt';

export interface LaunchShellInput {
  /** Cognito email. Empty / missing is signed-out. Domain is not a shell gate. */
  email?: string | null;
  /** Company uid if the user belongs to one. Affiliation is not a shell gate. */
  companyUid?: string | null;
  /** Retired ~/.hq/menubar.json hqWorkHandoff value. Ignored. */
  hqWorkHandoff?: boolean | null;
}

export function resolveLaunchShell(
  _input: LaunchShellInput = {},
): DesktopShellKind {
  return 'desktop-alt';
}
