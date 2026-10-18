/**
 * Which desktop lifecycle a native auth status lands on, before the identity
 * probe runs. `credentials_read_error` means the token store could not be read
 * (a lock held by the sync runner or CLI, a file mid-replace). It is not
 * evidence that the store is empty, so it must not render "You are signed out"
 * with no automatic retry. It goes to `recovery`, which re-checks on focus and
 * when the connection returns, and keeps the saved session.
 *
 * `machine_unavailable` means there is no person session and the device's
 * outpost identity could not mint one (the `hq` CLI failed, its machine
 * credentials were revoked, or HQ was unreachable). The failure can be
 * persistent, so it lands on the sign-in screen, where the person can retry
 * the outpost or sign in with a provider. The recovery screen only retries.
 */
export type NativeAuthStatus =
  | 'active'
  | 'credentials_absent'
  | 'credentials_read_error'
  | 'credentials_invalid'
  | 'refresh_temporarily_unavailable'
  | 'non_human_principal'
  | 'machine_unavailable';

export type AuthLifecycleVerdict =
  | {
      lifecycle: 'signed-out';
      reason: 'signed-out' | 'invalid' | 'non-human' | 'machine-unavailable';
    }
  | { lifecycle: 'recovery' }
  | { lifecycle: 'hydrate' };

export function lifecycleForAuthStatus(status: NativeAuthStatus): AuthLifecycleVerdict {
  switch (status) {
    case 'credentials_absent':
      return { lifecycle: 'signed-out', reason: 'signed-out' };
    case 'credentials_invalid':
      return { lifecycle: 'signed-out', reason: 'invalid' };
    case 'non_human_principal':
      return { lifecycle: 'signed-out', reason: 'non-human' };
    case 'machine_unavailable':
      return { lifecycle: 'signed-out', reason: 'machine-unavailable' };
    case 'credentials_read_error':
    case 'refresh_temporarily_unavailable':
      return { lifecycle: 'recovery' };
    case 'active':
      return { lifecycle: 'hydrate' };
  }
}
