/** Confirm before ending the local session. Returns true when the user proceeds. */
export function confirmSignOut(): boolean {
  const confirmFn =
    typeof globalThis.confirm === "function" ? globalThis.confirm : null;
  if (!confirmFn) return true;
  return confirmFn("Sign out of HQ Work on this machine?");
}
