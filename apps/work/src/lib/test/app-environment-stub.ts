/**
 * Vitest stand-in for `$app/environment` (aliased in vitest.config.ts).
 * Tests that care about `dev` override it with `vi.mock("$app/environment")`;
 * the default mirrors a production client build, where dev-only routes must
 * render nothing.
 */
export const browser = true;
export const building = false;
export const dev = false;
export const version = "test";
