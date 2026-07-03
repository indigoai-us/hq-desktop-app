export function shouldRecheckAuthOnFocus(focused: boolean, authenticated: boolean): boolean {
  return focused && !authenticated;
}
