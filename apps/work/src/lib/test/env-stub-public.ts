/**
 * Vitest stand-in for `$env/dynamic/public` (aliased in vitest.config.ts).
 * Mirrors SvelteKit: only publicPrefix ("PUBLIC_") vars are visible.
 */
export const env: Record<string, string | undefined> = new Proxy(
  {},
  {
    get: (_target, prop: string) =>
      prop.startsWith("PUBLIC_") ? process.env[prop] : undefined,
  },
);
