/**
 * Which desktop lifecycle a native auth status lands on, before the identity
 * probe runs. `credentials_read_error` means the token store could not be read
 * (a lock held by the sync runner or CLI, a file mid-replace). It is not
 * evidence that the store is empty, so it must not render "You are signed out"
 * with no automatic retry. It goes to `recovery`, which re-checks on focus and
 * when the connection returns, and keeps the saved session.
 */
export type NativeAuthStatus =
  | 'active'
  | 'credentials_absent'
  | 'credentials_read_error'
  | 'credentials_invalid'
  | 'refresh_temporarily_unavailable'
  | 'non_human_principal';

export type AuthLifecycleVerdict =
  | { lifecycle: 'signed-out'; reason: 'signed-out' | 'invalid' | 'non-human' }
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
    case 'credentials_read_error':
    case 'refresh_temporarily_unavailable':
      return { lifecycle: 'recovery' };
    case 'active':
      return { lifecycle: 'hydrate' };
  }
}
