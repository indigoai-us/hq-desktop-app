/** Keep throwaway shelltest releases separate from user-facing telemetry. */
export function sentryEnvironmentForVersion(version: string): 'shelltest' | 'production' {
  return /^0\.0\.0-shelltest\.[1-9][0-9]*$/.test(version) ? 'shelltest' : 'production';
}
