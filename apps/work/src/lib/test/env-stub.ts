/**
 * Vitest stand-in for `$env/dynamic/private` (aliased in vitest.config.ts).
 * Mirrors SvelteKit's runtime behavior: values come from process.env at
 * access time, so tests can set/unset env vars per test. Like SvelteKit, it
 * EXCLUDES publicPrefix ("PUBLIC_") vars — those only exist on
 * `$env/dynamic/public` (see env-stub-public.ts). Regression guard for the
 * US-006 prod bug where PUBLIC_APP_ORIGIN was read from the private env.
 */
export const env: Record<string, string | undefined> = new Proxy(
  {},
  {
    get: (_target, prop: string) =>
      prop.startsWith("PUBLIC_") ? undefined : process.env[prop],
  },
);
